// test/commands/reconcile.test.mjs — value-asserting tests for reconcile command.
// Fixtures use exact query-string keys (strict helper throws on unmocked requests).
// reconcile fetches:
//   GET /payments/transactions?altId=L-TEST&altType=location&limit=100&offset=0   (page 1)
//   GET /payments/subscriptions?altId=L-TEST&altType=location&limit=100&offset=0  (page 1)
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { run } from '../../commands/reconcile.mjs';
import { makeFakeCtx } from '../_helpers.mjs';

const GOLDEN_PATH = new URL('../golden/reconcile.json', import.meta.url);

const TXN_KEY  = 'GET /payments/transactions?altId=L-TEST&altType=location&limit=100&offset=0';
const SUBS_KEY = 'GET /payments/subscriptions?altId=L-TEST&altType=location&limit=100&offset=0';

test('reconcile: run returns 0 and envelope has expected keys + value assertions', async () => {
  const NOW = 1_700_000_000_000;
  const fixture = {
    [TXN_KEY]: {
      status: 200,
      j: {
        data: [
          { id: 't1', status: 'succeeded', amount: 5000, currency: 'PHP',
            createdAt: new Date(NOW - 5 * 86400000).toISOString(),
            paymentProviderType: 'stripe', entityId: 'inv1' },
          { id: 't2', status: 'failed', amount: 2000, currency: 'PHP',
            createdAt: new Date(NOW - 3 * 86400000).toISOString(),
            paymentProviderType: 'stripe' },
        ],
      },
    },
    [SUBS_KEY]: {
      status: 200,
      j: { data: [{ id: 's1', status: 'active', amount: 3000, currency: 'PHP' }] },
    },
  };
  const { ctx, getPrinted } = makeFakeCtx({ fixture, now: NOW });
  const code = await run({ days: 30, top: 20 }, ctx);
  ctx.out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.schemaVersion, 1);
  assert.ok(envelope.data);
  for (const k of ['location', 'days', 'scanned', 'inWindow', 'collected', 'currency', 'bySource', 'byStatus', 'flags', 'subscriptions']) {
    assert.ok(k in envelope.data, `missing key: ${k}`);
  }
  // value assertions
  assert.equal(envelope.data.collected, 5000, 'collected must be 5000 (succeeded only)');
  assert.equal(envelope.data.scanned, 2, 'scanned must be 2');
  assert.equal(envelope.data.inWindow, 2, 'both txns in window');
  assert.equal(envelope.data.flags.failed, 1, 'exactly 1 failed txn');
  assert.equal(envelope.data.subscriptions.active, 1, 'exactly 1 active subscription');
  assert.equal(envelope.data.subscriptions.mrr, 3000, 'MRR must be 3000');
  // bySource: stripe with 1 succeeded txn totaling 5000
  assert.ok(envelope.data.bySource.stripe, 'bySource must have stripe');
  assert.equal(envelope.data.bySource.stripe.c, 1, 'stripe txn count must be 1');
  assert.equal(envelope.data.bySource.stripe.v, 5000, 'stripe value must be 5000');
});

// I2: subscriptions with PHP+USD → MRR not cross-summed, mrrByCurrency map emitted
test('reconcile: multi-currency subscriptions emit mrrByCurrency map, not a cross-sum', async () => {
  const NOW = 1_700_000_000_000;
  const fixture = {
    [TXN_KEY]:  { status: 200, j: { data: [] } },
    [SUBS_KEY]: {
      status: 200,
      j: {
        data: [
          { id: 's1', status: 'active', amount: 3000, currency: 'PHP' },
          { id: 's2', status: 'active', amount: 50, currency: 'USD' },
          { id: 's3', status: 'trialing', amount: 1500, currency: 'PHP' },
        ],
      },
    },
  };
  const { ctx, getPrinted } = makeFakeCtx({ fixture, now: NOW });
  const code = await run({ days: 30, top: 20 }, ctx);
  ctx.out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(getPrinted());
  const sub = envelope.data.subscriptions;
  assert.ok(sub, 'subscriptions must be present');
  // Must NOT be a flat cross-sum mrr when multi-currency
  assert.ok(!('mrr' in sub), 'multi-currency MRR must not emit flat mrr scalar');
  // Must have mrrByCurrency map
  assert.ok(sub.mrrByCurrency, 'must have mrrByCurrency map');
  assert.equal(sub.mrrByCurrency.PHP, 4500, 'PHP MRR must be 3000+1500=4500');
  assert.equal(sub.mrrByCurrency.USD, 50, 'USD MRR must be 50');
});

// I2: single-currency subscriptions keep flat mrr (backward compat)
test('reconcile: single-currency subscriptions keep flat mrr (backward compat)', async () => {
  const NOW = 1_700_000_000_000;
  const fixture = {
    [TXN_KEY]:  { status: 200, j: { data: [] } },
    [SUBS_KEY]: {
      status: 200,
      j: {
        data: [
          { id: 's1', status: 'active', amount: 5000, currency: 'PHP' },
          { id: 's2', status: 'active', amount: 2000 }, // no currency → defaults to PHP
        ],
      },
    },
  };
  const { ctx, getPrinted } = makeFakeCtx({ fixture, now: NOW });
  const code = await run({ days: 30, top: 20 }, ctx);
  ctx.out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(getPrinted());
  const sub = envelope.data.subscriptions;
  assert.ok(sub, 'subscriptions must be present');
  assert.ok('mrr' in sub, 'single-currency must keep flat mrr for backward compat');
  assert.ok(!sub.mrrByCurrency, 'single-currency must not emit mrrByCurrency');
  assert.equal(sub.mrr, 7000, 'flat mrr must be 5000+2000=7000');
});

test('reconcile: golden data keys present', () => {
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
  const data = golden.data ?? golden;
  for (const k of ['location', 'days', 'scanned', 'inWindow', 'collected', 'currency', 'bySource', 'byStatus', 'flags']) {
    assert.ok(k in data, `golden must have key: ${k}`);
  }
});

test('reconcile: multi-currency emits byCurrency map, not a cross-sum scalar', async () => {
  // Trust-fix #3 proof: PHP + USD transactions must NOT be summed into one `collected` number.
  const NOW = 1_700_000_000_000;
  const fixture = {
    [TXN_KEY]: {
      status: 200,
      j: {
        data: [
          { id: 't1', status: 'succeeded', amount: 5000, currency: 'PHP',
            createdAt: new Date(NOW - 2 * 86400000).toISOString(),
            paymentProviderType: 'stripe', entityId: 'inv1' },
          { id: 't2', status: 'succeeded', amount: 200, currency: 'USD',
            createdAt: new Date(NOW - 1 * 86400000).toISOString(),
            paymentProviderType: 'paypal', entityId: 'inv2' },
          { id: 't3', status: 'failed', amount: 1000, currency: 'PHP',
            createdAt: new Date(NOW - 3 * 86400000).toISOString(),
            paymentProviderType: 'stripe' },
        ],
      },
    },
    [SUBS_KEY]: { status: 200, j: { data: [] } },
  };
  const { ctx, getPrinted } = makeFakeCtx({ fixture, now: NOW });
  const code = await run({ days: 30, top: 20 }, ctx);
  ctx.out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(getPrinted());
  const data = envelope.data;

  // must NOT have a flat cross-sum `collected` when multi-currency
  assert.ok(!('collected' in data), 'multi-currency must not emit flat collected scalar');
  assert.ok(!('currency' in data), 'multi-currency must not emit flat currency field');

  // must have a byCurrency map with per-currency totals
  assert.ok(data.byCurrency, 'multi-currency must emit byCurrency map');
  assert.equal(data.byCurrency.PHP, 5000, 'PHP total must be 5000, not cross-summed with USD');
  assert.equal(data.byCurrency.USD, 200, 'USD total must be 200');

  // bySource keys must be currency-namespaced to avoid mixing
  const srcKeys = Object.keys(data.bySource);
  assert.ok(srcKeys.some(k => k.includes('PHP')), 'bySource keys must include currency tag for PHP');
  assert.ok(srcKeys.some(k => k.includes('USD')), 'bySource keys must include currency tag for USD');

  // flags still present
  assert.equal(data.flags.failed, 1);
});

// ── FIX 4: numeric-second epoch normalization in inWin ────────────────────────

test('FIX4: reconcile inWin counts numeric-second epoch timestamps within window', async () => {
  const NOW = 1_700_000_000_000; // ms
  // Numeric-second epoch for "5 days ago" — should be in a 30-day window
  const fiveDaysAgoSec = Math.floor((NOW - 5 * 86400000) / 1000); // seconds, < 1e12
  assert.ok(fiveDaysAgoSec < 1e12, 'sanity: seconds epoch must be < 1e12');
  const fixture = {
    [TXN_KEY]: {
      status: 200,
      j: {
        data: [
          // numeric-second epoch: should be normalized to ms and counted in-window
          { id: 't-sec', status: 'succeeded', amount: 9999, currency: 'PHP',
            createdAt: fiveDaysAgoSec,   // numeric seconds — the bug case
            paymentProviderType: 'stripe', entityId: 'inv-sec' },
        ],
      },
    },
    [SUBS_KEY]: { status: 200, j: { data: [] } },
  };
  const { ctx, getPrinted } = makeFakeCtx({ fixture, now: NOW });
  const code = await run({ days: 30, top: 20 }, ctx);
  ctx.out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(getPrinted());
  // Without normalization: fiveDaysAgoSec (~1.695e9) < START (~1.697e9 ms) → excluded (bug)
  // With normalization: fiveDaysAgoSec * 1000 → in-window → counted
  assert.equal(envelope.data.inWindow, 1, 'numeric-second epoch txn must be counted in window');
  assert.equal(envelope.data.collected, 9999, 'numeric-second epoch txn must be counted in collected');
});

// M-4: m(Infinity) in reconcile TTY render must not produce ₱Infinity / $Infinity etc.
test('reconcile: Infinity transaction amount formats as — not ₱Infinity', async () => {
  const NOW = 1_700_000_000_000;
  const fixture = {
    [TXN_KEY]: {
      status: 200,
      j: {
        data: [
          { id: 't1', status: 'succeeded', amount: Infinity, currency: 'PHP',
            createdAt: new Date(NOW - 1 * 86400000).toISOString(),
            paymentProviderType: 'stripe', entityId: 'inv1' },
        ],
      },
    },
    [SUBS_KEY]: { status: 200, j: { data: [] } },
  };
  const { makeOut } = await import('../../lib/output.mjs');
  let printed = '';
  const out = makeOut({ json: false, tty: false, command: 'test', location: 'L-TEST', write: s => printed += s, writeErr: () => {} });
  const ctx = { http: { get: async (path, { query } = {}) => {
    const qs = '?' + new URLSearchParams(Object.fromEntries(Object.entries(query || {}).filter(([,v])=>v!=null).map(([k,v])=>[k,String(v)]))).toString();
    const key = `GET ${path}${qs}`;
    const hit = fixture[key];
    if (!hit) throw new Error('unmocked: ' + key);
    return { code: hit.status, ok: hit.status < 300, j: hit.j, txt: '{}' };
  }}, cfg: { loc: 'L-TEST', tz: 'Asia/Manila', currency: null }, out, now: NOW };
  const code = await (await import('../../commands/reconcile.mjs')).run({ days: 30, top: 20 }, ctx);
  out.flush();
  assert.equal(code, 0);
  assert.ok(!printed.includes('Infinity'), 'Infinity must not appear in TTY output — must be formatted as —');
});

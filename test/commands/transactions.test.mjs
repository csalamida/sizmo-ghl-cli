// test/commands/transactions.test.mjs
// transactions had zero test coverage despite being the money-reporting surface. Read-only, but
// the output is numbers a user makes decisions on, so the amount/currency formatting matters as
// much as the exit codes: showing "USD 50.00" for a PHP 50 charge is a real-world wrong answer.
//
// Covers: happy path, empty, 401/403/500, non-array payload, the altId/altType query shape (this
// endpoint does NOT take locationId), --type filter, --top default/clamp/garbage, the total
// fallback chain, and formatAmount's currency-honesty behavior (never transforms, never assumes).
import { test } from 'node:test';
import assert from 'node:assert';
import { run } from '../../commands/transactions.mjs';
import { makeFakeCtx } from '../_helpers.mjs';
import { EXIT } from '../../lib/errors.mjs';

const LOC = 'L-TEST';
const txUrl = (limit = 25, extra = '') =>
  `GET /payments/transactions?altId=${LOC}&altType=location&limit=${limit}${extra}`;

const TX = [
  { contactName: 'Ana Cruz', amount: 1500, currency: 'PHP', status: 'succeeded', entityType: 'order', createdAt: '2026-07-01T10:00:00Z' },
  { contactName: 'Bea Lim', amount: 99.5, currency: 'USD', status: 'refunded', entityType: 'subscription', createdAt: '2026-07-02T10:00:00Z' },
];

// ── happy path + shape ────────────────────────────────────────────────────────

test('transactions: happy path → EXIT.OK + envelope', async () => {
  const { ctx, getPrinted } = makeFakeCtx({
    fixture: { [txUrl()]: { status: 200, j: { transactions: TX, total: 2 } } },
  });
  const code = await run({ _: [] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.data.transactions.length, 2);
  assert.equal(envelope.data.total, 2);
  assert.equal(envelope.data.top, 25);
});

test('transactions: uses altId/altType, NOT locationId (payments API differs)', async () => {
  // The payments API is the one GHL endpoint family that rejects locationId. Regressing this
  // would 4xx against the real API while every unit test still passed, so assert the URL directly.
  const { ctx, getCalledPaths } = makeFakeCtx({
    fixture: { [txUrl()]: { status: 200, j: { transactions: [] } } },
  });
  await run({ _: [] }, ctx);
  ctx.out.flush();
  const url = getCalledPaths()[0];
  assert.ok(url.includes(`altId=${LOC}`), 'must send altId');
  assert.ok(url.includes('altType=location'), 'must send altType=location');
  assert.ok(!url.includes('locationId'), 'must NOT send locationId to the payments API');
});

test('transactions: empty list → EXIT.OK, early-return branch', async () => {
  const { ctx, getPrinted } = makeFakeCtx({
    fixture: { [txUrl()]: { status: 200, j: { transactions: [] } } },
  });
  const code = await run({ _: [] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(JSON.parse(getPrinted()).data.transactions.length, 0);
});

test('transactions: reads `data` key when `transactions` absent', async () => {
  const { ctx, getPrinted } = makeFakeCtx({
    fixture: { [txUrl()]: { status: 200, j: { data: [TX[0]] } } },
  });
  const code = await run({ _: [] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(JSON.parse(getPrinted()).data.transactions.length, 1);
});

test('transactions: non-array payload → EXIT.OK, degrades to empty (never throws)', async () => {
  const { ctx, getPrinted } = makeFakeCtx({
    fixture: { [txUrl()]: { status: 200, j: { transactions: { nope: 'object' } } } },
  });
  const code = await run({ _: [] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(JSON.parse(getPrinted()).data.transactions.length, 0);
});

test('transactions: total falls back to array length when API omits it', async () => {
  const { ctx, getPrinted } = makeFakeCtx({
    fixture: { [txUrl()]: { status: 200, j: { transactions: TX } } },
  });
  await run({ _: [] }, ctx);
  ctx.out.flush();
  assert.equal(JSON.parse(getPrinted()).data.total, 2);
});

test('transactions: total reads `count` when present instead of length', async () => {
  // count reflects the FULL result set server-side, not the page — reporting length would
  // understate the real total whenever the page is capped.
  const { ctx, getPrinted } = makeFakeCtx({
    fixture: { [txUrl()]: { status: 200, j: { transactions: TX, count: 87 } } },
  });
  await run({ _: [] }, ctx);
  ctx.out.flush();
  assert.equal(JSON.parse(getPrinted()).data.total, 87);
});

// ── error branches ────────────────────────────────────────────────────────────

test('transactions: 401 → EXIT.AUTH', async () => {
  const { ctx } = makeFakeCtx({ fixture: { [txUrl()]: { status: 401, j: {} } } });
  await assert.rejects(() => run({ _: [] }, ctx), (e) => e.code === EXIT.AUTH);
});

test('transactions: 403 → EXIT.AUTH', async () => {
  const { ctx } = makeFakeCtx({ fixture: { [txUrl()]: { status: 403, j: {} } } });
  await assert.rejects(() => run({ _: [] }, ctx), (e) => e.code === EXIT.AUTH);
});

test('transactions: 500 → EXIT.API', async () => {
  const { ctx } = makeFakeCtx({ fixture: { [txUrl()]: { status: 500, j: { message: 'boom' } } } });
  await assert.rejects(() => run({ _: [] }, ctx), (e) => e.code === EXIT.API);
});

// ── flags ─────────────────────────────────────────────────────────────────────

test('transactions --type: adds entityType to the query', async () => {
  const { ctx, getCalledPaths } = makeFakeCtx({
    fixture: { [txUrl(25, '&entityType=order')]: { status: 200, j: { transactions: [] } } },
  });
  const code = await run({ _: [], type: 'order' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.ok(getCalledPaths()[0].includes('entityType=order'));
});

test('transactions --type: whitespace-only is treated as absent', async () => {
  const { ctx, getCalledPaths } = makeFakeCtx({
    fixture: { [txUrl()]: { status: 200, j: { transactions: [] } } },
  });
  const code = await run({ _: [], type: '   ' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.ok(!getCalledPaths()[0].includes('entityType'), 'blank filter must not be sent');
});

test('transactions --top: clamped to MAX_TOP 100', async () => {
  const { ctx, getCalledPaths } = makeFakeCtx({
    fixture: { [txUrl(100)]: { status: 200, j: { transactions: [] } } },
  });
  const code = await run({ _: [], top: 5000 }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.ok(getCalledPaths()[0].includes('limit=100'));
});

test('transactions --top: non-numeric falls back to default 25', async () => {
  const { ctx, getCalledPaths } = makeFakeCtx({
    fixture: { [txUrl(25)]: { status: 200, j: { transactions: [] } } },
  });
  const code = await run({ _: [], top: 'abc' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.ok(getCalledPaths()[0].includes('limit=25'));
});

// ── amount/currency honesty (human-readable output path) ──────────────────────

test('transactions: renders each row in ITS OWN currency, never a single assumed one', async () => {
  // The currency-honesty rule: a PHP row and a USD row in the same table must each carry their
  // own code. Hardcoding one symbol across the table is the exact bug this pins against.
  const { ctx, getPrinted } = makeFakeCtx({
    json: false,
    fixture: { [txUrl()]: { status: 200, j: { transactions: TX, total: 2 } } },
  });
  const code = await run({ _: [] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  const printed = getPrinted();
  assert.ok(printed.includes('PHP 1500.00'), 'PHP row must show PHP');
  assert.ok(printed.includes('USD 99.50'), 'USD row must show USD');
});

test('transactions: missing amount renders as em dash, not 0.00', async () => {
  // Showing 0.00 for "we don't know" is a fabricated number — must stay visibly absent.
  const { ctx, getPrinted } = makeFakeCtx({
    json: false,
    fixture: {
      [txUrl()]: { status: 200, j: { transactions: [{ contactName: 'No Amount', currency: 'USD', status: 'pending' }] } },
    },
  });
  await run({ _: [] }, ctx);
  ctx.out.flush();
  assert.ok(!getPrinted().includes('0.00'), 'absent amount must not render as 0.00');
});

test('transactions: falls back to amountDue when amount is absent', async () => {
  const { ctx, getPrinted } = makeFakeCtx({
    json: false,
    fixture: {
      [txUrl()]: { status: 200, j: { transactions: [{ contactName: 'Due', amountDue: 250, currency: 'PHP' }] } },
    },
  });
  await run({ _: [] }, ctx);
  ctx.out.flush();
  assert.ok(getPrinted().includes('PHP 250.00'));
});

test('transactions: currency defaults to USD only when the API omits it', async () => {
  const { ctx, getPrinted } = makeFakeCtx({
    json: false,
    fixture: {
      [txUrl()]: { status: 200, j: { transactions: [{ contactName: 'NoCur', amount: 10 }] } },
    },
  });
  await run({ _: [] }, ctx);
  ctx.out.flush();
  assert.ok(getPrinted().includes('USD 10.00'));
});

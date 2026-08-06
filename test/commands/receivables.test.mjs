// test/commands/receivables.test.mjs — value-asserting tests for receivables command.
// Fixtures use exact query-string keys (strict helper throws on unmocked requests).
// receivables fetches:
//   GET /invoices/?altId=L-TEST&altType=location&limit=100&offset=0   (page 1)
//   GET /invoices/?altId=L-TEST&altType=location&limit=100&offset=100 (page 2, if needed)
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { run } from '../../commands/receivables.mjs';
import { makeFakeCtx } from '../_helpers.mjs';

const GOLDEN_PATH = new URL('../golden/receivables.json', import.meta.url);

test('receivables: run returns 0 and envelope has expected keys + value assertions', async () => {
  const NOW = 1_700_000_000_000;
  const fixture = {
    'GET /invoices/?altId=L-TEST&altType=location&limit=100&offset=0': {
      status: 200,
      j: {
        invoices: [
          { _id: 'inv1', invoiceNumber: 'INV-001', status: 'sent', currency: 'PHP',
            total: 10000, amountPaid: 0,
            contactDetails: { name: 'Client A' },
            dueDate: new Date(NOW - 20 * 86400000).toISOString() },
          { _id: 'inv2', invoiceNumber: 'INV-002', status: 'paid', currency: 'PHP',
            total: 5000, amountPaid: 5000,
            contactDetails: { name: 'Client B' },
            dueDate: new Date(NOW - 5 * 86400000).toISOString() },
          { _id: 'inv3', invoiceNumber: 'INV-003', status: 'overdue', currency: 'PHP',
            total: 8000, amountPaid: 2000,
            contactDetails: { name: 'Client C' },
            dueDate: new Date(NOW - 35 * 86400000).toISOString() },
        ],
      },
    },
  };
  const { ctx, getPrinted } = makeFakeCtx({ fixture, now: NOW });
  const code = await run({ top: 20 }, ctx);
  ctx.out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.schemaVersion, 1);
  assert.ok(envelope.data);
  for (const k of ['location', 'scanned', 'outstanding', 'totalOwed', 'currency', 'list']) {
    assert.ok(k in envelope.data, `missing key: ${k}`);
  }
  // value assertions
  assert.equal(envelope.data.scanned, 3, 'scanned must be 3');
  // inv1 (sent, due=10000) + inv3 (overdue, due=8000-2000=6000) = outstanding=2, totalOwed=16000
  assert.equal(envelope.data.outstanding, 2, 'only sent + overdue invoices are outstanding');
  assert.equal(envelope.data.totalOwed, 16000, 'totalOwed must be 10000+6000=16000');
  assert.equal(envelope.data.currency, 'PHP');
  // list sorted by age (oldest first): inv3 (35d) before inv1 (20d)
  assert.equal(envelope.data.list.length, 2);
  assert.equal(envelope.data.list[0].age, 35, 'oldest invoice first');
});

// Aging: invoices beyond --top are not shown but outstanding count is full
test('receivables: --top limits list rows but outstanding count is full', async () => {
  const NOW = 1_700_000_000_000;
  const invoices = Array.from({ length: 5 }, (_, i) => ({
    _id: `inv${i}`, invoiceNumber: `INV-00${i}`, status: 'sent', currency: 'PHP',
    total: 1000, amountPaid: 0, contactDetails: { name: `Client ${i}` },
    dueDate: new Date(NOW - (i + 1) * 86400000).toISOString(),
  }));
  const fixture = {
    'GET /invoices/?altId=L-TEST&altType=location&limit=100&offset=0': {
      status: 200,
      j: { invoices },
    },
  };
  const { ctx, getPrinted } = makeFakeCtx({ fixture, now: NOW });
  const code = await run({ top: 2 }, ctx);
  ctx.out.flush();
  assert.equal(code, 0);
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.data.outstanding, 5, 'outstanding is full count, not capped by --top');
  assert.equal(envelope.data.list.length, 2, '--top 2 caps the list to 2 rows');
  assert.equal(envelope.data.totalOwed, 5000, 'totalOwed includes all 5 invoices');
});

test('receivables: human output prints a ready-to-run per-row action when contactId is known', async () => {
  const NOW = 1_700_000_000_000;
  const fixture = {
    'GET /invoices/?altId=L-TEST&altType=location&limit=100&offset=0': {
      status: 200,
      j: { invoices: [
        { _id: 'inv1', invoiceNumber: 'INV-001', status: 'sent', currency: 'PHP',
          total: 9000, amountPaid: 0, contactDetails: { name: 'Acme Co', id: 'cid-acme' },
          dueDate: new Date(NOW - 30 * 86400000).toISOString() },
      ] },
    },
  };
  // json:false → human card renders into getPrinted()
  const { ctx, getPrinted } = makeFakeCtx({ fixture, now: NOW, json: false });
  await run({ top: 20 }, ctx);
  ctx.out.flush();
  const out = getPrinted();
  assert.match(out, /→ sizmo send cid-acme --channel email --message/, 'per-row send command with the real contactId');
  assert.match(out, /sizmo open cid-acme/, 'per-row open command too');
});

test('receivables: golden data keys present', () => {
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
  const data = golden.data ?? golden;
  for (const k of ['location', 'scanned', 'outstanding', 'totalOwed', 'currency', 'list']) {
    assert.ok(k in data, `golden must have key: ${k}`);
  }
});

// ── blocked ≠ zero ────────────────────────────────────────────────────────────
// README promises this twice: "a blocked data source is reported as unknown, never as zero" and
// "a blocked source is not zero — treat it as unknown". It was false here until 2026-07-27:
// the blocked branch returned totalOwed:0 while holding the HTTP code proving the invoices were
// never read. A consumer summing totalOwed across locations silently under-counted real money
// owed, with nothing in the payload separating "settled" from "denied".

const INVOICES_URL = 'GET /invoices/?altId=L-TEST&altType=location&limit=100&offset=0';

test('receivables: blocked → totalOwed is null (unknown), never 0', async () => {
  const { ctx, getPrinted } = makeFakeCtx({ fixture: { [INVOICES_URL]: { status: 401, j: {} } } });
  await run({ top: 20 }, ctx);
  ctx.out.flush();
  const d = JSON.parse(getPrinted()).data;
  assert.equal(d.totalOwed, null, 'a denied read must not report 0 owed');
  assert.equal(d.outstanding, null);
  assert.equal(d.scanned, null);
  assert.equal(d.blocked, 401, 'the reason must travel with the unknown');
});

test('receivables: blocked → envelope is marked degraded with a warning', async () => {
  const { ctx, getPrinted } = makeFakeCtx({ fixture: { [INVOICES_URL]: { status: 403, j: {} } } });
  await run({ top: 20 }, ctx);
  ctx.out.flush();
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.degraded, true);
  assert.ok(envelope.warnings.some(w => /can't see invoices/.test(w)));
});

test('receivables: blocked human render never says "All settled"', async () => {
  // The money-side fake-green: an empty list because we were denied looked identical to an
  // empty list because the books are clear.
  const { ctx, getPrinted } = makeFakeCtx({
    fixture: { [INVOICES_URL]: { status: 401, j: {} } }, json: false,
  });
  await run({ top: 20 }, ctx);
  ctx.out.flush();
  const printed = getPrinted();
  assert.ok(!/All settled/.test(printed), 'must not claim settled books it could not read');
  assert.ok(/UNKNOWN/.test(printed));
  assert.ok(/NOT "nothing outstanding"/.test(printed), 'must say plainly what the empty state means');
});

test('receivables: a genuinely empty (but readable) account still reports 0, not unknown', async () => {
  // The inverse guard. Zero is the correct answer when we actually looked — conflating the two
  // in the other direction would make every settled account look broken.
  const { ctx, getPrinted } = makeFakeCtx({
    fixture: { [INVOICES_URL]: { status: 200, j: { invoices: [] } } },
  });
  await run({ top: 20 }, ctx);
  ctx.out.flush();
  const d = JSON.parse(getPrinted()).data;
  assert.equal(d.blocked, undefined, 'a successful read must not be marked blocked');
  assert.equal(d.totalOwed, 0, 'genuinely nothing owed is 0, not null');
});

// ── pagination ────────────────────────────────────────────────────────────────

test('receivables: fetches page 2 when page 1 is exactly at the limit (100 items)', async () => {
  // The nextCursor fires only when items.length === 100 — if this were not tested, a regression
  // that always returned null would silently undercount whenever a location has >100 outstanding.
  const NOW = 1_700_000_000_000;
  const page1 = Array.from({ length: 100 }, (_, i) => ({
    _id: `p1-${i}`, invoiceNumber: `P1-${i}`, status: 'sent', currency: 'PHP',
    total: 1000, amountPaid: 0, contactDetails: { name: `P1 Client ${i}` },
    dueDate: new Date(NOW - (i + 1) * 86400000).toISOString(),
  }));
  const page2 = [
    { _id: 'p2-0', invoiceNumber: 'P2-0', status: 'overdue', currency: 'PHP',
      total: 5000, amountPaid: 0, contactDetails: { name: 'P2 Client 0' },
      dueDate: new Date(NOW - 200 * 86400000).toISOString() },
  ];
  const { ctx, getPrinted } = makeFakeCtx({
    fixture: {
      'GET /invoices/?altId=L-TEST&altType=location&limit=100&offset=0':   { status: 200, j: { invoices: page1 } },
      'GET /invoices/?altId=L-TEST&altType=location&limit=100&offset=100': { status: 200, j: { invoices: page2 } },
    },
    now: NOW,
  });
  const code = await run({ top: 20 }, ctx);
  ctx.out.flush();
  assert.equal(code, 0);
  const d = JSON.parse(getPrinted()).data;
  assert.equal(d.scanned, 101, 'all 101 invoices from both pages must be scanned');
  assert.equal(d.outstanding, 101, '101 unpaid invoices');
  assert.equal(d.totalOwed, 100 * 1000 + 5000, 'totalOwed spans both pages');
});

// ── partial scan (page 1 OK, page 2 error) ──────────────────────────────────

test('receivables: partial scan → truncated:true + partialScanError in envelope', async () => {
  // page 1 comes back clean (100 items), page 2 returns 500. The records from page 1 are real;
  // the total is a floor. Must NOT exit 0 or omit the truncation signal.
  const NOW = 1_700_000_000_000;
  const page1 = Array.from({ length: 100 }, (_, i) => ({
    _id: `p1-${i}`, invoiceNumber: `P1-${i}`, status: 'sent', currency: 'PHP',
    total: 1000, amountPaid: 0, contactDetails: { name: `Client ${i}` },
    dueDate: new Date(NOW - (i + 1) * 86400000).toISOString(),
  }));
  const { ctx, getPrinted } = makeFakeCtx({
    fixture: {
      'GET /invoices/?altId=L-TEST&altType=location&limit=100&offset=0':   { status: 200, j: { invoices: page1 } },
      'GET /invoices/?altId=L-TEST&altType=location&limit=100&offset=100': { status: 500, j: {} },
    },
    now: NOW,
  });
  const code = await run({ top: 20 }, ctx);
  ctx.out.flush();
  assert.equal(code, 0, 'a partial result still exits 0 — the data we have is real');
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.degraded, true, 'partial scan must mark the envelope degraded');
  assert.equal(envelope.data.truncated, true, 'truncated must be true in the data payload');
  assert.equal(envelope.data.partialScanError, 500);
  assert.ok(envelope.warnings.some(w => /INCOMPLETE/.test(w) || /page fetch failed/.test(w)),
    'warning must state the result is incomplete');
});

test('receivables: partial scan human card prints "⚠ INCOMPLETE" and names the HTTP code', async () => {
  const NOW = 1_700_000_000_000;
  const page1 = Array.from({ length: 100 }, (_, i) => ({
    _id: `p1-${i}`, invoiceNumber: `P1-${i}`, status: 'sent', currency: 'PHP',
    total: 1000, amountPaid: 0, contactDetails: { name: `Client ${i}` },
    dueDate: new Date(NOW - (i + 1) * 86400000).toISOString(),
  }));
  const { ctx, getPrinted } = makeFakeCtx({
    json: false,
    fixture: {
      'GET /invoices/?altId=L-TEST&altType=location&limit=100&offset=0':   { status: 200, j: { invoices: page1 } },
      'GET /invoices/?altId=L-TEST&altType=location&limit=100&offset=100': { status: 503, j: {} },
    },
    now: NOW,
  });
  await run({ top: 20 }, ctx);
  ctx.out.flush();
  const out = getPrinted();
  assert.ok(/INCOMPLETE/i.test(out), 'must say INCOMPLETE');
  assert.ok(/503/.test(out), 'must name the HTTP code that caused truncation');
  assert.ok(/at least/.test(out), 'the summary line must say "at least" when truncated');
});

// ── multi-currency ────────────────────────────────────────────────────────────

test('receivables: multi-currency → byCurrency map in envelope, totalOwed is sum across currencies', async () => {
  // A location handling both PHP and USD clients must never cross-sum or hide one.
  // The per-currency totals fix (trust-fix #3) is load-bearing for real accuracy here.
  const NOW = 1_700_000_000_000;
  const fixture = {
    [INVOICES_URL]: {
      status: 200,
      j: {
        invoices: [
          { _id: 'php1', invoiceNumber: 'PHP-001', status: 'sent', currency: 'PHP',
            total: 10000, amountPaid: 0, contactDetails: { name: 'PH Client' },
            dueDate: new Date(NOW - 10 * 86400000).toISOString() },
          { _id: 'usd1', invoiceNumber: 'USD-001', status: 'overdue', currency: 'USD',
            total: 500, amountPaid: 100, contactDetails: { name: 'US Client' },
            dueDate: new Date(NOW - 20 * 86400000).toISOString() },
        ],
      },
    },
  };
  const { ctx, getPrinted } = makeFakeCtx({ fixture, now: NOW });
  await run({ top: 20 }, ctx);
  ctx.out.flush();
  const d = JSON.parse(getPrinted()).data;
  assert.ok(d.byCurrency, 'byCurrency must be present when there are multiple currencies');
  assert.equal(d.byCurrency.PHP, 10000, 'PHP total must be 10000');
  assert.equal(d.byCurrency.USD, 400, 'USD total must be 500-100=400');
  assert.equal(d.totalOwed, 10000 + 400, 'totalOwed is the cross-currency sum');
});

// ── aging rendering branches (human card) ────────────────────────────────────

test('receivables: invoice with future due date renders as "due in Xd", not "aged -Xd"', async () => {
  // Reproduced 2026-07-30: an invoice not yet due used to show "aged -30d" — looks like a bug
  // and files a current invoice under the aged heading.
  const NOW = 1_700_000_000_000;
  const fixture = {
    [INVOICES_URL]: {
      status: 200,
      j: {
        invoices: [
          { _id: 'fut1', invoiceNumber: 'FUT-001', status: 'sent', currency: 'PHP',
            total: 9000, amountPaid: 0, contactDetails: { name: 'Future Client' },
            dueDate: new Date(NOW + 5 * 86400000).toISOString() }, // due in 5 days
        ],
      },
    },
  };
  const { ctx, getPrinted } = makeFakeCtx({ fixture, now: NOW, json: false });
  await run({ top: 20 }, ctx);
  ctx.out.flush();
  const out = getPrinted();
  assert.ok(/due in \d+d/.test(out), 'future due date must render as "due in Xd"');
  assert.ok(!/aged -/.test(out), 'must not render a negative-days aged label');
});

test('receivables: invoice due today renders as "due today"', async () => {
  const NOW = 1_700_000_000_000;
  const fixture = {
    [INVOICES_URL]: {
      status: 200,
      j: {
        invoices: [
          { _id: 'today1', invoiceNumber: 'TODAY-001', status: 'sent', currency: 'PHP',
            total: 3000, amountPaid: 0, contactDetails: { name: 'Due Today Client' },
            dueDate: new Date(NOW).toISOString() }, // exactly now → age=0
        ],
      },
    },
  };
  const { ctx, getPrinted } = makeFakeCtx({ fixture, now: NOW, json: false });
  await run({ top: 20 }, ctx);
  ctx.out.flush();
  assert.ok(/due today/.test(getPrinted()), 'age=0 must render as "due today"');
});

// ── human card overflow ("… +N more") ────────────────────────────────────────

test('receivables: human card prints "… +N more" when outstanding exceeds --top', async () => {
  // The outstanding count is the full set; --top limits the displayed rows.
  // The card must say how many were suppressed — not silently drop them.
  const NOW = 1_700_000_000_000;
  const invoices = Array.from({ length: 5 }, (_, i) => ({
    _id: `inv${i}`, invoiceNumber: `INV-00${i}`, status: 'overdue', currency: 'PHP',
    total: 1000, amountPaid: 0, contactDetails: { name: `Client ${i}` },
    dueDate: new Date(NOW - (i + 1) * 86400000).toISOString(),
  }));
  const { ctx, getPrinted } = makeFakeCtx({
    fixture: { [INVOICES_URL]: { status: 200, j: { invoices } } },
    now: NOW,
    json: false,
  });
  await run({ top: 2 }, ctx);
  ctx.out.flush();
  const out = getPrinted();
  assert.ok(/\+3 more/.test(out), 'must print "+3 more" when 5 outstanding but top=2');
});

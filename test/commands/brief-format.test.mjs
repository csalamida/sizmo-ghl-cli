// test/commands/brief-format.test.mjs — share-worthy human render (Feature 3).
// Verifies: each --format renders + parses; headline math (sum correct + blocked-source
// excluded); --json golden parity UNCHANGED; never-fabricate on a degraded money source;
// currency resolved from the model (never hardcoded ₱).
//
// The --json envelope, collect(), and rankActions() are NOT touched by this feature — the
// existing brief.test.mjs golden parity test still guards the machine path. These tests cover
// only the human surface.
import { test } from 'node:test';
import assert from 'node:assert';
import { run } from '../../commands/brief.mjs';
import { makeOut } from '../../lib/output.mjs';

const NOW = 1_700_000_000_000;

// Human-render ctx: json:false + tty:true so the card actually renders. Optional injected
// model supplies the location currency (mirrors what snapshot.collect's ensureModel does).
function makeHumanCtx(http, { model = null, profileName = 'demo' } = {}) {
  let printed = '';
  const out = makeOut({ json: false, tty: true, command: 'brief', location: 'L-TEST', write: s => printed += s, writeErr: () => {} });
  const ctx = {
    http,
    cfg: { loc: 'L-TEST', tz: 'Asia/Manila', currency: null, profileName },
    out, now: NOW,
    get model() { return model; },
    ensureModel: async () => model,
  };
  return { ctx, getPrinted: () => printed };
}

// http with one overdue invoice (₱30,000) and nothing else outstanding.
function httpOneInvoice(currency = 'PHP') {
  return { get: async (path) => {
    if (path === '/invoices/') return { code: 200, ok: true, j: { invoices: [
      { _id: 'inv1', invoiceNumber: 'INV-001', status: 'overdue', currency,
        total: 30000, amountPaid: 0, contactDetails: { name: 'Owes Co' },
        dueDate: new Date(NOW - 104 * 86400000).toISOString() },
    ] } };
    if (path === '/opportunities/pipelines') return { code: 200, ok: true, j: { pipelines: [] } };
    if (path === '/opportunities/search') return { code: 200, ok: true, j: { opportunities: [] } };
    if (path === '/conversations/search') return { code: 200, ok: true, j: { conversations: [] } };
    if (path === '/contacts/') return { code: 200, ok: true, j: { contacts: [] } };
    if (path === '/calendars/') return { code: 200, ok: true, j: { calendars: [] } };
    if (path === '/payments/transactions') return { code: 200, ok: true, j: { data: [] } };
    return { code: 200, ok: true, j: {} };
  }};
}

function allClearHttp() {
  return { get: async (path) => {
    if (path === '/invoices/') return { code: 200, ok: true, j: { invoices: [] } };
    if (path === '/opportunities/pipelines') return { code: 200, ok: true, j: { pipelines: [] } };
    if (path === '/opportunities/search') return { code: 200, ok: true, j: { opportunities: [] } };
    if (path === '/conversations/search') return { code: 200, ok: true, j: { conversations: [] } };
    if (path === '/contacts/') return { code: 200, ok: true, j: { contacts: [] } };
    if (path === '/calendars/') return { code: 200, ok: true, j: { calendars: [] } };
    if (path === '/payments/transactions') return { code: 200, ok: true, j: { data: [] } };
    return { code: 200, ok: true, j: {} };
  }};
}

const phpModel = { schemaVersion: 1, locationId: 'L-TEST', syncedAt: NOW, entities: { location: { fetchedAt: NOW, item: { currency: 'PHP' } } }, offline: false };

// ── each format renders + parses ────────────────────────────────────────────────

test('brief --format pretty: renders the headline + Money leaks + Needs you today blocks', async () => {
  const { ctx, getPrinted } = makeHumanCtx(httpOneInvoice(), { model: phpModel });
  await run({ days: 7, format: 'pretty', 'no-memory': true }, ctx);
  ctx.out.flush();
  const out = getPrinted();
  assert.match(out, /₱30,000 found · 1 need you today/, 'headline math + currency from model');
  assert.match(out, /Money leaks/);
  assert.match(out, /Needs you today/);
  assert.match(out, /sizmo brief · demo ·/, 'footer with profile, no telemetry');
});

test('brief --format slack: renders Slack mrkdwn (bold headline + bullets), parses cleanly', async () => {
  const { ctx, getPrinted } = makeHumanCtx(httpOneInvoice(), { model: phpModel });
  await run({ days: 7, format: 'slack', 'no-memory': true }, ctx);
  ctx.out.flush();
  const out = getPrinted();
  assert.match(out, /\*₱30,000 found · 1 need you today\*/, 'slack bold headline');
  assert.match(out, /\*Money leaks\*/, 'slack section header');
  assert.match(out, /^• /m, 'slack bullet present');
  assert.match(out, /_sizmo brief · demo ·/, 'slack italic footer');
});

test('brief --format md: renders portable markdown (headings + list), parses cleanly', async () => {
  const { ctx, getPrinted } = makeHumanCtx(httpOneInvoice(), { model: phpModel });
  await run({ days: 7, format: 'md', 'no-memory': true }, ctx);
  ctx.out.flush();
  const out = getPrinted();
  assert.match(out, /^# ₱30,000 found · 1 need you today$/m, 'md h1 headline');
  assert.match(out, /^## Money leaks$/m, 'md h2 section');
  assert.match(out, /^- /m, 'md list item present');
  assert.match(out, /^sizmo brief · demo ·/m, 'md footer');
});

// ── headline math: sum correctness ───────────────────────────────────────────────

test('brief headline: sums known leaks correctly (two overdue invoices)', async () => {
  const http = { get: async (path) => {
    if (path === '/invoices/') return { code: 200, ok: true, j: { invoices: [
      { _id: 'a', invoiceNumber: 'A', status: 'overdue', currency: 'PHP', total: 20000, amountPaid: 0, contactDetails: { name: 'A Co' }, dueDate: new Date(NOW - 100 * 86400000).toISOString() },
      { _id: 'b', invoiceNumber: 'B', status: 'overdue', currency: 'PHP', total: 5000, amountPaid: 0, contactDetails: { name: 'B Co' }, dueDate: new Date(NOW - 50 * 86400000).toISOString() },
    ] } };
    if (path === '/opportunities/pipelines') return { code: 200, ok: true, j: { pipelines: [] } };
    if (path === '/opportunities/search') return { code: 200, ok: true, j: { opportunities: [] } };
    if (path === '/conversations/search') return { code: 200, ok: true, j: { conversations: [] } };
    if (path === '/contacts/') return { code: 200, ok: true, j: { contacts: [] } };
    if (path === '/calendars/') return { code: 200, ok: true, j: { calendars: [] } };
    if (path === '/payments/transactions') return { code: 200, ok: true, j: { data: [] } };
    return { code: 200, ok: true, j: {} };
  }};
  const { ctx, getPrinted } = makeHumanCtx(http, { model: phpModel });
  await run({ days: 7, format: 'pretty', 'no-memory': true }, ctx);
  ctx.out.flush();
  // 20000 + 5000 = 25000
  assert.match(getPrinted(), /₱25,000 found/, 'headline sums both invoices');
});

// ── headline: blocked money source excluded, footnoted, never fabricated ─────────

test('brief headline: blocked receivables source → excluded from total + footnoted, never faked', async () => {
  const http = { get: async (path) => {
    if (path === '/invoices/') return { code: 403, ok: false, j: {} }; // BLOCKED money source
    if (path === '/opportunities/pipelines') return { code: 200, ok: true, j: { pipelines: [] } };
    if (path === '/opportunities/search') return { code: 200, ok: true, j: { opportunities: [] } };
    if (path === '/conversations/search') return { code: 200, ok: true, j: { conversations: [] } };
    if (path === '/contacts/') return { code: 200, ok: true, j: { contacts: [] } };
    if (path === '/calendars/') return { code: 200, ok: true, j: { calendars: [] } };
    if (path === '/payments/transactions') return { code: 200, ok: true, j: { data: [] } };
    return { code: 200, ok: true, j: {} };
  }};
  const { ctx, getPrinted } = makeHumanCtx(http, { model: phpModel });
  await run({ days: 7, format: 'pretty', 'no-memory': true }, ctx);
  ctx.out.flush();
  const out = getPrinted();
  // No invoice money is known → headline must read honestly, NOT fabricate a number
  assert.match(out, /No leaks found/, 'blocked source → no fabricated leak total');
  // and the degraded source must be footnoted (never silently green)
  assert.match(out, /degraded|blocked/i, 'degraded money source footnoted');
});

// ── zero leaks honest headline ───────────────────────────────────────────────────

test('brief headline: zero leaks → honest "No leaks found", never a fake number', async () => {
  const { ctx, getPrinted } = makeHumanCtx(allClearHttp(), { model: phpModel });
  await run({ days: 7, format: 'pretty', 'no-memory': true }, ctx);
  ctx.out.flush();
  assert.match(getPrinted(), /No leaks found · 0 need you today/);
});

// ── currency never hardcoded ₱ ───────────────────────────────────────────────────

test('brief headline: USD location → uses $ from model, never assumes ₱', async () => {
  const usdModel = { schemaVersion: 1, locationId: 'L-TEST', syncedAt: NOW, entities: { location: { fetchedAt: NOW, item: { currency: 'USD' } } }, offline: false };
  // invoice currency USD so the ranked leak carries USD
  const { ctx, getPrinted } = makeHumanCtx(httpOneInvoice('USD'), { model: usdModel });
  await run({ days: 7, format: 'pretty', 'no-memory': true }, ctx);
  ctx.out.flush();
  const out = getPrinted();
  assert.match(out, /\$30,000 found/, 'USD symbol used');
  assert.doesNotMatch(out.split('\n')[1] || '', /₱/, 'no hardcoded ₱ in the headline');
});

test('brief headline: leak currency ≠ model currency → headline shows the LEAK currency (P1 mismatch guard)', async () => {
  // The exact P1 bug: a PHP-denominated leak in a USD-configured account must NOT render
  // with the model's $ symbol. The headline symbol follows the AMOUNT, never the model.
  const usdModel = { schemaVersion: 1, locationId: 'L-TEST', syncedAt: NOW, entities: { location: { fetchedAt: NOW, item: { currency: 'USD' } } }, offline: false };
  // invoice explicitly in PHP, while the model says the account currency is USD
  const { ctx, getPrinted } = makeHumanCtx(httpOneInvoice('PHP'), { model: usdModel });
  await run({ days: 7, format: 'pretty', 'no-memory': true }, ctx);
  ctx.out.flush();
  const headlineLine = (getPrinted().match(/║[^║]*found[^║]*║/) || [''])[0];
  assert.match(headlineLine, /₱30,000 found/, 'headline uses the PHP leak currency');
  assert.doesNotMatch(headlineLine, /\$30,000/, 'headline must NOT show the model $ on a PHP amount');
});

test('brief headline: model currency absent → headline uses the leak\'s own currency + matches line items (never diverges)', async () => {
  // model has no currency. The invoice has no currency field either → receivables defaults it
  // to PHP UPSTREAM. The brief headline must then show that SAME currency as the line item —
  // it must NOT source a different symbol from the (absent) model currency. This is the P1
  // regression guard: headline currency == amount's real currency, always.
  // (The "brief never hardcodes ₱" guarantee is proven by the USD test above — a USD leak → $.)
  const noCurModel = { schemaVersion: 1, locationId: 'L-TEST', syncedAt: NOW, entities: { location: { fetchedAt: NOW, item: {} } }, offline: false };
  const http = { get: async (path) => {
    if (path === '/invoices/') return { code: 200, ok: true, j: { invoices: [
      { _id: 'x', invoiceNumber: 'X', status: 'overdue', total: 1000, amountPaid: 0, contactDetails: { name: 'X' }, dueDate: new Date(NOW - 40 * 86400000).toISOString() },
    ] } };
    if (path === '/opportunities/pipelines') return { code: 200, ok: true, j: { pipelines: [] } };
    if (path === '/opportunities/search') return { code: 200, ok: true, j: { opportunities: [] } };
    if (path === '/conversations/search') return { code: 200, ok: true, j: { conversations: [] } };
    if (path === '/contacts/') return { code: 200, ok: true, j: { contacts: [] } };
    if (path === '/calendars/') return { code: 200, ok: true, j: { calendars: [] } };
    if (path === '/payments/transactions') return { code: 200, ok: true, j: { data: [] } };
    return { code: 200, ok: true, j: {} };
  }};
  const { ctx, getPrinted } = makeHumanCtx(http, { model: noCurModel });
  await run({ days: 7, format: 'pretty', 'no-memory': true }, ctx);
  ctx.out.flush();
  const out = getPrinted();
  const headlineLine = (out.match(/║[^║]*found[^║]*║/) || [''])[0];
  // headline uses the leak's own (defaulted-PHP) currency — NOT a divergent model symbol
  assert.match(headlineLine, /₱1,000 found/, 'headline uses the leak\'s own currency');
  // and the itemized line carries the SAME symbol — headline and items never disagree
  assert.match(out, /₱1,000 · X · overdue/, 'line item currency matches the headline');
});

// ── currency symbol consistency: headline + line item agree (money.mjs single source) ──

test('brief AUD leak: headline and line item both render A$ (no SYM-set drift)', async () => {
  // Regression guard for the pre-money.mjs drift: brief knew AUD→A$ but the ranker rendered
  // "AUD ". Now both pull SYM from lib/money.mjs, so the same AUD invoice must show A$ in BOTH
  // the headline (via fmtMoney) and the itemized money-leak line (via SYM).
  const audModel = { schemaVersion: 1, locationId: 'L-TEST', syncedAt: NOW, entities: { location: { fetchedAt: NOW, item: { currency: 'AUD' } } }, offline: false };
  const { ctx, getPrinted } = makeHumanCtx(httpOneInvoice('AUD'), { model: audModel });
  await run({ days: 7, format: 'pretty', 'no-memory': true }, ctx);
  ctx.out.flush();
  const out = getPrinted();
  const headlineLine = (out.match(/║[^║]*found[^║]*║/) || [''])[0];
  assert.match(headlineLine, /A\$30,000 found/, 'headline uses A$ (not "AUD ")');
  assert.match(out, /A\$30,000 · Owes Co · overdue/, 'line item uses A$ too — same source, no drift');
  assert.doesNotMatch(out, /AUD 30,000/, 'the old drifted "AUD " form must not appear');
});

// ── --format only affects human render, never the --json envelope ───────────────

test('brief --format does not change the --json envelope (machine path sacred)', async () => {
  // json mode: capture envelope with and without --format; they must be identical.
  function jsonCtx(http) {
    let printed = '';
    const out = makeOut({ json: true, tty: false, command: 'brief', location: 'L-TEST', write: s => printed += s, writeErr: () => {} });
    const ctx = { http, cfg: { loc: 'L-TEST', tz: 'Asia/Manila', currency: null }, out, now: NOW };
    return { ctx, getPrinted: () => printed };
  }
  const a = jsonCtx(allClearHttp());
  await run({ days: 7, 'no-memory': true }, a.ctx);
  a.ctx.out.flush();
  const b = jsonCtx(allClearHttp());
  await run({ days: 7, format: 'slack', 'no-memory': true }, b.ctx);
  b.ctx.out.flush();
  assert.deepStrictEqual(JSON.parse(b.getPrinted()), JSON.parse(a.getPrinted()),
    '--format must NOT alter the JSON envelope');
});

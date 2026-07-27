// test/commands/brief.test.mjs — smoke tests for the in-process brief orchestrator.
// Verifies: run() returns 0, envelope shape (data.snapshot, data.actions array,
// data.sources keys), and that degraded sub-collects don't crash the brief.
//
// Brief fans out 5 sub-collects. Each hits different query-string patterns.
// Tests here use inline http stubs (not makeFakeCtx) to handle overlapping paths
// cleanly (e.g. triage+snapshot both hit /conversations/search with different qs).
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { run } from '../../commands/brief.mjs';
import { makeFakeCtx } from '../_helpers.mjs';
import { makeOut } from '../../lib/output.mjs';

const GOLDEN_PATH = new URL('../golden/brief.json', import.meta.url);

// Inline http that answers all sub-collect paths without caring about exact qs.
// Used only when tests don't need to assert specific query-string plumbing.
function makeAllClearHttp() {
  return { get: async (path, opts = {}) => {
    if (path === '/contacts/') return { code: 200, ok: true, j: { contacts: [] } };
    if (path === '/calendars/') return { code: 200, ok: true, j: { calendars: [] } };
    if (path === '/calendars/events') return { code: 200, ok: true, j: { events: [] } };
    if (path === '/payments/transactions') return { code: 200, ok: true, j: { data: [] } };
    if (path === '/opportunities/search') return { code: 200, ok: true, j: { opportunities: [] } };
    if (path === '/conversations/search') return { code: 200, ok: true, j: { conversations: [] } };
    if (path === '/opportunities/pipelines') return { code: 200, ok: true, j: { pipelines: [] } };
    if (path === '/invoices/') return { code: 200, ok: true, j: { invoices: [] } };
    return { code: 200, ok: true, j: {} };
  }};
}

function makeCtx(http, now = 1_700_000_000_000, json = true) {
  let printed = '';
  const out = makeOut({ json, tty: false, command: 'test', location: 'L-TEST', write: s => printed += s, writeErr: () => {} });
  const ctx = { http, cfg: { loc: 'L-TEST', tz: 'Asia/Manila', currency: null }, out, now };
  return { ctx, getPrinted: () => printed };
}

test('brief: run returns 0', async () => {
  const { ctx } = makeCtx(makeAllClearHttp());
  const code = await run({ days: 7 }, ctx);
  assert.equal(code, 0, 'run() must return 0');
});

test('brief: default envelope has data.snapshot + data.actions but NO data.sources', async () => {
  const { ctx, getPrinted } = makeCtx(makeAllClearHttp());
  await run({ days: 7 }, ctx);
  ctx.out.flush();
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.schemaVersion, 1, 'schemaVersion must be 1');
  assert.ok(envelope.data, 'envelope.data present');
  assert.ok('snapshot' in envelope.data, 'data.snapshot present');
  assert.ok(Array.isArray(envelope.data.actions), 'data.actions is array');
  // default lean: sources blob absent (no duplication)
  assert.ok(!('sources' in envelope.data), 'data.sources must NOT be in default JSON output (token-lean)');
  // internal _sources must also be stripped
  assert.ok(!('_sources' in envelope.data), 'data._sources must NOT leak into envelope');
});

test('brief: --verbose restores data.sources blob', async () => {
  const { ctx, getPrinted } = makeCtx(makeAllClearHttp());
  await run({ days: 7, verbose: true }, ctx);
  ctx.out.flush();
  const envelope = JSON.parse(getPrinted());
  assert.ok(envelope.data.sources, 'data.sources present with --verbose');
  for (const k of ['triage', 'noshow', 'pipeline', 'receivables']) {
    assert.ok(k in envelope.data.sources, `data.sources.${k} present`);
  }
});

test('brief: data.days reflects --days arg', async () => {
  const { ctx, getPrinted } = makeCtx(makeAllClearHttp());
  await run({ days: 14 }, ctx);
  ctx.out.flush();
  const { data } = JSON.parse(getPrinted());
  assert.equal(data.days, 14, 'data.days must equal args.days');
});

test('brief: degraded sub-collect does not throw, still returns 0', async () => {
  const http = { get: async (path, opts = {}) => {
    // Pipelines returns 500 → pipeline.collect() degrades
    if (path === '/opportunities/pipelines') return { code: 500, ok: false, j: {} };
    // All other paths clean
    if (path === '/contacts/') return { code: 200, ok: true, j: { contacts: [] } };
    if (path === '/calendars/') return { code: 200, ok: true, j: { calendars: [] } };
    if (path === '/payments/transactions') return { code: 200, ok: true, j: { data: [] } };
    if (path === '/opportunities/search') return { code: 200, ok: true, j: { opportunities: [] } };
    if (path === '/conversations/search') return { code: 200, ok: true, j: { conversations: [] } };
    if (path === '/invoices/') return { code: 200, ok: true, j: { invoices: [] } };
    return { code: 200, ok: true, j: {} };
  }};
  const { ctx, getPrinted } = makeCtx(http);
  const code = await run({ days: 7 }, ctx);
  ctx.out.flush();
  assert.equal(code, 0, 'still returns 0 when a sub-collect degrades');
  const envelope = JSON.parse(getPrinted());
  assert.ok(Array.isArray(envelope.data.actions), 'actions array still present');
  // default lean: sources not in envelope; use --verbose to drill into sub-source state

  // verify degraded flag propagated into envelope
  assert.ok(envelope.degraded === true, 'envelope.degraded true when pipeline degrades');
});

test('brief: degraded sub-collect visible via --verbose sources', async () => {
  const http = { get: async (path, opts = {}) => {
    if (path === '/opportunities/pipelines') return { code: 500, ok: false, j: {} };
    if (path === '/contacts/') return { code: 200, ok: true, j: { contacts: [] } };
    if (path === '/calendars/') return { code: 200, ok: true, j: { calendars: [] } };
    if (path === '/payments/transactions') return { code: 200, ok: true, j: { data: [] } };
    if (path === '/opportunities/search') return { code: 200, ok: true, j: { opportunities: [] } };
    if (path === '/conversations/search') return { code: 200, ok: true, j: { conversations: [] } };
    if (path === '/invoices/') return { code: 200, ok: true, j: { invoices: [] } };
    return { code: 200, ok: true, j: {} };
  }};
  const { ctx, getPrinted } = makeCtx(http);
  await run({ days: 7, verbose: true }, ctx);
  ctx.out.flush();
  const envelope = JSON.parse(getPrinted());
  const pipeSrc = envelope.data.sources.pipeline;
  assert.ok(pipeSrc, 'sources.pipeline present with --verbose even when degraded');
});

test('brief: empty data → empty actions list, all-clear implied', async () => {
  const { ctx, getPrinted } = makeCtx(makeAllClearHttp());
  await run({ days: 7 }, ctx);
  ctx.out.flush();
  const { data } = JSON.parse(getPrinted());
  // With zero contacts / invoices / stuck deals / noshows / unread threads,
  // none of the action conditions fire → actions must be empty.
  assert.deepEqual(data.actions, [], 'actions should be empty when nothing is outstanding');
});

test('brief: actions are money-ordered — high-₱ item ranks above high-count-but-low-₱ pile', async () => {
  // One stuck deal at ₱50k + many waiting threads (high count, zero money)
  // The deal must rank first because money > count.
  const NOW = 1_700_000_000_000;
  const http = { get: async (path) => {
    if (path === '/opportunities/pipelines') return { code:200, ok:true, j:{ pipelines:[{ id:'p1', name:'P', stages:[{id:'s1',name:'Lead'}] }] } };
    if (path === '/opportunities/search')    return { code:200, ok:true, j:{ opportunities:[
      { id:'o1', pipelineId:'p1', pipelineStageId:'s1', monetaryValue:50000, name:'BigDeal', contactId:'d1',
        updatedAt: new Date(NOW - 21*86400000).toISOString() },
    ] } };
    if (path === '/invoices/')               return { code:200, ok:true, j:{ invoices:[] } };
    if (path === '/conversations/search')    return { code:200, ok:true, j:{ conversations:[
      // 5 waiting threads — high count, zero money
      ...Array.from({length:5}, (_,i) => ({
        id:`c${i}`, contactId:`t${i}`, contactName:`Person${i}`,
        unreadCount:1, lastMessageDate: NOW - (i+1)*86400000, lastMessageType:'TYPE_EMAIL',
      })),
    ] } };
    if (path.startsWith('/conversations/') && path.endsWith('/messages')) return { code:200, ok:true, j:{ messages:{messages:[]} } };
    if (path === '/contacts/')               return { code:200, ok:true, j:{ contacts:[] } };
    if (path === '/calendars/')              return { code:200, ok:true, j:{ calendars:[] } };
    if (path === '/payments/transactions')   return { code:200, ok:true, j:{ data:[] } };
    return { code:200, ok:true, j:{} };
  }};
  let printed = '';
  const out = makeOut({ json:true, tty:false, command:'test', location:'L-TEST', write: s => printed += s, writeErr: () => {} });
  const ctx = { http, cfg:{ loc:'L-TEST', tz:'Asia/Manila', currency:null }, out, now: NOW };
  await run({ days:7 }, ctx);
  ctx.out.flush();
  const { data } = JSON.parse(printed);
  assert.ok(Array.isArray(data.actions) && data.actions.length > 0, 'actions non-empty');
  // First action must be money-bearing (the ₱50k deal), not a count-sorted thread
  const first = data.actions[0];
  assert.ok(first.money != null && first.money > 0, `first action must have money; got money=${first.money}`);
  assert.equal(first.kind, 'stuck-deals', `first action must be the deal, got: ${first.kind}`);
});

test('brief + focus same ranker parity — same fixture produces same top ordering', async () => {
  // Fixture: one big deal + one invoice + one waiting thread.
  // brief actions (money items first) must match focus ranked order.
  const NOW = 1_700_000_000_000;
  const http = { get: async (path) => {
    if (path === '/opportunities/pipelines') return { code:200, ok:true, j:{ pipelines:[{ id:'p1', name:'P', stages:[{id:'s1',name:'Lead'}] }] } };
    if (path === '/opportunities/search')    return { code:200, ok:true, j:{ opportunities:[
      { id:'o1', pipelineId:'p1', pipelineStageId:'s1', monetaryValue:50000, name:'BigDeal', contactId:'d1',
        updatedAt: new Date(NOW - 21*86400000).toISOString() },
      { id:'o2', pipelineId:'p1', pipelineStageId:'s1', monetaryValue:5000, name:'SmallDeal', contactId:'d2',
        updatedAt: new Date(NOW - 40*86400000).toISOString() },
    ] } };
    if (path === '/invoices/')               return { code:200, ok:true, j:{ invoices:[
      { _id:'inv1', invoiceNumber:'INV-001', status:'overdue', currency:'PHP',
        total:30000, amountPaid:0, contactDetails:{ name:'Owes' },
        dueDate: new Date(NOW - 104*86400000).toISOString() },
    ] } };
    if (path === '/conversations/search')    return { code:200, ok:true, j:{ conversations:[
      { id:'conv1', contactId:'t1', contactName:'WaitingP', unreadCount:2, lastMessageDate:NOW-3*86400000, lastMessageType:'TYPE_EMAIL' },
    ] } };
    if (path.startsWith('/conversations/') && path.endsWith('/messages')) return { code:200, ok:true, j:{ messages:{messages:[]} } };
    if (path === '/contacts/')               return { code:200, ok:true, j:{ contacts:[] } };
    if (path === '/calendars/')              return { code:200, ok:true, j:{ calendars:[] } };
    if (path === '/payments/transactions')   return { code:200, ok:true, j:{ data:[] } };
    return { code:200, ok:true, j:{} };
  }};
  const { makeOut } = await import('../../lib/output.mjs');
  const { run: briefRun } = await import('../../commands/brief.mjs');
  const { collect: focusCollect } = await import('../../commands/focus.mjs');

  // brief
  let briefPrinted = '';
  const briefOut = makeOut({ json:true, tty:false, command:'test', location:'L-TEST', write: s => briefPrinted += s, writeErr: () => {} });
  const briefCtx = { http, cfg:{ loc:'L-TEST', tz:'Asia/Manila', currency:null }, out: briefOut, now: NOW };
  await briefRun({ days:7 }, briefCtx);
  briefCtx.out.flush();
  const { data: briefData } = JSON.parse(briefPrinted);

  // focus
  let focusPrinted = '';
  const focusOut = makeOut({ json:true, tty:false, command:'test', location:'L-TEST', write: s => focusPrinted += s, writeErr: () => {} });
  const focusCtx = { http, cfg:{ loc:'L-TEST', tz:'Asia/Manila', currency:null }, out: focusOut, now: NOW };
  const focusResult = await focusCollect({}, focusCtx);

  // brief money-ordered actions (money != null) must match focus.ranked in order
  const briefMoneyActions = briefData.actions.filter(a => a.money != null);
  const focusRanked = focusResult.ranked;

  assert.equal(briefMoneyActions.length, focusRanked.length,
    `brief has ${briefMoneyActions.length} money actions, focus has ${focusRanked.length} ranked`);

  // Top money items must be in same order (money desc)
  for (let i = 0; i < briefMoneyActions.length; i++) {
    assert.ok(briefMoneyActions[i].money >= (briefMoneyActions[i+1]?.money ?? 0),
      `brief action[${i}].money=${briefMoneyActions[i].money} must be >= action[${i+1}].money`);
    assert.equal(briefMoneyActions[i].money, focusRanked[i].money,
      `brief action[${i}].money must equal focus ranked[${i}].money`);
  }

  // unknown-value brief actions must match focus.unknownValue in order
  const briefUnknown = briefData.actions.filter(a => a.money === null);
  const focusUnknown = focusResult.unknownValue;
  assert.equal(briefUnknown.length, focusUnknown.length,
    `brief unknown actions: ${briefUnknown.length}, focus unknownValue: ${focusUnknown.length}`);
});

test('brief: golden data keys present', () => {
  const golden = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8'));
  // Golden from old ghl-brief.mjs is raw JSON (not wrapped in envelope)
  const data = golden.data ?? golden;
  for (const k of ['location', 'days', 'snapshot', 'actions', 'sources']) {
    assert.ok(k in data, `golden must have key: ${k}`);
  }
  assert.ok(Array.isArray(data.actions), 'golden.actions is array');
  for (const k of ['triage', 'noshow', 'pipeline', 'receivables']) {
    assert.ok(k in data.sources, `golden.sources.${k} present`);
  }
});

// ── token-lean tests ──────────────────────────────────────────────────────────

test('brief --concise: snapshot metrics + action stubs only (no prose, no nested payloads)', async () => {
  const { ctx, getPrinted } = makeCtx(makeAllClearHttp());
  ctx.concise = true; // inject global --concise
  await run({ days: 7 }, ctx);
  ctx.out.flush();
  const envelope = JSON.parse(getPrinted());
  const data = envelope.data;
  // snapshot must be a lean metrics array
  assert.ok(data.snapshot, 'concise snapshot present');
  assert.ok(Array.isArray(data.snapshot.metrics), 'concise snapshot.metrics is array');
  // each metric: label + value only (no note/blocker prose)
  for (const m of data.snapshot.metrics) {
    assert.ok('label' in m && 'value' in m, 'each metric has label + value');
    assert.ok(!('note' in m), 'note must be absent in concise metric');
  }
  // actions: kind + recipe (no inputs, no name prose)
  assert.ok(Array.isArray(data.actions), 'concise actions is array');
  for (const a of data.actions) {
    assert.ok('kind' in a && 'recipe' in a, 'each action has kind + recipe');
    assert.ok(!('inputs' in a), 'inputs must be absent in concise action');
    assert.ok(!('contact' in a), 'contact must be absent in concise action');
  }
  // honesty fields stay in envelope even in concise
  assert.ok('degraded' in envelope, 'degraded present in concise envelope');
  assert.ok('warnings' in envelope, 'warnings present in concise envelope');
});

test('brief --concise: snapshot numbers unchanged vs default', async () => {
  // Run once default, once concise — snapshot metric values must be identical.
  const http = makeAllClearHttp();
  const { ctx: ctx1, getPrinted: get1 } = makeCtx(http);
  await run({ days: 7 }, ctx1);
  ctx1.out.flush();
  const defaultData = JSON.parse(get1()).data;

  const { ctx: ctx2, getPrinted: get2 } = makeCtx(http);
  ctx2.concise = true;
  await run({ days: 7 }, ctx2);
  ctx2.out.flush();
  const conciseData = JSON.parse(get2()).data;

  // Compare metric values between default snapshot and concise snapshot
  const defaultMetrics = defaultData.snapshot.metrics || [];
  const conciseMetrics = conciseData.snapshot.metrics || [];
  assert.equal(conciseMetrics.length, defaultMetrics.length, 'same number of metrics');
  for (let i = 0; i < defaultMetrics.length; i++) {
    assert.equal(conciseMetrics[i].label, defaultMetrics[i].label, `metric[${i}] label matches`);
    assert.deepStrictEqual(conciseMetrics[i].value, defaultMetrics[i].blocked ? null : defaultMetrics[i].value,
      `metric[${i}] value matches`);
  }
});

// ── exit-code honesty: "looked, found nothing" vs "could not look at all" ─────
// Added 2026-07-27 after inducing a real failure: with an invalid PIT, all four lanes returned
// HTTP 401 and brief exited 0 — while `sizmo transactions` correctly exited 3 on the identical
// 401. `sizmo brief && deploy` would proceed, and an agent checking $? would read a dead token
// as a healthy account. brief is documented as "start here", so it is the most-run command.

test('brief: denied on every lane (401) → EXIT.AUTH, not 0', async () => {
  const http = { get: async () => ({ code: 401, ok: false, j: { message: 'unauthorized' } }) };
  const { ctx } = makeCtx(http);
  const code = await run({ days: 7 }, ctx);
  ctx.out.flush();
  assert.equal(code, 3, 'total permission failure must not report success');
});

test('brief: denied everywhere still emits a valid, honest JSON envelope', async () => {
  // Non-zero exit must not come at the cost of machine-readability — an agent needs both the
  // code AND the reason.
  const http = { get: async () => ({ code: 403, ok: false, j: {} }) };
  const { ctx, getPrinted } = makeCtx(http);
  await run({ days: 7 }, ctx);
  ctx.out.flush();
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.degraded, true, 'envelope must admit degradation');
  assert.ok(envelope.warnings.length > 0, 'warnings must say what could not be seen');
});

test('brief: TOTAL API OUTAGE on every lane (500) → EXIT.API, not 0', async () => {
  // The limitation brief's own comment used to record and decline to fix: every lane fails for a
  // NON-auth reason and brief still exits 0, so `sizmo brief && deploy` proceeds during an outage.
  //
  // The stated reason for leaving it was that failing here "would report broken auth to someone
  // whose auth is fine." That only holds if the exit code is AUTH. A 500 is an API problem and
  // EXIT.API says so — which is why this is 1, not 3.
  const http = { get: async () => ({ code: 500, ok: false, j: { message: 'upstream exploded' } }) };
  const { ctx } = makeCtx(http);
  const code = await run({ days: 7 }, ctx);
  ctx.out.flush();
  assert.equal(code, 1, 'a total outage must not report success');
  assert.notEqual(code, 3, 'and must not blame the token, which is fine');
});

test('brief: rate-limited on every lane (429) → EXIT.API, not 0', async () => {
  const http = { get: async () => ({ code: 429, ok: false, j: {} }) };
  const { ctx } = makeCtx(http);
  const code = await run({ days: 7 }, ctx);
  ctx.out.flush();
  assert.equal(code, 1);
});

test('brief: a MIX of denial and outage across lanes → AUTH wins (the actionable diagnosis)', async () => {
  // When several lanes fail at once, "your token lacks a scope" is both more actionable and the
  // likelier explanation than four simultaneous unrelated outages.
  let n = 0;
  const http = { get: async () => { n++; return { code: n % 2 ? 401 : 500, ok: false, j: {} }; } };
  const { ctx } = makeCtx(http);
  const code = await run({ days: 7 }, ctx);
  ctx.out.flush();
  assert.equal(code, 3);
});

test('brief: healthy but genuinely empty account → still 0 (not a failure)', async () => {
  // The inverse guard. An empty account is a real, successful answer — it must never be
  // conflated with blindness, or every new/quiet account looks broken.
  const { ctx } = makeCtx(makeAllClearHttp());
  const code = await run({ days: 7 }, ctx);
  ctx.out.flush();
  assert.equal(code, 0);
});

test('brief: human render never says "All clear" while degraded', async () => {
  // The fake-green this pairs with: "All clear — nobody waiting, nothing stuck, nothing owed"
  // was printed whenever the action list was empty, including when it was empty because every
  // source was blocked. The money section already guarded this; "Needs you today" did not.
  const http = { get: async () => ({ code: 401, ok: false, j: {} }) };
  const { ctx, getPrinted } = makeCtx(http, 1_700_000_000_000, false); // human render
  await run({ days: 7 }, ctx);
  ctx.out.flush();
  const printed = getPrinted();
  assert.ok(!/All clear — nobody waiting/.test(printed),
    'must not claim all-clear when it could not see anything');
  assert.ok(/NOT a clean bill of health/.test(printed),
    'must say plainly that this is not a clean bill of health');
});

test('out.warnings is exposed and copied (brief classifies auth vs outage from it)', async () => {
  const out = makeOut({ json: true, tty: false, command: 't', location: 'L', write: () => {}, writeErr: () => {} });
  out.warn('can\'t see invoices → HTTP 401', { degraded: true });
  assert.deepEqual(out.warnings, ["can't see invoices → HTTP 401"]);
  out.warnings.push('mutated');
  assert.equal(out.warnings.length, 1, 'getter must return a copy — callers cannot corrupt the real list');
});

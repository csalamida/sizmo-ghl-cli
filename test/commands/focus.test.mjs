// test/commands/focus.test.mjs — fixture-fed tests for the focus command.
// Verifies: run() returns 0, envelope has data.ranked + data.unknownValue,
// a high-₱ deal outranks a low-₱ one, unknown-value thread is in unknownValue not ranked.
import { test } from 'node:test';
import assert from 'node:assert';
import { run, collect } from '../../commands/focus.mjs';
import { makeOut } from '../../lib/output.mjs';
import { makeFakeCtx } from '../_helpers.mjs';
import { EXIT } from '../../lib/errors.mjs';

const NOW = 1_700_000_000_000;

// Inline all-paths http that returns one stuck deal + one unpaid invoice + one waiting thread
function makeHttp({ deal = true, invoice = true, thread = true } = {}) {
  const dealAge = 21; // days idle
  const invAge  = 104;
  const thrAge  = 3;

  return { get: async (path, opts = {}) => {
    // pipeline: stuck deal
    if (path === '/opportunities/pipelines') return { code:200, ok:true, j:{ pipelines:[{ id:'p1', name:'P', stages:[{id:'s1',name:'Lead'}] }] } };
    if (path === '/opportunities/search')    return { code:200, ok:true, j:{ opportunities: deal ? [{
      id:'o1', pipelineId:'p1', pipelineStageId:'s1', monetaryValue:50000,
      name:'Big Deal', contactId:'d1',
      updatedAt: new Date(NOW - dealAge * 86400000).toISOString(),
    }] : [] } };

    // receivables: one unpaid invoice
    if (path === '/invoices/')               return { code:200, ok:true, j:{ invoices: invoice ? [{
      _id:'inv1', invoiceNumber:'INV-001', status:'overdue', currency:'PHP',
      total:30000, amountPaid:0,
      contactDetails:{ name:'Owes Corp' },
      dueDate: new Date(NOW - invAge * 86400000).toISOString(),
    }] : [] } };

    // triage: one waiting thread
    if (path === '/conversations/search')    return { code:200, ok:true, j:{ conversations: thread ? [{
      id:'conv1', contactId:'t1', contactName:'WaitingPerson',
      unreadCount:2, lastMessageDate: NOW - thrAge * 86400000,
      lastMessageType:'TYPE_EMAIL',
    }] : [] } };
    if (path.startsWith('/conversations/') && path.endsWith('/messages')) return { code:200, ok:true, j:{ messages:{ messages:[] } } };

    // noshow: none
    if (path === '/calendars/')              return { code:200, ok:true, j:{ calendars:[] } };
    if (path === '/calendars/events')        return { code:200, ok:true, j:{ events:[] } };

    // booked-not-paid: no sessions
    if (path === '/payments/transactions')   return { code:200, ok:true, j:{ data:[] } };

    return { code:200, ok:true, j:{} };
  }};
}

function makeCtx(http, json = true) {
  let printed = '';
  const out = makeOut({ json, tty: false, command: 'test', location: 'L-TEST', write: s => printed += s, writeErr: () => {} });
  return { ctx: { http, cfg: { loc: 'L-TEST', tz: 'Asia/Manila', currency: null }, out, now: NOW }, getPrinted: () => printed };
}

test('focus: run returns 0', async () => {
  const { ctx } = makeCtx(makeHttp());
  const code = await run({}, ctx);
  assert.equal(code, 0);
});

test('focus: envelope has data.ranked and data.unknownValue', async () => {
  const { ctx, getPrinted } = makeCtx(makeHttp());
  await run({}, ctx);
  ctx.out.flush();
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.schemaVersion, 1);
  assert.ok(Array.isArray(envelope.data.ranked),       'data.ranked is array');
  assert.ok(Array.isArray(envelope.data.unknownValue), 'data.unknownValue is array');
});

test('focus: high-₱ deal outranks low-₱ one; unknown-value thread in unknownValue not ranked', async () => {
  const http = { get: async (path) => {
    if (path === '/opportunities/pipelines') return { code:200, ok:true, j:{ pipelines:[{ id:'p1', name:'P', stages:[{id:'s1',name:'Lead'}] }] } };
    if (path === '/opportunities/search')    return { code:200, ok:true, j:{ opportunities:[
      { id:'o1', pipelineId:'p1', pipelineStageId:'s1', monetaryValue:50000, name:'BigDeal',  contactId:'d1', updatedAt:new Date(NOW-21*86400000).toISOString() },
      { id:'o2', pipelineId:'p1', pipelineStageId:'s1', monetaryValue:5000,  name:'SmallDeal',contactId:'d2', updatedAt:new Date(NOW-40*86400000).toISOString() },
    ] } };
    if (path === '/invoices/')               return { code:200, ok:true, j:{ invoices:[] } };
    if (path === '/conversations/search')    return { code:200, ok:true, j:{ conversations:[
      { id:'conv1', contactId:'t1', contactName:'Thread', unreadCount:1, lastMessageDate:NOW-3*86400000, lastMessageType:'TYPE_EMAIL' },
    ] } };
    if (path.startsWith('/conversations/') && path.endsWith('/messages')) return { code:200, ok:true, j:{ messages:{ messages:[] } } };
    if (path === '/calendars/')              return { code:200, ok:true, j:{ calendars:[] } };
    if (path === '/payments/transactions')   return { code:200, ok:true, j:{ data:[] } };
    return { code:200, ok:true, j:{} };
  }};
  const { ctx, getPrinted } = makeCtx(http);
  await run({}, ctx);
  ctx.out.flush();
  const { data } = JSON.parse(getPrinted());

  // ranked: d1 (50k) must come before d2 (5k)
  const rankedContacts = data.ranked.map(x => x.contact);
  assert.ok(rankedContacts.includes('d1'), 'd1 in ranked');
  assert.ok(rankedContacts.includes('d2'), 'd2 in ranked');
  assert.ok(rankedContacts.indexOf('d1') < rankedContacts.indexOf('d2'), 'big deal outranks small deal');

  // waiting thread must be in unknownValue, NOT in ranked
  const uvContacts = data.unknownValue.map(x => x.contact);
  assert.ok(uvContacts.includes('t1'), 't1 in unknownValue');
  assert.ok(!rankedContacts.includes('t1'), 't1 NOT in ranked');
  // money:null for all unknownValue items
  for (const item of data.unknownValue) {
    assert.strictEqual(item.money, null, `${item.contact}: money must be null`);
  }
});

test('focus: empty account → both groups empty, returns 0', async () => {
  const http = { get: async (path) => {
    if (path === '/opportunities/pipelines') return { code:200, ok:true, j:{ pipelines:[] } };
    if (path === '/opportunities/search')    return { code:200, ok:true, j:{ opportunities:[] } };
    if (path === '/invoices/')               return { code:200, ok:true, j:{ invoices:[] } };
    if (path === '/conversations/search')    return { code:200, ok:true, j:{ conversations:[] } };
    if (path === '/calendars/')              return { code:200, ok:true, j:{ calendars:[] } };
    if (path === '/payments/transactions')   return { code:200, ok:true, j:{ data:[] } };
    return { code:200, ok:true, j:{} };
  }};
  const { ctx, getPrinted } = makeCtx(http);
  const code = await run({}, ctx);
  ctx.out.flush();
  assert.equal(code, 0);
  const { data } = JSON.parse(getPrinted());
  assert.deepEqual(data.ranked,       [], 'ranked is empty');
  assert.deepEqual(data.unknownValue, [], 'unknownValue is empty');
});

test('focus: collect() shape — has ranked, unknownValue, location', async () => {
  const { ctx } = makeCtx(makeHttp());
  const result = await collect({}, ctx);
  assert.ok(Array.isArray(result.ranked),       'ranked array');
  assert.ok(Array.isArray(result.unknownValue), 'unknownValue array');
  assert.ok(result.location,                    'location present');
});

// ── focus must not claim "all clear" while blind ─────────────────────────────
//
// Verified 2026-07-28: with every source returning 401, focus printed
//     Nothing to action — all clear. ✅
// and exited 0 — while its own --json envelope in the SAME run carried degraded:true and five
// warnings. One run, two contradictory answers, and the reassuring one is what a human reads.
//
// commands/brief.mjs already enforced this ("human render never says 'All clear' while degraded").
// focus had diverged. It was also missed by the earlier blind-exit sweep because it owns no
// fetches of its own — it composes other collects, whose failures arrive as degraded warnings
// rather than a `blocked` marker.

const blindCtx = (status) => {
  const made = makeFakeCtx({ json: false });
  made.ctx.http.get = async () => ({ code: status, ok: false, j: {}, txt: '' });
  made.ctx.ensureModel = async () => ({ entities: {} });
  return made;
};

// Assert on the POSITIVE claim only. A first probe of this used /all clear/i and reported a false
// positive against the corrective sentence, which itself contains the words "all clear".
const CLAIMS_ALL_CLEAR = /Nothing to action — all clear/;

test('focus: says "all clear" only when the account was actually readable', async () => {
  const { ctx, getPrinted } = blindCtx(401);
  await run({}, ctx);
  ctx.out.flush();
  const out = getPrinted();
  assert.ok(!CLAIMS_ALL_CLEAR.test(out),
    'focus claimed all-clear while every source was denied — that is a claim about the ACCOUNT, ' +
    'and it may only be made when the account could be read');
  assert.match(out, /could not read your account/,
    'and it must say plainly why nothing is shown');
});

test('focus: exits AUTH when denied everywhere and nothing surfaced', async () => {
  // `sizmo focus && echo "nothing urgent"` ran its second half while sizmo was blind.
  const { ctx } = blindCtx(401);
  assert.equal(await run({}, ctx), EXIT.AUTH);
});

test('focus: exits API on a total outage — not AUTH, the token is fine', async () => {
  const { ctx } = blindCtx(500);
  assert.equal(await run({}, ctx), EXIT.API);
});

test('focus: a healthy but genuinely quiet account still says all clear and exits 0', async () => {
  // The inverse guard. If this broke, every calm account would look broken and the warning would
  // stop meaning anything.
  const { ctx, getPrinted } = makeFakeCtx({ json: false });
  ctx.http.get = async () => ({ code: 200, ok: true, txt: '{}',
    j: { opportunities: [], invoices: [], conversations: [], events: [], contacts: [], data: [] } });
  ctx.ensureModel = async () => ({ entities: { pipelines: { items: [] }, calendars: { items: [] } } });

  const code = await run({}, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.match(getPrinted(), CLAIMS_ALL_CLEAR,
    'reads succeeded and there is genuinely nothing to act on — that IS all clear');
});

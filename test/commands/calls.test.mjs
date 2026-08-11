// test/commands/calls.test.mjs
//
// Every other surface in sizmo reports what HUMANS did. If an AI receptionist answers the phone,
// none of it sees that. `sizmo calls` answers the Monday question — how many calls did it take, and
// did any turn into a booking.
//
// VERIFICATION BOUNDARY, and it is the reason several tests below look defensive:
// the REQUEST is documented (describe_operation on get-call-logs gives every parameter and its
// constraints) and is pinned hard here. The RESPONSE shape is NOT documented and has not been
// observed against a live account — MCP is introspection-only in this repo, never execute_operation.
// So the command reads every field through a list of plausible spellings, and these tests exercise
// more than one spelling on purpose. If a real account shows different names, extend the lists; do
// not let a miss become a zero.
import { test } from 'node:test';
import assert from 'node:assert';
import { run } from '../../commands/calls.mjs';
import { makeFakeCtx } from '../_helpers.mjs';
import { EXIT } from '../../lib/errors.mjs';

const NOW = Date.parse('2026-08-11T12:00:00Z');
const DAY = 86400000;

const call = (id, hoursAgo, actions, dur, who) => ({
  id, agentId: 'ag1', contactId: 'ct_' + id, contactName: who, callType: 'LIVE',
  duration: dur, createdAt: NOW - hoursAgo * 3600000,
  actions: actions.map(t => ({ type: t })),
});
const DEFAULT_LOGS = [
  call('c1', 2, ['APPOINTMENT_BOOKING'], 214, 'Ana Cruz'),
  call('c2', 6, ['CALL_TRANSFER'], 95, 'Ben Tan'),
  call('c3', 20, [], 40, 'Cleo Ramos'),
  call('c4', 30, ['APPOINTMENT_BOOKING', 'SMS'], 180, 'Dan Lim'),
];

function mk({ json = true, logs = null, calls = DEFAULT_LOGS, agentsOk = true } = {}) {
  const h = makeFakeCtx({ json, now: NOW });
  h.seen = [];
  h.ctx.http.get = async (path, opts = {}) => {
    if (path.includes('/voice-ai/agents')) {
      return agentsOk
        ? { code: 200, ok: true, txt: '{}', j: { agents: [{ id: 'ag1', name: 'Reception' }] } }
        : { code: 403, ok: false, txt: 'no', j: null };
    }
    h.seen.push(opts.query);
    if (logs) return logs(opts.query.page);
    return { code: 200, ok: true, txt: '{}', j: { callLogs: calls } };
  };
  return h;
}
const data = (h) => JSON.parse(h.getPrinted()).data;

test('startDate and endDate are ALWAYS sent together', async () => {
  // Documented constraint: "Both startDate and endDate must be provided together." A lone bound is
  // rejected by the API, so a code path that omits one produces a 4xx no test of the output catches.
  const h = mk();
  await run({ days: 30 }, h.ctx);
  h.ctx.out.flush();
  const q = h.seen[0];
  assert.ok('startDate' in q && 'endDate' in q, 'the window must be sent as a pair');
  assert.equal(q.endDate, NOW);
  assert.equal(q.startDate, NOW - 30 * DAY);
  assert.ok(q.startDate < q.endDate, 'startDate must be less than endDate');
});

test('pageSize never exceeds the documented cap of 50', async () => {
  // Asking for more is a 4xx, not a bigger page.
  const h = mk();
  await run({ top: 500 }, h.ctx);
  h.ctx.out.flush();
  for (const q of h.seen) assert.ok(q.pageSize <= 50, `pageSize ${q.pageSize} exceeds the API cap of 50`);
});

test('paging is 1-based and stops on a short page', async () => {
  // There is no cursor, so a short page is the only end-of-data signal available.
  const pages = [];
  const h = mk({ logs: (page) => {
    pages.push(page);
    const full = Array.from({ length: 50 }, (_, i) => call(`p${page}-${i}`, 1, [], 10, 'X'));
    return { code: 200, ok: true, txt: '{}', j: { callLogs: page < 3 ? full : full.slice(0, 7) } };
  } });
  await run({ top: 1 }, h.ctx);
  h.ctx.out.flush();
  assert.deepEqual(pages, [1, 2, 3], 'must start at page 1 and stop once a page comes back short');
  assert.equal(data(h).calls, 107);
});

test('an unreadable dashboard is UNKNOWN — never "no calls"', async () => {
  // The worst way to be wrong here: telling someone their AI handled zero calls when the source
  // could not be read at all.
  const h = mk({ logs: () => ({ code: 500, ok: false, txt: 'boom', j: null }) });
  await assert.rejects(() => run({}, h.ctx), (e) => e.code === EXIT.API);
});

test('a scope failure names voice-ai-dashboard.readonly', async () => {
  const h = mk({ logs: () => ({ code: 403, ok: false, txt: 'no', j: null }) });
  await assert.rejects(() => run({}, h.ctx), (e) => {
    assert.equal(e.code, EXIT.AUTH);
    assert.match(e.remediation ?? '', /voice-ai-dashboard\.readonly/);
    return true;
  });
});

test('a location with no Voice AI says so, rather than reporting an error', async () => {
  // 404 here means the feature is not enabled — a fact about the account, not a fault in the tool.
  const h = mk({ logs: () => ({ code: 404, ok: false, txt: '', j: null }) });
  await assert.rejects(() => run({}, h.ctx), (e) => {
    assert.equal(e.code, EXIT.NOTFOUND);
    assert.match(e.message, /not available on this location/);
    return true;
  });
});

test('a page failing MID-scan makes the count a floor, not a total', async () => {
  const h = mk({ logs: (page) => page === 1
    ? { code: 200, ok: true, txt: '{}', j: { callLogs: Array.from({ length: 50 }, (_, i) => call(`a${i}`, 1, [], 10, 'X')) } }
    : { code: 500, ok: false, txt: 'boom', j: null } });
  await run({}, h.ctx);
  h.ctx.out.flush();
  const env = JSON.parse(h.getPrinted());
  assert.equal(env.data.calls, 50, 'the calls that WERE read must still be reported');
  assert.equal(env.degraded, true);
  assert.equal(env.data.truncated, true);
  assert.ok(env.warnings.some(w => /FLOOR/.test(w)));
});

test('outcomes are counted per CALL, not per action', async () => {
  // One call that books twice is one booking outcome. The question is "how many calls produced a
  // booking", not "how many booking events fired".
  const h = mk({ calls: [
    { id: 'x', agentId: 'ag1', createdAt: NOW - 3600000, duration: 60,
      actions: [{ type: 'APPOINTMENT_BOOKING' }, { type: 'APPOINTMENT_BOOKING' }] },
  ] });
  await run({}, h.ctx);
  h.ctx.out.flush();
  const d = data(h);
  assert.equal(d.calls, 1);
  assert.equal(d.booked, 1, 'two booking events on one call is still one call that booked');
  assert.equal(d.actionCounts.APPOINTMENT_BOOKING, 1);
});

test('duration carries its own denominator', async () => {
  // Averaging over calls whose duration could not be read would quietly understate it.
  const h = mk({ calls: [
    call('a', 1, [], 100, 'A'),
    { id: 'b', agentId: 'ag1', createdAt: NOW - 3600000, actions: [] },   // no duration field
  ] });
  await run({}, h.ctx);
  h.ctx.out.flush();
  const d = data(h);
  assert.equal(d.calls, 2);
  assert.equal(d.durationKnownFor, 1, 'the denominator must be the calls with a READABLE duration');
  assert.equal(d.totalDurationSec, 100);
});

test('no readable durations reports null, not zero', async () => {
  const h = mk({ calls: [{ id: 'a', agentId: 'ag1', createdAt: NOW - 3600000, actions: [] }] });
  await run({}, h.ctx);
  h.ctx.out.flush();
  assert.strictEqual(data(h).totalDurationSec, null, 'unknown duration must not render as 0 seconds');
});

test('unreadable agent NAMES degrade the report, they do not kill it', async () => {
  // Names are cosmetic; the call log is the answer. Losing the first must not lose the second.
  const h = mk({ agentsOk: false });
  await run({}, h.ctx);
  h.ctx.out.flush();
  const env = JSON.parse(h.getPrinted());
  assert.equal(env.data.calls, 4, 'the calls still reported');
  assert.equal(env.data.agentNamesBlocked, 403);
  assert.equal(env.degraded, true);
  assert.equal(Object.keys(env.data.byAgent)[0], 'ag1', 'falls back to the id when the name is unreadable');
});

test('agent names are used when readable', async () => {
  const h = mk();
  await run({}, h.ctx);
  h.ctx.out.flush();
  assert.ok('Reception' in data(h).byAgent, 'a readable agent name must replace the id');
});

test('--type is validated and forwarded', async () => {
  const ok = mk();
  await run({ type: 'live' }, ok.ctx);
  ok.ctx.out.flush();
  assert.equal(ok.seen[0].callType, 'LIVE', 'the filter must reach the request, upper-cased');

  const bad = mk();
  await assert.rejects(() => run({ type: 'blah' }, bad.ctx), (e) => e.code === EXIT.USAGE);
});

test('bad --days / --top are refused, never coerced', async () => {
  for (const [flag, v] of [['days', 0], ['days', -1], ['days', 2.5], ['top', 0], ['top', -3]]) {
    const h = mk();
    await assert.rejects(() => run({ [flag]: v }, h.ctx),
      (e) => e.code === EXIT.USAGE, `--${flag} ${v} was accepted`);
    assert.equal(h.seen.length, 0, `--${flag} ${v} reached the API`);
  }
});

test('--top limits the listed calls but not the counts', async () => {
  const h = mk();
  await run({ top: 2 }, h.ctx);
  h.ctx.out.flush();
  const d = data(h);
  assert.equal(d.shown, 2);
  assert.equal(d.callsList.length, 2);
  assert.equal(d.calls, 4, 'the total must not shrink to the display limit');
});

test('an alternative response spelling is still read — the defensive accessors', async () => {
  // The response shape is unverified. `logs` instead of `callLogs`, `_id` instead of `id`, an ISO
  // string instead of an epoch, and a bare string action rather than {type}.
  const h = mk({ logs: () => ({ code: 200, ok: true, txt: '{}', j: { logs: [{
    _id: 'z1', agent: { id: 'ag1' }, startedAt: new Date(NOW - 3600000).toISOString(),
    durationSec: 42, actionTypes: ['APPOINTMENT_BOOKING'], contact: { name: 'Zoe' },
  }] } }) });
  await run({}, h.ctx);
  h.ctx.out.flush();
  const d = data(h);
  assert.equal(d.calls, 1);
  assert.equal(d.booked, 1, 'a bare-string action type must still count');
  assert.equal(d.callsList[0].id, 'z1');
  assert.equal(d.callsList[0].durationSec, 42);
  assert.ok(d.callsList[0].startedAt, 'an ISO start time must parse');
});

test('a quiet window says no calls — the inverse guard', async () => {
  // Over-correcting into "cannot tell" on every empty week would make the degraded signal useless.
  const h = mk({ json: false, calls: [] });
  await run({}, h.ctx);
  h.ctx.out.flush();
  const out = h.getPrinted();
  assert.match(out, /No Voice AI calls in the last 7d/);
  assert.ok(!/NOT the same as/.test(out), 'a healthy empty week was reported as unreadable');
});

test('calls never writes', async () => {
  const h = mk();
  let wrote = 0;
  for (const m of ['post', 'put', 'delete']) h.ctx.http[m] = async () => { wrote++; return { code: 200, ok: true, j: {} }; };
  h.ctx.confirmed = true;
  const code = await run({}, h.ctx);
  h.ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(wrote, 0);
});

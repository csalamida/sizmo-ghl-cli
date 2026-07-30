// test/commands/appointment-list.test.mjs
//
// Every calendar read in this tool ended its window at NOW. `noshow` and `booked-not-paid` both ask
// /calendars/events for `endTime: NOW`, because both look backwards at what already happened. The
// consequence: NO command could return an appointment in the future. You could book one with
// `sizmo appointment book` and then have no way to see it. The tool was forward-blind.
//
// The endpoint supports a forward window fine — nothing was blocked, the query was just never asked.
// This uses the identical request noshow makes with the window pointed the other way.
import { test } from 'node:test';
import assert from 'node:assert';
import { run } from '../../commands/appointment.mjs';
import { makeFakeCtx } from '../_helpers.mjs';
import { EXIT } from '../../lib/errors.mjs';

const NOW = Date.parse('2026-07-30T09:00:00Z');
const DAY = 86400000;
const ev = (id, dayOffset, name, status = 'confirmed') => ({
  id, contactId: 'ct_' + id, contactName: name, appointmentStatus: status, title: 'Session',
  startTime: new Date(NOW + dayOffset * DAY).toISOString(),
  endTime: new Date(NOW + dayOffset * DAY + 3600000).toISOString(),
});
const CALS = [{ id: 'cal1', name: 'Intro Call' }, { id: 'cal2', name: 'Coaching' }];

function harness({ json = true, cals = CALS, events = () => [], evResponse = null } = {}) {
  const { ctx, getPrinted } = makeFakeCtx({ json, now: NOW });
  const seen = [];
  ctx.ensureModel = async () => ({ entities: { calendars: { items: cals } } });
  ctx.http.get = async (path, opts = {}) => {
    if (!path.includes('/calendars/events')) return { code: 200, ok: true, txt: '{}', j: {} };
    seen.push(opts.query);
    if (evResponse) return evResponse(opts.query.calendarId);
    return { code: 200, ok: true, txt: '{}', j: { events: events(opts.query.calendarId) } };
  };
  return { ctx, getPrinted, seen };
}
const data = (h) => JSON.parse(h.getPrinted()).data;

test('the window looks FORWARD — the whole point', async () => {
  // noshow asks for endTime: NOW. This must ask for startTime: NOW. If this assertion ever flips,
  // the tool is forward-blind again and no test of the output alone would notice.
  const h = harness();
  await run({ _: ['list'] }, h.ctx);
  h.ctx.out.flush();
  assert.ok(h.seen.length, 'no calendar was queried');
  for (const q of h.seen) {
    assert.equal(Number(q.startTime), NOW, 'the window must START now, not end now');
    assert.equal(Number(q.endTime), NOW + 14 * DAY, 'the default window is 14 days ahead');
    assert.ok(Number(q.endTime) > Number(q.startTime), 'the window must point forwards');
  }
});

test('--days moves the far edge of the window, not the near one', async () => {
  const h = harness();
  await run({ _: ['list'], days: 30 }, h.ctx);
  h.ctx.out.flush();
  assert.equal(Number(h.seen[0].startTime), NOW);
  assert.equal(Number(h.seen[0].endTime), NOW + 30 * DAY);
});

test('a past appointment is excluded even if the server returns it', async () => {
  // The local check is authoritative. Trusting the server window alone would put yesterday's session
  // in a list titled UPCOMING.
  const h = harness({ events: () => [ev('past', -2, 'Yesterday'), ev('soon', 1, 'Tomorrow')] });
  await run({ _: ['list'] }, h.ctx);
  h.ctx.out.flush();
  const ids = data(h).appointments.map(a => a.id);
  assert.ok(!ids.includes('past'), 'a past appointment appeared in an upcoming list');
  assert.ok(ids.includes('soon'));
});

test('a cancelled appointment is not upcoming', async () => {
  // Scoped to ONE calendar. A bare `() => [...]` returns the same events for BOTH fixture calendars,
  // so the first draft asserted ['live'] and got ['live','live'] — a test bug, not a code bug.
  const h = harness({ events: (cid) => cid === 'cal1' ? [
    ev('live', 2, 'Real'), ev('dead', 3, 'Cancelled', 'cancelled'), ev('void', 4, 'Invalid', 'invalid'),
  ] : [] });
  await run({ _: ['list'] }, h.ctx);
  h.ctx.out.flush();
  assert.deepEqual(data(h).appointments.map(a => a.id), ['live']);
});

test('soonest first — the only ordering that answers "what is next?"', async () => {
  const h = harness({ events: (cid) => cid === 'cal1'
    ? [ev('c', 5, 'Later'), ev('a', 0, 'Today')]
    : [ev('b', 2, 'Middle')] });
  await run({ _: ['list'] }, h.ctx);
  h.ctx.out.flush();
  assert.deepEqual(data(h).appointments.map(a => a.id), ['a', 'b', 'c']);
});

test('every row carries the id cancel and update need', async () => {
  const h = harness({ events: (cid) => cid === 'cal1' ? [ev('a1', 1, 'Ana')] : [] });
  await run({ _: ['list'] }, h.ctx);
  h.ctx.out.flush();
  const a = data(h).appointments[0];
  assert.equal(a.id, 'a1');
  assert.equal(a.calendar, 'Intro Call', 'which calendar it is on must be visible');
  assert.equal(a.contactId, 'ct_a1');
  assert.equal(a.inDays, 1);
});

test('an unreadable calendar is UNKNOWN, never a clear week', async () => {
  // The dangerous failure: "0 upcoming" when one calendar 403s reads as "your week is free".
  const h = harness({ cals: [{ id: 'cal1', name: 'Intro' }],
    evResponse: () => ({ code: 403, ok: false, txt: 'no', j: null }) });
  await run({ _: ['list'] }, h.ctx);
  h.ctx.out.flush();
  const env = JSON.parse(h.getPrinted());
  assert.equal(env.data.upcoming, 0);
  assert.equal(env.degraded, true, 'a blind read reported itself as a complete answer');
  assert.equal(env.data.truncated, true);
  assert.equal(env.data.unreadableCalendars, 1);
  assert.ok(env.warnings.some(w => /unreadable/.test(w) && /NOT included/.test(w)));
});

test('the TTY says so too when a calendar could not be read', async () => {
  const h = harness({ json: false, cals: [{ id: 'cal1', name: 'Intro' }],
    evResponse: () => ({ code: 500, ok: false, txt: 'boom', j: null }) });
  await run({ _: ['list'] }, h.ctx);
  h.ctx.out.flush();
  assert.match(h.getPrinted(), /not a clear week/,
    'an empty result built from an unreadable calendar must not read as "nothing booked"');
});

test('a genuinely empty week says nothing booked — the inverse guard', async () => {
  // The over-correction: warning on every quiet week would make the signal meaningless.
  const h = harness({ json: false, events: () => [] });
  await run({ _: ['list'] }, h.ctx);
  h.ctx.out.flush();
  const out = h.getPrinted();
  assert.match(out, /Nothing booked in the next 14d/);
  assert.ok(!/not a clear week/.test(out), 'a healthy empty result was flagged as incomplete');
  const h2 = harness({ events: () => [] });
  await run({ _: ['list'] }, h2.ctx);
  h2.ctx.out.flush();
  assert.equal(JSON.parse(h2.getPrinted()).degraded, false);
});

test('a calendar at the event cap warns that later appointments may be missing', async () => {
  // /calendars/events has no pagination cursor, so there is no way to page past 100.
  const h = harness({ events: () => Array.from({ length: 100 }, (_, i) => ev('e' + i, 1, 'P' + i)) });
  await run({ _: ['list'] }, h.ctx);
  h.ctx.out.flush();
  const env = JSON.parse(h.getPrinted());
  assert.equal(env.degraded, true);
  assert.ok(env.warnings.some(w => /no pagination cursor/.test(w)));
  assert.equal(env.data.truncated, true);
});

test('--top limits rows shown but not the count reported', async () => {
  const h = harness({ events: (cid) => cid === 'cal1'
    ? Array.from({ length: 6 }, (_, i) => ev('e' + i, i + 1, 'P' + i)) : [] });
  await run({ _: ['list'], top: 2 }, h.ctx);
  h.ctx.out.flush();
  const d = data(h);
  assert.equal(d.shown, 2);
  assert.equal(d.upcoming, 6, 'the count must not shrink to the display limit');
});

test('bad --days / --top are refused, never coerced', async () => {
  for (const [flag, bad] of [['days', 0], ['days', -1], ['days', 2.5], ['top', 0], ['top', -4]]) {
    const h = harness();
    await assert.rejects(() => run({ _: ['list'], [flag]: bad }, h.ctx),
      (e) => e.code === EXIT.USAGE, `--${flag} ${bad} was accepted`);
    assert.equal(h.seen.length, 0, `--${flag} ${bad} reached the API`);
  }
});

test('no calendars at all is a clear answer, not an error', async () => {
  const h = harness({ cals: [] });
  const code = await run({ _: ['list'] }, h.ctx);
  h.ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(data(h).calendars, 0);
  assert.deepEqual(data(h).appointments, []);
});

test('calendars are fetched concurrently, capped at the shared limit of 5', async () => {
  // Matches noshow and booked-not-paid. Sequential would scale with calendar count; unbounded would
  // get the account rate-limited.
  let inFlight = 0, maxInFlight = 0;
  const { ctx, getPrinted } = makeFakeCtx({ json: true, now: NOW });
  ctx.ensureModel = async () => ({ entities: { calendars: { items: Array.from({ length: 12 }, (_, i) => ({ id: 'c' + i, name: 'C' + i })) } } });
  let release; const gate = new Promise(r => { release = r; });
  const timer = setTimeout(() => release?.(), 250);
  ctx.http.get = async (path) => {
    if (!path.includes('/calendars/events')) return { code: 200, ok: true, txt: '{}', j: {} };
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    if (inFlight >= 5) release?.();
    await gate;
    inFlight--;
    return { code: 200, ok: true, txt: '{}', j: { events: [] } };
  };
  await run({ _: ['list'] }, ctx);
  ctx.out.flush();
  clearTimeout(timer);
  assert.ok(maxInFlight > 1, `calendars were fetched one at a time (maxConcurrent=${maxInFlight})`);
  assert.ok(maxInFlight <= 5, `fan-out reached ${maxInFlight}, above the shared cap of 5`);
});

test('list never sends a write, even with --confirm', async () => {
  const h = harness({ events: () => [ev('a1', 1, 'Ana')] });
  let wrote = 0;
  for (const m of ['post', 'put', 'delete']) h.ctx.http[m] = async () => { wrote++; return { code: 200, ok: true, j: {} }; };
  h.ctx.confirmed = true;
  const code = await run({ _: ['list'] }, h.ctx);
  h.ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(wrote, 0, 'listing issued a write request');
});

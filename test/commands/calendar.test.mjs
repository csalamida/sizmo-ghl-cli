// test/commands/calendar.test.mjs — calendar create + single-target delete (confirm-gated).
import { test } from 'node:test';
import assert from 'node:assert';
import { run } from '../../commands/calendar.mjs';
import { makeFakeCtx } from '../_helpers.mjs';
import { EXIT } from '../../lib/errors.mjs';

test('calendar create: no --confirm → CONFIRM (5), no write fired', async () => {
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ confirmed: false });
  const code = await run({ _: ['create'], name: 'Discovery Calls' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.CONFIRM);
  assert.equal(getCalledWrites().length, 0);
  assert.ok(JSON.parse(getPrinted()).data.changes.some(c => /Create calendar "Discovery Calls"/.test(c)));
});

test('calendar create: --confirm → POST /calendars/ fires once, exit 0', async () => {
  const fixture = { 'POST /calendars/': { status: 200, j: { calendar: { id: 'cal-1', name: 'Discovery Calls' } } } };
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ confirmed: true, fixture });
  const code = await run({ _: ['create'], name: 'Discovery Calls' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(getCalledWrites().filter(w => w.startsWith('POST /calendars/')).length, 1);
  const d = JSON.parse(getPrinted()).data;
  assert.equal(d.calendarId, 'cal-1'); assert.equal(d.name, 'Discovery Calls');
});

test('calendar create: no --name → USAGE', async () => {
  const { ctx } = makeFakeCtx({ confirmed: true });
  await assert.rejects(() => run({ _: ['create'] }, ctx), /needs --name/i);
});

test('calendar create: 401 → AUTH + calendars.write guidance', async () => {
  const fixture = { 'POST /calendars/': { status: 401, j: {} } };
  const { ctx } = makeFakeCtx({ confirmed: true, fixture });
  await assert.rejects(() => run({ _: ['create'], name: 'X' }, ctx),
    (e) => { assert.equal(e.code, EXIT.AUTH); assert.match(e.message, /calendars\.write/); return true; });
});

test('calendar delete: no id → USAGE (never bulk)', async () => {
  const { ctx } = makeFakeCtx({ confirmed: true });
  await assert.rejects(() => run({ _: ['delete'] }, ctx), /exactly one id/i);
});

test('calendar delete: wrong id → NOTFOUND, nothing deleted', async () => {
  const fixture = { 'GET /calendars/nope': { status: 404, j: {} } };
  const { ctx, getCalledWrites } = makeFakeCtx({ confirmed: true, fixture });
  await assert.rejects(() => run({ _: ['delete', 'nope'] }, ctx),
    (e) => { assert.equal(e.code, EXIT.NOTFOUND); return true; });
  assert.equal(getCalledWrites().filter(w => w.startsWith('DELETE')).length, 0, 'no DELETE on a bad id');
});

test('calendar delete: --confirm → fetch-then-delete, names it, single DELETE', async () => {
  const fixture = {
    'GET /calendars/cal-9': { status: 200, j: { calendar: { id: 'cal-9', name: 'Demos' } } },
    'DELETE /calendars/cal-9': { status: 200, j: { message: 'calendar deleted' } },
  };
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ confirmed: true, fixture });
  const code = await run({ _: ['delete', 'cal-9'] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.deepEqual(getCalledWrites().filter(w => w.startsWith('DELETE')), ['DELETE /calendars/cal-9']);
  assert.equal(JSON.parse(getPrinted()).data.name, 'Demos');
});

test('calendar delete: no --confirm → CONFIRM (5), names the target, no DELETE', async () => {
  const fixture = { 'GET /calendars/cal-9': { status: 200, j: { calendar: { id: 'cal-9', name: 'Demos' } } } };
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ confirmed: false, fixture });
  const code = await run({ _: ['delete', 'cal-9'] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.CONFIRM);
  assert.equal(getCalledWrites().filter(w => w.startsWith('DELETE')).length, 0);
  assert.ok(JSON.parse(getPrinted()).data.changes.some(c => /Delete calendar "Demos"/.test(c)));
});

test('calendar: unknown subcommand → USAGE', async () => {
  const { ctx } = makeFakeCtx({ confirmed: true });
  await assert.rejects(() => run({ _: ['frobnicate'] }, ctx), /usage/i);
});

test('calendar create: --team-member sends teamMembers in body', async () => {
  const fixture = { 'POST /calendars/': { status: 200, j: { calendar: { id: 'cal-2', name: 'Round Robin' } } } };
  const { ctx, getPrinted, getCalledBodies } = makeFakeCtx({ confirmed: true, fixture });
  const code = await run({ _: ['create'], name: 'Round Robin', type: 'round_robin', 'team-member': 'uid-a,uid-b' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  const body = getCalledBodies()[0].body;
  assert.deepEqual(body.teamMembers, [{ userId: 'uid-a' }, { userId: 'uid-b' }]);
  assert.equal(body.calendarType, 'round_robin');
});

test('calendar create: --team-member shows in changes preview', async () => {
  const { ctx, getPrinted } = makeFakeCtx({ confirmed: false });
  const code = await run({ _: ['create'], name: 'RR Cal', type: 'round_robin', 'team-member': 'uid-a' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.CONFIRM);
  const changes = JSON.parse(getPrinted()).data.changes;
  assert.ok(changes.some(c => /team members: uid-a/.test(c)));
});

test('calendar create: round_robin without --team-member → USAGE', async () => {
  const { ctx } = makeFakeCtx({ confirmed: true });
  await assert.rejects(
    () => run({ _: ['create'], name: 'RR', type: 'round_robin' }, ctx),
    (e) => { assert.equal(e.code, EXIT.USAGE); assert.match(e.message, /team member/i); return true; },
  );
});

test('calendar create: collective without --team-member → USAGE', async () => {
  const { ctx } = makeFakeCtx({ confirmed: true });
  await assert.rejects(
    () => run({ _: ['create'], name: 'Group', type: 'collective' }, ctx),
    (e) => { assert.equal(e.code, EXIT.USAGE); assert.match(e.message, /team member/i); return true; },
  );
});

test('calendar create: event type without --team-member is fine (no validation error)', async () => {
  const fixture = { 'POST /calendars/': { status: 200, j: { calendar: { id: 'cal-3', name: 'Events' } } } };
  const { ctx } = makeFakeCtx({ confirmed: true, fixture });
  const code = await run({ _: ['create'], name: 'Events', type: 'event' }, ctx);
  assert.equal(code, EXIT.OK);
});

test('calendar create: GHL "No team member found" 422 → API error with --team-member hint', async () => {
  const fixture = { 'POST /calendars/': { status: 422, j: { message: 'No team member found' } } };
  const { ctx } = makeFakeCtx({ confirmed: true, fixture });
  await assert.rejects(
    () => run({ _: ['create'], name: 'RR', type: 'round_robin', 'team-member': 'uid-x' }, ctx),
    (e) => {
      assert.equal(e.code, EXIT.API);
      assert.match(e.remediation ?? '', /team-member/);
      return true;
    },
  );
});

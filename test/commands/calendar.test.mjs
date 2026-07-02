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

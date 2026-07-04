// test/commands/appointment.test.mjs
// Tests appointment book / cancel.
// Calendar name→id resolution via injected model. Unknown name → exit 3.
// No-confirm → exit 5 (CONFIRM) + envelope, no write fired.
// --confirm → write fires once, exit 0.
// 401/403 → exit 3.
// --dry-run → dry_run, no write.
import { test } from 'node:test';
import assert from 'node:assert';
import { run } from '../../commands/appointment.mjs';
import { makeFakeCtx } from '../_helpers.mjs';
import { EXIT } from '../../lib/errors.mjs';

const APPT_ID = 'appt-abc-001';
const CONTACT = 'cid-appt-001';
const START = '2026-07-01T10:00:00Z';

// Minimal model with one calendar
const MODEL = {
  schemaVersion: 1,
  locationId: 'L-TEST',
  syncedAt: 1_700_000_000_000,
  entities: {
    calendars: {
      fetchedAt: 1_700_000_000_000,
      items: [{ id: 'cal-001', name: 'Coaching Calls' }],
    },
  },
};

// ── book — no --confirm ───────────────────────────────────────────────────────

test('appointment book: no --confirm → exit 4 + envelope, no write fired', async () => {
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ confirmed: false, model: MODEL });
  const code = await run({ _: ['book'], calendar: 'Coaching Calls', contact: CONTACT, start: START }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.CONFIRM, 'exit must be CONFIRM (5)');
  assert.equal(getCalledWrites().length, 0, 'no write without --confirm');
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.data.status, 'confirmation_required');
  assert.ok(envelope.data.changes.some(c => /Coaching Calls/.test(c)));
  assert.ok(envelope.data.changes.some(c => c.includes(CONTACT)));
  assert.ok(envelope.data.changes.some(c => c.includes(START)));
  assert.ok(envelope.data.confirmCommand.includes('--confirm'));
});

// ── book — --confirm → write fires ───────────────────────────────────────────

test('appointment book: --confirm → POST fires once, exit 0', async () => {
  const fixture = { 'POST /calendars/events/appointments': { status: 200, j: { id: APPT_ID } } };
  const { ctx, getCalledWrites } = makeFakeCtx({ confirmed: true, model: MODEL, fixture });
  const code = await run({ _: ['book'], calendar: 'Coaching Calls', contact: CONTACT, start: START }, ctx);
  assert.equal(code, EXIT.OK);
  assert.equal(getCalledWrites().filter(w => w.startsWith('POST')).length, 1);
});

test('appointment book: request body includes locationId — verified live, GHL 400s "Location ID is required" without it', async () => {
  const fixture = { 'POST /calendars/events/appointments': { status: 200, j: { id: APPT_ID } } };
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, loc: 'L-TEST', model: MODEL, fixture });
  await run({ _: ['book'], calendar: 'Coaching Calls', contact: CONTACT, start: START }, ctx);
  const body = getCalledBodies().find(b => b.method === 'POST').body;
  assert.equal(body.locationId, 'L-TEST');
  assert.equal(body.calendarId, 'cal-001');
  assert.equal(body.contactId, CONTACT);
  assert.equal(body.startTime, START);
});

// ── book — unknown calendar ───────────────────────────────────────────────────

test('appointment book: unknown calendar → exit NOTFOUND', async () => {
  const { ctx } = makeFakeCtx({ confirmed: false, model: MODEL });
  await assert.rejects(
    () => run({ _: ['book'], calendar: 'Mystery Calendar', contact: CONTACT, start: START }, ctx),
    (e) => { assert.equal(e.code, EXIT.NOTFOUND); assert.ok(/unknown calendar/i.test(e.message)); return true; }
  );
});

// ── book — invalid start ───────────────────────────────────────────────────────

test('appointment book: invalid --start → USAGE error', async () => {
  const { ctx } = makeFakeCtx({ confirmed: false, model: MODEL });
  await assert.rejects(
    () => run({ _: ['book'], calendar: 'Coaching Calls', contact: CONTACT, start: 'not-a-date' }, ctx),
    /invalid.*--start|--start.*invalid/i
  );
});

// ── book — 401/403 scope floor ────────────────────────────────────────────────

test('appointment book: 401 → exit AUTH + scope message', async () => {
  const fixture = { 'POST /calendars/events/appointments': { status: 401, j: {} } };
  const { ctx } = makeFakeCtx({ confirmed: true, model: MODEL, fixture });
  await assert.rejects(
    () => run({ _: ['book'], calendar: 'Coaching Calls', contact: CONTACT, start: START }, ctx),
    (e) => { assert.equal(e.code, EXIT.AUTH); assert.ok(/calendars\.write/.test(e.message)); return true; }
  );
});

test('appointment book: 403 → exit AUTH', async () => {
  const fixture = { 'POST /calendars/events/appointments': { status: 403, j: {} } };
  const { ctx } = makeFakeCtx({ confirmed: true, model: MODEL, fixture });
  await assert.rejects(
    () => run({ _: ['book'], calendar: 'Coaching Calls', contact: CONTACT, start: START }, ctx),
    (e) => { assert.equal(e.code, EXIT.AUTH); return true; }
  );
});

// ── book — --dry-run ──────────────────────────────────────────────────────────

test('appointment book: --dry-run → status dry_run, no write, exit 0', async () => {
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ dryRun: true, model: MODEL });
  const code = await run({ _: ['book'], calendar: 'Coaching Calls', contact: CONTACT, start: START }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(getCalledWrites().length, 0);
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.data.status, 'dry_run');
});

// ── cancel — no --confirm ─────────────────────────────────────────────────────

test('appointment cancel: no --confirm → exit 4, no write fired', async () => {
  const { ctx, getCalledWrites } = makeFakeCtx({ confirmed: false });
  const code = await run({ _: ['cancel', APPT_ID] }, ctx);
  assert.equal(code, EXIT.CONFIRM);
  assert.equal(getCalledWrites().length, 0);
});

// ── cancel — --confirm → write fires ─────────────────────────────────────────

test('appointment cancel: --confirm → DELETE fires once, exit 0', async () => {
  const fixture = { [`DELETE /calendars/events/appointments/${APPT_ID}`]: { status: 200, j: {} } };
  const { ctx, getCalledWrites } = makeFakeCtx({ confirmed: true, fixture });
  const code = await run({ _: ['cancel', APPT_ID] }, ctx);
  assert.equal(code, EXIT.OK);
  assert.equal(getCalledWrites().filter(w => w.startsWith('DELETE')).length, 1);
});

// ── cancel — scope floor ──────────────────────────────────────────────────────

test('appointment cancel: 401 → exit AUTH', async () => {
  const fixture = { [`DELETE /calendars/events/appointments/${APPT_ID}`]: { status: 401, j: {} } };
  const { ctx } = makeFakeCtx({ confirmed: true, fixture });
  await assert.rejects(
    () => run({ _: ['cancel', APPT_ID] }, ctx),
    (e) => { assert.equal(e.code, EXIT.AUTH); assert.ok(/calendars\.write/.test(e.message)); return true; }
  );
});

// ── cancel — --dry-run ────────────────────────────────────────────────────────

test('appointment cancel: --dry-run → status dry_run, no write, exit 0', async () => {
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ dryRun: true });
  const code = await run({ _: ['cancel', APPT_ID] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(getCalledWrites().length, 0);
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.data.status, 'dry_run');
});

// ── usage errors ──────────────────────────────────────────────────────────────

test('appointment: no subcommand → USAGE error', async () => {
  const { ctx } = makeFakeCtx();
  await assert.rejects(() => run({ _: [] }, ctx), /usage/i);
});

test('appointment book: missing --calendar → USAGE error', async () => {
  const { ctx } = makeFakeCtx({ model: MODEL });
  await assert.rejects(() => run({ _: ['book'], contact: CONTACT, start: START }, ctx), /--calendar/i);
});

test('appointment cancel: missing apptId → USAGE error', async () => {
  const { ctx } = makeFakeCtx();
  await assert.rejects(() => run({ _: ['cancel'] }, ctx), /usage/i);
});

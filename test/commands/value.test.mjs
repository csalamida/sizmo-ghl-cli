// test/commands/value.test.mjs — create custom value (confirm-gated).
import { test } from 'node:test';
import assert from 'node:assert';
import { run } from '../../commands/value.mjs';
import { makeFakeCtx } from '../_helpers.mjs';
import { EXIT } from '../../lib/errors.mjs';

const PATH = 'POST /locations/L-TEST/customValues';

test('value create: --confirm → POST customValues fires once, exit 0', async () => {
  const fixture = { [PATH]: { status: 200, j: { customValue: { id: 'v-1' } } } };
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ confirmed: true, fixture });
  const code = await run({ _: ['create'], name: 'Booking Link', value: 'https://cal.me/x' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(getCalledWrites().filter(w => w === PATH).length, 1);
  assert.equal(JSON.parse(getPrinted()).data.valueId, 'v-1');
});

test('value create: no --confirm → CONFIRM (5), no write', async () => {
  const { ctx, getCalledWrites } = makeFakeCtx({ confirmed: false });
  const code = await run({ _: ['create'], name: 'X', value: 'y' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.CONFIRM);
  assert.equal(getCalledWrites().length, 0);
});

test('value create: missing --value → USAGE', async () => {
  const { ctx } = makeFakeCtx({ confirmed: true });
  await assert.rejects(() => run({ _: ['create'], name: 'X' }, ctx), /--value/i);
});

test('value create: missing --name → USAGE', async () => {
  const { ctx } = makeFakeCtx({ confirmed: true });
  await assert.rejects(() => run({ _: ['create'], value: 'y' }, ctx), /--name/i);
});

test('value create: 401 → AUTH + customValues.write guidance', async () => {
  const fixture = { [PATH]: { status: 401, j: {} } };
  const { ctx } = makeFakeCtx({ confirmed: true, fixture });
  await assert.rejects(() => run({ _: ['create'], name: 'X', value: 'y' }, ctx),
    (e) => { assert.equal(e.code, EXIT.AUTH); assert.match(e.message, /customValues\.write/); return true; });
});

// ── delete (single-target) ─────────────────────────────────────────────────────
const listFixture = { 'GET /locations/L-TEST/customValues': { status: 200, j: { customValues: [{ id: 'v-1', name: 'Booking Link' }] } } };

test('value delete: no id → USAGE (never bulk)', async () => {
  const { ctx } = makeFakeCtx({ confirmed: true });
  await assert.rejects(() => run({ _: ['delete'] }, ctx),
    (e) => { assert.equal(e.code, EXIT.USAGE); assert.match(e.message, /one id, never bulk/i); return true; });
});

test('value delete: unknown id → NOTFOUND, no DELETE', async () => {
  const { ctx, getCalledWrites } = makeFakeCtx({ confirmed: true, fixture: listFixture });
  await assert.rejects(() => run({ _: ['delete', 'v-NOPE'] }, ctx),
    (e) => { assert.equal(e.code, EXIT.NOTFOUND); return true; });
  assert.equal(getCalledWrites().length, 0);
});

test('value delete: --confirm → one single-resource DELETE, exit 0', async () => {
  const fixture = { ...listFixture, 'DELETE /locations/L-TEST/customValues/v-1': { status: 200, j: {} } };
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ confirmed: true, fixture });
  const code = await run({ _: ['delete', 'v-1'] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.deepEqual(getCalledWrites().filter(w => w.startsWith('DELETE')), ['DELETE /locations/L-TEST/customValues/v-1']);
  assert.equal(JSON.parse(getPrinted()).data.name, 'Booking Link');
});

// ── value update (2026-07-27) ────────────────────────────────────────────────
// sizmo had create + delete only, and the docs stated that as if it were an API limitation. It was
// not: PUT /locations/{loc}/customValues/{id} exists and needs the same scope create already uses.
// Editing a value meant delete-then-create, which mints a NEW id, breaks anything referencing the
// old one, and leaves a window where the value does not exist — a destructive workaround for an edit.

const VAL_ID = 'val-001';
const GET_URL = `GET /locations/L-TEST/customValues/${VAL_ID}`;
const PUT_URL = `PUT /locations/L-TEST/customValues/${VAL_ID}`;
const current = { status: 200, j: { customValue: { id: VAL_ID, name: 'Booking Link', value: 'https://old.link' } } };

test('value update: --value alone keeps the existing name (endpoint requires both)', async () => {
  // The endpoint requires name AND value. Without fetch-first, sending only --value would blank
  // the name — the exact silent-data-loss shape the upsert tag-merge bug had.
  const { ctx, getCalledBodies } = makeFakeCtx({
    confirmed: true, fixture: { [GET_URL]: current, [PUT_URL]: { status: 200, j: {} } },
  });
  await run({ _: ['update', VAL_ID], value: 'https://new.link' }, ctx);
  ctx.out.flush();
  const wrote = getCalledBodies().find(b => b.method === 'PUT');
  assert.equal(wrote.body.name, 'Booking Link', 'existing name must be preserved, not blanked');
  assert.equal(wrote.body.value, 'https://new.link');
});

test('value update: --name alone keeps the existing value', async () => {
  const { ctx, getCalledBodies } = makeFakeCtx({
    confirmed: true, fixture: { [GET_URL]: current, [PUT_URL]: { status: 200, j: {} } },
  });
  await run({ _: ['update', VAL_ID], name: 'Consult Link' }, ctx);
  ctx.out.flush();
  const wrote = getCalledBodies().find(b => b.method === 'PUT');
  assert.equal(wrote.body.name, 'Consult Link');
  assert.equal(wrote.body.value, 'https://old.link', 'existing value must be preserved');
});

test('value update: preview shows before → after, not just the new state', async () => {
  const { ctx, getPrinted } = makeFakeCtx({ fixture: { [GET_URL]: current } });
  const code = await run({ _: ['update', VAL_ID], value: 'https://new.link' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.CONFIRM);
  const changes = JSON.parse(getPrinted()).data.changes.join('\n');
  assert.match(changes, /https:\/\/old\.link/, 'must show what is being replaced');
  assert.match(changes, /https:\/\/new\.link/);
});

test('value update: a no-op edit is called out rather than silently applied', async () => {
  const { ctx, getPrinted } = makeFakeCtx({ fixture: { [GET_URL]: current } });
  await run({ _: ['update', VAL_ID], value: 'https://old.link' }, ctx);
  ctx.out.flush();
  assert.match(JSON.parse(getPrinted()).data.changes.join('\n'), /nothing actually differs/);
});

test('value update: no id → USAGE, nothing fetched or written', async () => {
  const { ctx, getCalledPaths } = makeFakeCtx({ confirmed: true });
  await assert.rejects(() => run({ _: ['update'], value: 'x' }, ctx), (e) => e.code === EXIT.USAGE);
  assert.equal(getCalledPaths().length, 0);
});

test('value update: neither --name nor --value → USAGE, nothing fetched', async () => {
  const { ctx, getCalledPaths } = makeFakeCtx({ confirmed: true });
  await assert.rejects(() => run({ _: ['update', VAL_ID] }, ctx), (e) => e.code === EXIT.USAGE);
  assert.equal(getCalledPaths().length, 0);
});

test('value update: unknown id → NOTFOUND, no PUT fired', async () => {
  const { ctx, getCalledWrites } = makeFakeCtx({
    confirmed: true, fixture: { [GET_URL]: { status: 404, j: {} } },
  });
  await assert.rejects(() => run({ _: ['update', VAL_ID], value: 'x' }, ctx),
    (e) => e.code === EXIT.NOTFOUND);
  assert.equal(getCalledWrites().length, 0, 'must not PUT to an id that does not exist');
});

test('value update: 401 on the fetch → AUTH with remediation, no PUT fired', async () => {
  const { ctx, getCalledWrites } = makeFakeCtx({
    confirmed: true, fixture: { [GET_URL]: { status: 401, j: {} } },
  });
  await assert.rejects(() => run({ _: ['update', VAL_ID], value: 'x' }, ctx),
    (e) => e.code === EXIT.AUTH && String(e.remediation).includes('customValues.write'));
  assert.equal(getCalledWrites().length, 0);
});

test('value update: no --confirm → CONFIRM, nothing written', async () => {
  const { ctx, getCalledWrites } = makeFakeCtx({ fixture: { [GET_URL]: current } });
  const code = await run({ _: ['update', VAL_ID], value: 'x' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.CONFIRM);
  assert.equal(getCalledWrites().length, 0);
});

test('value update: flags round-trip into the rerun command', async () => {
  const { ctx, getPrinted } = makeFakeCtx({ fixture: { [GET_URL]: current } });
  await run({ _: ['update', VAL_ID], name: 'N', value: 'V' }, ctx);
  ctx.out.flush();
  const cmd = JSON.parse(getPrinted()).data.confirmCommand;
  assert.ok(cmd.includes('--name "N"') && cmd.includes('--value "V"'), `got: ${cmd}`);
  assert.ok(cmd.includes(VAL_ID), 'rerun must carry the id');
});

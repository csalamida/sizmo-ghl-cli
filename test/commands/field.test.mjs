// test/commands/field.test.mjs — create custom field (confirm-gated).
import { test } from 'node:test';
import assert from 'node:assert';
import { run } from '../../commands/field.mjs';
import { makeFakeCtx } from '../_helpers.mjs';
import { EXIT } from '../../lib/errors.mjs';

const PATH = 'POST /locations/L-TEST/customFields';

test('field create: --confirm → POST customFields fires once, exit 0', async () => {
  const fixture = { [PATH]: { status: 200, j: { customField: { id: 'f-1' } } } };
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ confirmed: true, fixture });
  const code = await run({ _: ['create'], name: 'Lead Source', type: 'TEXT' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(getCalledWrites().filter(w => w === PATH).length, 1);
  assert.equal(JSON.parse(getPrinted()).data.fieldId, 'f-1');
});

test('field create: no --confirm → CONFIRM (5), no write', async () => {
  const { ctx, getCalledWrites } = makeFakeCtx({ confirmed: false });
  const code = await run({ _: ['create'], name: 'Lead Source' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.CONFIRM);
  assert.equal(getCalledWrites().length, 0);
});

test('field create: unknown --type → USAGE (caught locally, no round-trip)', async () => {
  const { ctx } = makeFakeCtx({ confirmed: true });
  await assert.rejects(() => run({ _: ['create'], name: 'X', type: 'BOGUS' }, ctx), /unknown --type/i);
});

test('field create: no --name → USAGE', async () => {
  const { ctx } = makeFakeCtx({ confirmed: true });
  await assert.rejects(() => run({ _: ['create'] }, ctx), /--name/i);
});

test('field create: 403 → AUTH + customFields.write guidance', async () => {
  const fixture = { [PATH]: { status: 403, j: {} } };
  const { ctx } = makeFakeCtx({ confirmed: true, fixture });
  await assert.rejects(() => run({ _: ['create'], name: 'X' }, ctx),
    (e) => { assert.equal(e.code, EXIT.AUTH); assert.match(e.message, /customFields\.write/); return true; });
});

// ── delete (single-target, never bulk) ─────────────────────────────────────────
const LIST = 'GET /locations/L-TEST/customFields';
const listFixture = { [LIST]: { status: 200, j: { customFields: [{ id: 'f-1', name: 'Lead Source' }] } } };

test('field delete: no id → USAGE (never bulk)', async () => {
  const { ctx } = makeFakeCtx({ confirmed: true });
  await assert.rejects(() => run({ _: ['delete'] }, ctx),
    (e) => { assert.equal(e.code, EXIT.USAGE); assert.match(e.message, /one id, never bulk/i); return true; });
});

test('field delete: unknown id → NOTFOUND, no DELETE fired', async () => {
  const { ctx, getCalledWrites } = makeFakeCtx({ confirmed: true, fixture: listFixture });
  await assert.rejects(() => run({ _: ['delete', 'f-NOPE'] }, ctx),
    (e) => { assert.equal(e.code, EXIT.NOTFOUND); assert.match(e.message, /nothing deleted/i); return true; });
  assert.equal(getCalledWrites().length, 0, 'no DELETE for a non-existent id');
});

test('field delete: no --confirm → CONFIRM (5), names the exact target, no DELETE', async () => {
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ confirmed: false, fixture: listFixture });
  const code = await run({ _: ['delete', 'f-1'] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.CONFIRM);
  assert.equal(getCalledWrites().length, 0, 'no DELETE without --confirm');
  const env = JSON.parse(getPrinted());
  assert.ok(env.data.changes.some(c => /Delete custom field "Lead Source" \(id f-1\)/.test(c)), 'preview names the exact field');
  assert.ok(env.data.changes.some(c => /never in bulk/i.test(c)), 'preview states single-target safety');
});

test('field delete: --confirm → DELETEs exactly that one resource, exit 0', async () => {
  const fixture = { ...listFixture, 'DELETE /locations/L-TEST/customFields/f-1': { status: 200, j: { succeeded: true } } };
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ confirmed: true, fixture });
  const code = await run({ _: ['delete', 'f-1'] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  const dels = getCalledWrites().filter(w => w.startsWith('DELETE'));
  assert.deepEqual(dels, ['DELETE /locations/L-TEST/customFields/f-1'], 'exactly the one single-resource DELETE');
  assert.equal(JSON.parse(getPrinted()).data.name, 'Lead Source');
});

// ── option-requiring types + endpoint fields (2026-07-27) ────────────────────
// POST /locations/{id}/customFields accepts 9 body fields; sizmo sent 3. Worse, `--type`
// advertised 12 types while four of them (SINGLE_OPTIONS, MULTIPLE_OPTIONS, RADIO, CHECKBOX)
// need a choice list this endpoint does not document a field for — creating one produced a
// field with NO choices: visible in GHL, impossible to fill in, repairable only by hand.
// Same shape as the `calendar create --type round_robin` gap: a type the CLI let you pick but
// could not make work.

const FIELD_URL = 'POST /locations/L-TEST/customFields';
const okFixture = { [FIELD_URL]: { status: 200, j: { customField: { id: 'fld-1' } } } };

for (const t of ['SINGLE_OPTIONS', 'MULTIPLE_OPTIONS', 'RADIO', 'CHECKBOX']) {
  test(`field create: ${t} is refused rather than creating an empty field`, async () => {
    const { ctx, getCalledWrites } = makeFakeCtx({ confirmed: true, fixture: okFixture });
    await assert.rejects(
      () => run({ _: ['create'], name: 'X', type: t }, ctx),
      (e) => e.code === EXIT.USAGE && /needs a list of choices/.test(e.message));
    assert.equal(getCalledWrites().length, 0, 'must not create a field it cannot populate');
  });
}

test('field create: TEXTBOX_LIST without --textbox-option is refused', async () => {
  const { ctx, getCalledWrites } = makeFakeCtx({ confirmed: true, fixture: okFixture });
  await assert.rejects(
    () => run({ _: ['create'], name: 'X', type: 'TEXTBOX_LIST' }, ctx),
    (e) => e.code === EXIT.USAGE && /--textbox-option/.test(e.message));
  assert.equal(getCalledWrites().length, 0);
});

test('field create: TEXTBOX_LIST with options sends textBoxListOptions', async () => {
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, fixture: okFixture });
  await run({ _: ['create'], name: 'Sizes', type: 'TEXTBOX_LIST', 'textbox-option': 'Small, Medium ,Large' }, ctx);
  ctx.out.flush();
  const { body } = getCalledBodies()[0];
  assert.deepEqual(body.textBoxListOptions, ['Small', 'Medium', 'Large'], 'trimmed, empty entries dropped');
});

test('field create: FILE_UPLOAD flags map to their real endpoint names', async () => {
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, fixture: okFixture });
  await run({ _: ['create'], name: 'Docs', type: 'FILE_UPLOAD',
              accept: '.pdf,.docx', 'multiple-files': true, 'max-files': 3 }, ctx);
  ctx.out.flush();
  const { body } = getCalledBodies()[0];
  assert.deepEqual(body.acceptedFormat, ['.pdf', '.docx'], 'acceptedFormat, not acceptedFormats');
  assert.equal(body.isMultipleFile, true, 'isMultipleFile, not multipleFiles');
  assert.equal(body.maxNumberOfFiles, 3, 'maxNumberOfFiles, not maxFileLimit');
});

test('field create: placeholder and position map through', async () => {
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, fixture: okFixture });
  await run({ _: ['create'], name: 'Ref', type: 'TEXT', placeholder: 'e.g. ABC-123', position: 2 }, ctx);
  ctx.out.flush();
  const { body } = getCalledBodies()[0];
  assert.equal(body.placeholder, 'e.g. ABC-123');
  assert.equal(body.position, 2);
});

test('field create: a plain TEXT field still sends exactly the 3 original keys', async () => {
  // The default path must not gain keys — sending placeholder:undefined or position:null would
  // change what GHL stores for every existing scripted call.
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, fixture: okFixture });
  await run({ _: ['create'], name: 'Plain', type: 'TEXT' }, ctx);
  ctx.out.flush();
  assert.deepEqual(Object.keys(getCalledBodies()[0].body).sort(), ['dataType', 'model', 'name']);
});

test('field create: every new flag round-trips into the rerun command', async () => {
  const { ctx, getPrinted } = makeFakeCtx({});
  await run({ _: ['create'], name: 'Docs', type: 'FILE_UPLOAD', accept: '.pdf',
              'multiple-files': true, 'max-files': 3, placeholder: 'p', position: 1 }, ctx);
  ctx.out.flush();
  const cmd = JSON.parse(getPrinted()).data.confirmCommand;
  for (const frag of ['--accept', '--multiple-files', '--max-files 3', '--placeholder', '--position 1']) {
    assert.ok(cmd.includes(frag), `rerun must carry ${frag} — got: ${cmd}`);
  }
});

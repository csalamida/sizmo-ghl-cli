// test/commands/note.test.mjs
// No-confirm → exit 5 (CONFIRM) + envelope, NO http write fired.
// --confirm → write fires once, exit 0.
// 401/403 → exit 3 + scope message.
// --dry-run → status dry_run, no write, exit 0.
import { test } from 'node:test';
import assert from 'node:assert';
import { run } from '../../commands/note.mjs';
import { makeFakeCtx } from '../_helpers.mjs';
import { EXIT } from '../../lib/errors.mjs';

const CONTACT = 'cid-note-001';

// ── no --confirm ─────────────────────────────────────────────────────────────

test('note: no --confirm → exit 4 + envelope, no write fired', async () => {
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ confirmed: false });
  const code = await run({ _: [CONTACT], text: 'Called and left voicemail' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.CONFIRM, 'exit code must be CONFIRM (5)');
  assert.equal(getCalledWrites().length, 0, 'no http write without --confirm');
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.data.status, 'confirmation_required');
  assert.ok(Array.isArray(envelope.data.changes), 'changes array present');
  assert.ok(envelope.data.changes.some(c => /Called/.test(c)), 'note text in changes');
  assert.ok(envelope.data.confirmCommand.includes('--confirm'), 'confirmCommand has --confirm');
  assert.ok(envelope.data.confirmCommand.includes(CONTACT), 'confirmCommand has contactId');
});

// ── --confirm → write fires ───────────────────────────────────────────────────

test('note: --confirm → POST fires once, exit 0', async () => {
  const fixture = {
    [`POST /contacts/${CONTACT}/notes`]: { status: 200, j: { id: 'note-abc' } },
  };
  const { ctx, getCalledWrites } = makeFakeCtx({ confirmed: true, fixture });
  const code = await run({ _: [CONTACT], text: 'Called and left voicemail' }, ctx);
  assert.equal(code, EXIT.OK);
  assert.equal(getCalledWrites().filter(w => w.startsWith('POST')).length, 1);
});

// ── scope floor ──────────────────────────────────────────────────────────────

test('note: 401 → exit AUTH + scope message', async () => {
  const fixture = { [`POST /contacts/${CONTACT}/notes`]: { status: 401, j: {} } };
  const { ctx } = makeFakeCtx({ confirmed: true, fixture });
  await assert.rejects(
    () => run({ _: [CONTACT], text: 'hi' }, ctx),
    (e) => { assert.equal(e.code, EXIT.AUTH); assert.ok(/contacts\.write/.test(e.message)); return true; }
  );
});

test('note: 403 → exit AUTH', async () => {
  const fixture = { [`POST /contacts/${CONTACT}/notes`]: { status: 403, j: {} } };
  const { ctx } = makeFakeCtx({ confirmed: true, fixture });
  await assert.rejects(
    () => run({ _: [CONTACT], text: 'hi' }, ctx),
    (e) => { assert.equal(e.code, EXIT.AUTH); return true; }
  );
});

// ── --dry-run ─────────────────────────────────────────────────────────────────

test('note: --dry-run → status dry_run, no write, exit 0', async () => {
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ dryRun: true });
  const code = await run({ _: [CONTACT], text: 'test note' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(getCalledWrites().length, 0);
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.data.status, 'dry_run');
});

// ── usage errors ──────────────────────────────────────────────────────────────

test('note: no contactId → USAGE error', async () => {
  const { ctx } = makeFakeCtx();
  await assert.rejects(() => run({ _: [] }, ctx), /usage/i);
});

test('note: no --text → USAGE error', async () => {
  const { ctx } = makeFakeCtx();
  await assert.rejects(() => run({ _: [CONTACT] }, ctx), /--text/i);
});

test('note: empty --text → USAGE error', async () => {
  const { ctx } = makeFakeCtx();
  await assert.rejects(() => run({ _: [CONTACT], text: '   ' }, ctx), /--text/i);
});

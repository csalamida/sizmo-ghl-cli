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

test('note: --confirm → POST fires once, exit 0, noteId read from the real nested shape', async () => {
  const fixture = {
    // GHL's real response nests the created note under a "note" key — verified live
    // 2026-07-05 (POST /contacts/:id/notes → { note: { id, ... }, traceId }), not flat.
    // A flat { id: ... } mock here would hide the exact bug this caught: noteId always null.
    [`POST /contacts/${CONTACT}/notes`]: { status: 200, j: { note: { id: 'note-abc' } } },
  };
  const { ctx, getCalledWrites, getPrinted } = makeFakeCtx({ confirmed: true, fixture });
  const code = await run({ _: [CONTACT], text: 'Called and left voicemail' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(getCalledWrites().filter(w => w.startsWith('POST')).length, 1);
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.data.noteId, 'note-abc', 'noteId must be read from the nested note.id, not a flat id');
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

// ── BODY ASSERTIONS (lens 4, 2026-07-27) ────────────────────────────────────
// note was one of three WRITE commands whose tests never inspected the payload.

test('note: body key is `body`, carrying the text verbatim', async () => {
  // GHL's notes endpoint takes { body }. A rename to { text } or { note } would be dropped
  // silently — the note would appear blank on the contact and nothing would fail.
  const fixture = { 'POST /contacts/cid-1/notes': { status: 200, j: { note: { id: 'n1' } } } };
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, fixture });
  await run({ _: ['cid-1'], text: 'Called, left voicemail' }, ctx);
  ctx.out.flush();
  assert.deepEqual(getCalledBodies()[0].body, { body: 'Called, left voicemail' });
});

test('note: long text is NOT truncated on the wire — only the preview is', async () => {
  // The confirm preview elides at 80 chars. If that elision leaked into the request, the stored
  // note would be silently cut short, and only a body assertion can catch it.
  const long = 'x'.repeat(500);
  const fixture = { 'POST /contacts/cid-1/notes': { status: 200, j: {} } };
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, fixture });
  await run({ _: ['cid-1'], text: long }, ctx);
  ctx.out.flush();
  const sent = getCalledBodies()[0].body.body;
  assert.equal(sent.length, 500, 'the full text must reach the API, not the 80-char preview');
  assert.ok(!sent.includes('…'), 'the preview ellipsis must never appear in the payload');
});

test('note: the contact id is URL-encoded in the path', async () => {
  const weird = 'c/d';
  const fixture = { [`POST /contacts/${encodeURIComponent(weird)}/notes`]: { status: 200, j: {} } };
  const { ctx, getCalledPaths } = makeFakeCtx({ confirmed: true, fixture });
  await run({ _: [weird], text: 'hi' }, ctx);
  ctx.out.flush();
  assert.ok(getCalledPaths().every(p => !p.includes('/contacts/c/d/')));
});

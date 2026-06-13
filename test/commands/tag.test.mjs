// test/commands/tag.test.mjs
// No-confirm → exit 4 + envelope, NO http write fired.
// --confirm → write fires once, exit 0.
// 401/403 → exit 3 + scope message.
// --dry-run → status dry_run, no write, exit 0.
import { test } from 'node:test';
import assert from 'node:assert';
import { run } from '../../commands/tag.mjs';
import { makeFakeCtx } from '../_helpers.mjs';
import { EXIT } from '../../lib/errors.mjs';

const CONTACT = 'cid-001';

// ── no --confirm ─────────────────────────────────────────────────────────────

test('tag add: no --confirm → exit 4 + envelope, no write fired', async () => {
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ confirmed: false });
  const code = await run({ _: [CONTACT], add: 'VIP' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.CONFIRM, 'exit code must be CONFIRM (4)');
  const writes = getCalledWrites();
  assert.equal(writes.length, 0, 'no http write must fire without --confirm');
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.data.status, 'confirmation_required');
  assert.ok(Array.isArray(envelope.data.changes), 'changes array present');
  assert.ok(envelope.data.changes.some(c => /VIP/.test(c)), 'tag name in changes');
  assert.ok(typeof envelope.data.confirmCommand === 'string', 'confirmCommand present');
  assert.ok(envelope.data.confirmCommand.includes('--confirm'), 'confirmCommand has --confirm');
});

test('tag remove: no --confirm → exit 4 + envelope, no write fired', async () => {
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ confirmed: false });
  const code = await run({ _: [CONTACT], remove: 'old-tag' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.CONFIRM);
  assert.equal(getCalledWrites().length, 0);
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.data.status, 'confirmation_required');
  assert.ok(envelope.data.changes.some(c => /old-tag/.test(c)));
});

// ── --confirm → write fires ───────────────────────────────────────────────────

test('tag add: --confirm → POST fires once, exit 0', async () => {
  const fixture = {
    [`POST /contacts/${CONTACT}/tags`]: { status: 200, j: { tags: ['VIP'] } },
  };
  const { ctx, getCalledWrites } = makeFakeCtx({ confirmed: true, fixture });
  const code = await run({ _: [CONTACT], add: 'VIP' }, ctx);
  assert.equal(code, EXIT.OK);
  const writes = getCalledWrites();
  assert.equal(writes.filter(w => w.startsWith('POST')).length, 1, 'exactly one POST');
});

test('tag remove: --confirm → DELETE fires once, exit 0', async () => {
  const fixture = {
    [`DELETE /contacts/${CONTACT}/tags`]: { status: 200, j: {} },
  };
  const { ctx, getCalledWrites } = makeFakeCtx({ confirmed: true, fixture });
  const code = await run({ _: [CONTACT], remove: 'old-tag' }, ctx);
  assert.equal(code, EXIT.OK);
  const writes = getCalledWrites();
  assert.equal(writes.filter(w => w.startsWith('DELETE')).length, 1, 'exactly one DELETE');
});

// ── scope floor (401/403 → exit 3) ───────────────────────────────────────────

test('tag add: 401 → exit AUTH + scope message', async () => {
  const fixture = { [`POST /contacts/${CONTACT}/tags`]: { status: 401, j: { message: 'Unauthorized' } } };
  const { ctx } = makeFakeCtx({ confirmed: true, fixture });
  await assert.rejects(
    () => run({ _: [CONTACT], add: 'VIP' }, ctx),
    (e) => { assert.equal(e.code, EXIT.AUTH); assert.ok(/contacts\.write/.test(e.message)); return true; }
  );
});

test('tag add: 403 → exit AUTH + scope message', async () => {
  const fixture = { [`POST /contacts/${CONTACT}/tags`]: { status: 403, j: { message: 'Forbidden' } } };
  const { ctx } = makeFakeCtx({ confirmed: true, fixture });
  await assert.rejects(
    () => run({ _: [CONTACT], add: 'VIP' }, ctx),
    (e) => { assert.equal(e.code, EXIT.AUTH); return true; }
  );
});

// ── --dry-run ─────────────────────────────────────────────────────────────────

test('tag add: --dry-run → status dry_run, no write, exit 0', async () => {
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ dryRun: true });
  const code = await run({ _: [CONTACT], add: 'VIP' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK, 'dry-run exits 0');
  assert.equal(getCalledWrites().length, 0, 'no write fired in dry-run');
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.data.status, 'dry_run');
});

// ── usage errors ──────────────────────────────────────────────────────────────

test('tag: no contactId → USAGE error', async () => {
  const { ctx } = makeFakeCtx();
  await assert.rejects(() => run({ _: [] }, ctx), /usage/i);
});

test('tag: no --add or --remove → USAGE error', async () => {
  const { ctx } = makeFakeCtx();
  await assert.rejects(() => run({ _: [CONTACT] }, ctx), /--add|--remove/i);
});

test('tag: both --add and --remove → USAGE error', async () => {
  const { ctx } = makeFakeCtx();
  await assert.rejects(() => run({ _: [CONTACT], add: 'a', remove: 'b' }, ctx), /either|both/i);
});

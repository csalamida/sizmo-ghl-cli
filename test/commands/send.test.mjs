// test/commands/send.test.mjs
// HIGHEST BLAST — confirm preview MUST show exact recipient + channel + full body.
// No-confirm → exit 5 (CONFIRM) + envelope, NO http write fired.
// --confirm → write fires once, exit 0.
// 401/403 → exit 3 + scope message.
// --dry-run → dry_run, no write, exit 0.
import { test } from 'node:test';
import assert from 'node:assert';
import { run } from '../../commands/send.mjs';
import { makeFakeCtx } from '../_helpers.mjs';
import { EXIT } from '../../lib/errors.mjs';

const CONTACT = 'cid-send-001';
const MESSAGE = 'Hi, just following up on your application. Are you free for a quick call?';

// ── no --confirm — SMS ────────────────────────────────────────────────────────

test('send sms: no --confirm → exit 4, no write fired, envelope shows recipient+channel+body', async () => {
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ confirmed: false });
  const code = await run({ _: [CONTACT], channel: 'sms', message: MESSAGE }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.CONFIRM, 'exit must be CONFIRM (5)');
  assert.equal(getCalledWrites().length, 0, 'no http write without --confirm');

  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.data.status, 'confirmation_required');

  // CRITICAL: confirm preview must show recipient + channel + FULL body
  const changes = envelope.data.changes;
  assert.ok(Array.isArray(changes), 'changes array present');
  const allText = changes.join('\n');
  assert.ok(allText.includes(CONTACT),  'recipient (contactId) in changes');
  assert.ok(/sms/i.test(allText),        'channel (sms) in changes');
  assert.ok(allText.includes(MESSAGE),   'FULL message body in changes (not truncated)');

  // confirmCommand must exist and include --confirm
  assert.ok(typeof envelope.data.confirmCommand === 'string');
  assert.ok(envelope.data.confirmCommand.includes('--confirm'));
  assert.ok(envelope.data.confirmCommand.includes(CONTACT));
});

// ── no --confirm — email ──────────────────────────────────────────────────────

test('send email: no --confirm → exit 4, envelope shows recipient+channel+body', async () => {
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ confirmed: false });
  const emailMsg = 'Dear Coach Maria, here is your onboarding link: https://example.com/start';
  const code = await run({ _: [CONTACT], channel: 'email', message: emailMsg }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.CONFIRM);
  assert.equal(getCalledWrites().length, 0);

  const envelope = JSON.parse(getPrinted());
  const allText = envelope.data.changes.join('\n');
  assert.ok(allText.includes(CONTACT));
  assert.ok(/email/i.test(allText));
  assert.ok(allText.includes(emailMsg), 'full email body in changes');
});

// ── --confirm → write fires ───────────────────────────────────────────────────

test('send sms: --confirm → POST /conversations/messages fires once, exit 0', async () => {
  const fixture = { 'POST /conversations/messages': { status: 200, j: { messageId: 'msg-001' } } };
  const { ctx, getCalledWrites } = makeFakeCtx({ confirmed: true, fixture });
  const code = await run({ _: [CONTACT], channel: 'sms', message: MESSAGE }, ctx);
  assert.equal(code, EXIT.OK);
  assert.equal(getCalledWrites().filter(w => w.startsWith('POST')).length, 1, 'exactly one POST');
});

test('send email: --confirm → POST /conversations/messages fires once, exit 0', async () => {
  const fixture = { 'POST /conversations/messages': { status: 200, j: { messageId: 'msg-002' } } };
  const { ctx, getCalledWrites } = makeFakeCtx({ confirmed: true, fixture });
  const code = await run({ _: [CONTACT], channel: 'email', message: 'Hello' }, ctx);
  assert.equal(code, EXIT.OK);
  assert.equal(getCalledWrites().filter(w => w.startsWith('POST')).length, 1);
});

// ── scope floor (401/403 → exit AUTH) ────────────────────────────────────────

test('send sms: 401 → exit AUTH + scope message', async () => {
  const fixture = { 'POST /conversations/messages': { status: 401, j: {} } };
  const { ctx } = makeFakeCtx({ confirmed: true, fixture });
  await assert.rejects(
    () => run({ _: [CONTACT], channel: 'sms', message: 'hi' }, ctx),
    (e) => {
      assert.equal(e.code, EXIT.AUTH);
      assert.ok(/conversations\/message\.write/.test(e.message), 'scope name in error');
      return true;
    }
  );
});

test('send sms: 403 → exit AUTH', async () => {
  const fixture = { 'POST /conversations/messages': { status: 403, j: {} } };
  const { ctx } = makeFakeCtx({ confirmed: true, fixture });
  await assert.rejects(
    () => run({ _: [CONTACT], channel: 'sms', message: 'hi' }, ctx),
    (e) => { assert.equal(e.code, EXIT.AUTH); return true; }
  );
});

// ── --dry-run ─────────────────────────────────────────────────────────────────

test('send sms: --dry-run → status dry_run, no write, exit 0', async () => {
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ dryRun: true });
  const code = await run({ _: [CONTACT], channel: 'sms', message: MESSAGE }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK, 'dry-run exits 0');
  assert.equal(getCalledWrites().length, 0, 'no write in dry-run');
  const envelope = JSON.parse(getPrinted());
  assert.equal(envelope.data.status, 'dry_run');
});

// ── full body never truncated in confirm envelope ─────────────────────────────

test('send: long message body is NOT truncated in confirm envelope', async () => {
  // Use a long message (> 80 chars — note command truncates, send must not)
  const longMsg = 'A'.repeat(200) + ' end-sentinel';
  const { ctx, getPrinted } = makeFakeCtx({ confirmed: false });
  await run({ _: [CONTACT], channel: 'sms', message: longMsg }, ctx);
  ctx.out.flush();
  const envelope = JSON.parse(getPrinted());
  const allText = envelope.data.changes.join('\n');
  assert.ok(allText.includes('end-sentinel'), 'full body preserved — end-sentinel found');
  assert.ok(allText.includes('A'.repeat(200)), 'full 200-char run present');
});

// ── usage errors ──────────────────────────────────────────────────────────────

test('send: no contactId → USAGE error', async () => {
  const { ctx } = makeFakeCtx();
  await assert.rejects(() => run({ _: [] }, ctx), /usage/i);
});

test('send: missing --channel → USAGE error', async () => {
  const { ctx } = makeFakeCtx();
  await assert.rejects(() => run({ _: [CONTACT], message: 'hi' }, ctx), /--channel/i);
});

test('send: unknown channel → USAGE error', async () => {
  const { ctx } = makeFakeCtx();
  await assert.rejects(() => run({ _: [CONTACT], channel: 'fax', message: 'hi' }, ctx), /channel/i);
});

test('send: missing --message → USAGE error', async () => {
  const { ctx } = makeFakeCtx();
  await assert.rejects(() => run({ _: [CONTACT], channel: 'sms' }, ctx), /--message/i);
});

test('send: empty --message → USAGE error', async () => {
  const { ctx } = makeFakeCtx();
  await assert.rejects(() => run({ _: [CONTACT], channel: 'sms', message: '   ' }, ctx), /--message/i);
});

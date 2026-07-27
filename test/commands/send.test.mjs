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

test('send sms: request body includes locationId — verified live, GHL 422s without it', async () => {
  const fixture = { 'POST /conversations/messages': { status: 200, j: { messageId: 'msg-001' } } };
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, loc: 'L-TEST', fixture });
  await run({ _: [CONTACT], channel: 'sms', message: MESSAGE }, ctx);
  const body = getCalledBodies().find(b => b.method === 'POST').body;
  assert.equal(body.locationId, 'L-TEST');
  assert.equal(body.type, 'SMS');
  assert.equal(body.message, MESSAGE);
  assert.equal(body.html, undefined, 'SMS must not send html — GHL only reads message for SMS');
});

test('send email: request body includes locationId + html + subject — verified live, message alone 422s with a misleading "no message or attachments" error', async () => {
  const fixture = { 'POST /conversations/messages': { status: 200, j: { messageId: 'msg-002' } } };
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, loc: 'L-TEST', fixture });
  await run({ _: [CONTACT], channel: 'email', message: 'Hello there\nSecond line' }, ctx);
  const body = getCalledBodies().find(b => b.method === 'POST').body;
  assert.equal(body.locationId, 'L-TEST');
  assert.equal(body.type, 'Email');
  assert.ok(body.html.includes('Hello there'), 'html must carry the message content — GHL requires it for email');
  assert.equal(body.subject, 'Hello there', 'subject defaults from the first line since send has no --subject flag');
});

test('send email: a leading blank line never produces an empty subject', async () => {
  const fixture = { 'POST /conversations/messages': { status: 200, j: { messageId: 'msg-003' } } };
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, fixture });
  await run({ _: [CONTACT], channel: 'email', message: '\n\nActual content here' }, ctx);
  const body = getCalledBodies().find(b => b.method === 'POST').body;
  assert.equal(body.subject, 'Actual content here');
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

// ── cancel — scheduled SMS/email ─────────────────────────────────────────────

test('send cancel: no --confirm → CONFIRM (5), no write fired', async () => {
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ confirmed: false });
  const code = await run({ _: ['cancel', 'msg-123'], channel: 'sms' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.CONFIRM);
  assert.equal(getCalledWrites().length, 0);
  assert.ok(JSON.parse(getPrinted()).data.changes.some(c => /Cancel scheduled SMS message msg-123/.test(c)));
});

test('send cancel sms: --confirm → DELETE on the generic schedule path fires once, exit 0', async () => {
  const fixture = { 'DELETE /conversations/messages/msg-123/schedule': { status: 200, j: {} } };
  const { ctx, getCalledWrites } = makeFakeCtx({ confirmed: true, fixture });
  const code = await run({ _: ['cancel', 'msg-123'], channel: 'sms' }, ctx);
  assert.equal(code, EXIT.OK);
  assert.deepEqual(getCalledWrites(), ['DELETE /conversations/messages/msg-123/schedule']);
});

test('send cancel email: --confirm → DELETE on the SEPARATE email schedule path — verified via describe_operation, GHL splits this by channel', async () => {
  const fixture = { 'DELETE /conversations/messages/email/msg-456/schedule': { status: 200, j: {} } };
  const { ctx, getCalledWrites } = makeFakeCtx({ confirmed: true, fixture });
  const code = await run({ _: ['cancel', 'msg-456'], channel: 'email' }, ctx);
  assert.equal(code, EXIT.OK);
  assert.deepEqual(getCalledWrites(), ['DELETE /conversations/messages/email/msg-456/schedule']);
});

test('send cancel: 404 → NOTFOUND, nothing cancelled', async () => {
  const fixture = { 'DELETE /conversations/messages/msg-123/schedule': { status: 404, j: {} } };
  const { ctx } = makeFakeCtx({ confirmed: true, fixture });
  await assert.rejects(() => run({ _: ['cancel', 'msg-123'], channel: 'sms' }, ctx),
    (e) => { assert.equal(e.code, EXIT.NOTFOUND); return true; });
});

test('send cancel sms: 400 with CONVERSATIONS_MSG_NOT_FOUND → still NOTFOUND, not a generic API error — verified live, GHL\'s two cancel endpoints disagree on status code', async () => {
  const fixture = {
    'DELETE /conversations/messages/msg-123/schedule': {
      status: 400, j: { canonicalCode: 'CONVERSATIONS_MSG_NOT_FOUND', message: 'No message found with id: msg-123' },
    },
  };
  const { ctx } = makeFakeCtx({ confirmed: true, fixture });
  await assert.rejects(() => run({ _: ['cancel', 'msg-123'], channel: 'sms' }, ctx),
    (e) => { assert.equal(e.code, EXIT.NOTFOUND); return true; });
});

test('send cancel: 401 → AUTH + scope message', async () => {
  const fixture = { 'DELETE /conversations/messages/msg-123/schedule': { status: 401, j: {} } };
  const { ctx } = makeFakeCtx({ confirmed: true, fixture });
  await assert.rejects(() => run({ _: ['cancel', 'msg-123'], channel: 'sms' }, ctx),
    (e) => { assert.equal(e.code, EXIT.AUTH); assert.match(e.message, /conversations\/message\.write/); return true; });
});

test('send cancel: missing messageId → USAGE error', async () => {
  const { ctx } = makeFakeCtx();
  await assert.rejects(() => run({ _: ['cancel'], channel: 'sms' }, ctx), /usage/i);
});

test('send cancel: missing --channel → USAGE error', async () => {
  const { ctx } = makeFakeCtx();
  await assert.rejects(() => run({ _: ['cancel', 'msg-123'] }, ctx), /--channel/i);
});

test('send cancel: unknown channel → USAGE error', async () => {
  const { ctx } = makeFakeCtx();
  await assert.rejects(() => run({ _: ['cancel', 'msg-123'], channel: 'fax' }, ctx), /channel/i);
});

// ── email HTML escaping (2026-07-27) ─────────────────────────────────────────
// The email body wraps each line in <p> and interpolated the message RAW, so any &, < or > the
// user wrote landed in the HTML unescaped. An email client parses "<20% off" as an unknown tag and
// drops everything to the next ">", silently truncating the sentence the client receives.
// Verified: "Your discount is <20% off. Terms & conditions apply." rendered as "Your discount is".

const MSG_FIXTURE = { 'POST /conversations/messages': { status: 200, j: { messageId: 'm-1' } } };

test('send email: HTML special characters are escaped in the html part', async () => {
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, fixture: MSG_FIXTURE });
  await run({ _: [CONTACT], channel: 'email', message: 'Discount <20% off. Terms & conditions.' }, ctx);
  ctx.out.flush();
  const { body } = getCalledBodies()[0];
  assert.ok(body.html.includes('&lt;20%'), `< must be escaped — got: ${body.html}`);
  assert.ok(body.html.includes('&amp; conditions'), `& must be escaped — got: ${body.html}`);
  assert.ok(!/<20%/.test(body.html), 'raw < must not survive into the html');
});

test('send email: the plain-text `message` part stays UNescaped', async () => {
  // Escaping the plain-text alternative would show a literal "&amp;" to recipients whose client
  // renders text. Only the html part needs escaping.
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, fixture: MSG_FIXTURE });
  await run({ _: [CONTACT], channel: 'email', message: 'Terms & conditions <here>' }, ctx);
  ctx.out.flush();
  assert.equal(getCalledBodies()[0].body.message, 'Terms & conditions <here>');
});

test('send email: a script tag cannot be injected into the html body', async () => {
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, fixture: MSG_FIXTURE });
  await run({ _: [CONTACT], channel: 'email', message: '<script>alert(1)</script>' }, ctx);
  ctx.out.flush();
  const { html } = getCalledBodies()[0].body;
  assert.ok(!/<script/i.test(html), `markup must not survive — got: ${html}`);
  assert.ok(html.includes('&lt;script&gt;'));
});

test('send sms: html is not built at all (escaping is email-only)', async () => {
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, fixture: MSG_FIXTURE });
  await run({ _: [CONTACT], channel: 'sms', message: 'Terms & conditions <here>' }, ctx);
  ctx.out.flush();
  const { body } = getCalledBodies()[0];
  assert.equal('html' in body, false);
  assert.equal(body.message, 'Terms & conditions <here>', 'SMS text must be untouched');
});

// ── --subject (2026-07-27) ───────────────────────────────────────────────────
// GHL accepts `subject` directly; sizmo auto-derived it from the first line because no flag existed.

test('send email: --subject is used when given', async () => {
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, fixture: MSG_FIXTURE });
  await run({ _: [CONTACT], channel: 'email', message: 'Body line one', subject: 'Q3 Invoice' }, ctx);
  ctx.out.flush();
  assert.equal(getCalledBodies()[0].body.subject, 'Q3 Invoice');
});

test('send email: subject still falls back to the first non-blank line', async () => {
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, fixture: MSG_FIXTURE });
  await run({ _: [CONTACT], channel: 'email', message: '\n\nActual first line\nsecond' }, ctx);
  ctx.out.flush();
  assert.equal(getCalledBodies()[0].body.subject, 'Actual first line');
});

test('send email: whitespace-only --subject falls back rather than sending a blank subject', async () => {
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, fixture: MSG_FIXTURE });
  await run({ _: [CONTACT], channel: 'email', message: 'Hello there', subject: '   ' }, ctx);
  ctx.out.flush();
  assert.equal(getCalledBodies()[0].body.subject, 'Hello there');
});

test('send: --subject round-trips into the rerun command', async () => {
  const { ctx, getPrinted } = makeFakeCtx({ confirmed: false });
  await run({ _: [CONTACT], channel: 'email', message: 'Body', subject: 'Q3 Invoice' }, ctx);
  ctx.out.flush();
  const cmd = JSON.parse(getPrinted()).data.confirmCommand;
  assert.ok(cmd.includes('--subject "Q3 Invoice"'), `got: ${cmd}`);
});

// ── --schedule (2026-07-27) ──────────────────────────────────────────────────
// sizmo shipped `send cancel <messageId>`, whose entire purpose is cancelling a SCHEDULED message,
// while nothing could create one — the CLI could cancel something it was unable to send.
// The endpoint wants UTC epoch SECONDS (its own example: 1669287863).

const NOW_MS = 1_700_000_000_000;                 // 2023-11-14T22:13:20Z
const FUTURE = '2026-08-01T09:00:00Z';
const FUTURE_SECONDS = Math.floor(Date.parse(FUTURE) / 1000);

test('send --schedule: sends scheduledTimestamp in SECONDS, not milliseconds', async () => {
  // Passing ms would schedule ~50,000 years out and the message would simply never arrive,
  // with no error to explain why.
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, now: NOW_MS, fixture: MSG_FIXTURE });
  await run({ _: [CONTACT], channel: 'sms', message: 'Hi', schedule: FUTURE }, ctx);
  ctx.out.flush();
  const ts = getCalledBodies()[0].body.scheduledTimestamp;
  assert.equal(ts, FUTURE_SECONDS);
  assert.ok(String(ts).length === 10, `expected epoch seconds, got ${ts}`);
});

test('send: no --schedule → scheduledTimestamp absent entirely (still sends now)', async () => {
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, now: NOW_MS, fixture: MSG_FIXTURE });
  await run({ _: [CONTACT], channel: 'sms', message: 'Hi' }, ctx);
  ctx.out.flush();
  assert.equal('scheduledTimestamp' in getCalledBodies()[0].body, false);
});

test('send --schedule: a past datetime is refused, no message fired', async () => {
  // A past timestamp sends immediately, which is not what the user asked for — refusing beats
  // silently sending now to someone who thought they had until next week to change their mind.
  const { ctx, getCalledWrites } = makeFakeCtx({ confirmed: true, now: NOW_MS, fixture: MSG_FIXTURE });
  await assert.rejects(
    () => run({ _: [CONTACT], channel: 'sms', message: 'Hi', schedule: '2020-01-01T00:00:00Z' }, ctx),
    (e) => e.code === EXIT.USAGE && /in the past/.test(e.message));
  assert.equal(getCalledWrites().length, 0, 'nothing may be sent when scheduling is refused');
});

test('send --schedule: unparseable datetime is refused, no message fired', async () => {
  const { ctx, getCalledWrites } = makeFakeCtx({ confirmed: true, now: NOW_MS, fixture: MSG_FIXTURE });
  await assert.rejects(
    () => run({ _: [CONTACT], channel: 'sms', message: 'Hi', schedule: 'next tuesday' }, ctx),
    (e) => e.code === EXIT.USAGE && /ISO 8601/.test(e.message));
  assert.equal(getCalledWrites().length, 0);
});

test('send --schedule: preview says it does NOT send now and names the fire time', async () => {
  // Unlike every other write here, a scheduled send fires later with nobody watching. The human
  // approving it will not be present when it goes out.
  const { ctx, getPrinted } = makeFakeCtx({ confirmed: false, now: NOW_MS });
  await run({ _: [CONTACT], channel: 'sms', message: 'Hi', schedule: FUTURE }, ctx);
  ctx.out.flush();
  const changes = JSON.parse(getPrinted()).data.changes.join('\n');
  assert.match(changes, /SCHEDULED — does NOT send now/);
  assert.match(changes, /2026-08-01T09:00:00\.000Z/);
  assert.match(changes, /sizmo send cancel/, 'must tell the human how to call it back');
});

test('send --schedule: round-trips into the rerun command', async () => {
  const { ctx, getPrinted } = makeFakeCtx({ confirmed: false, now: NOW_MS });
  await run({ _: [CONTACT], channel: 'sms', message: 'Hi', schedule: FUTURE }, ctx);
  ctx.out.flush();
  const cmd = JSON.parse(getPrinted()).data.confirmCommand;
  assert.ok(cmd.includes(`--schedule "${FUTURE}"`), `got: ${cmd}`);
});

test('send --schedule: works for email too, alongside --subject', async () => {
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, now: NOW_MS, fixture: MSG_FIXTURE });
  await run({ _: [CONTACT], channel: 'email', message: 'Body', subject: 'Q3', schedule: FUTURE }, ctx);
  ctx.out.flush();
  const { body } = getCalledBodies()[0];
  assert.equal(body.scheduledTimestamp, FUTURE_SECONDS);
  assert.equal(body.subject, 'Q3');
  assert.ok(body.html, 'email still builds an html part when scheduled');
});

// test/commands/contact.test.mjs — create-contact write command (confirm-gated).
import { test } from 'node:test';
import assert from 'node:assert';
import { run } from '../../commands/contact.mjs';
import { makeFakeCtx } from '../_helpers.mjs';
import { EXIT } from '../../lib/errors.mjs';

test('contact create: no --confirm → CONFIRM (5), no write fired', async () => {
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ confirmed: false });
  const code = await run({ _: ['create'], email: 'a@b.co', name: 'Acme Co' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.CONFIRM);
  assert.equal(getCalledWrites().length, 0, 'no write without --confirm');
  const env = JSON.parse(getPrinted());
  assert.equal(env.data.status, 'confirmation_required');
  assert.ok(env.data.changes.some(c => /Create contact/.test(c)));
  assert.ok(env.data.confirmCommand.includes('--confirm'));
});

test('contact create: --confirm → POST /contacts/ fires once, exit 0', async () => {
  const fixture = { 'POST /contacts/': { status: 200, j: { contact: { id: 'new-1' } } } };
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ confirmed: true, fixture });
  const code = await run({ _: ['create'], email: 'a@b.co' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  const writes = getCalledWrites().filter(w => w.startsWith('POST /contacts/'));
  assert.equal(writes.length, 1, 'exactly one POST /contacts/');
  assert.equal(JSON.parse(getPrinted()).data.contactId, 'new-1');
});

test('contact create: 401 → AUTH + contacts.write guidance', async () => {
  const fixture = { 'POST /contacts/': { status: 401, j: {} } };
  const { ctx } = makeFakeCtx({ confirmed: true, fixture });
  await assert.rejects(() => run({ _: ['create'], email: 'a@b.co' }, ctx),
    (e) => { assert.equal(e.code, EXIT.AUTH); assert.match(e.message, /contacts\.write/); return true; });
});

test('contact create: --dry-run → no write, exit 0', async () => {
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ dryRun: true });
  const code = await run({ _: ['create'], email: 'a@b.co' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(getCalledWrites().length, 0);
  assert.equal(JSON.parse(getPrinted()).data.status, 'dry_run');
});

test('contact create: missing subcommand → USAGE', async () => {
  const { ctx } = makeFakeCtx();
  await assert.rejects(() => run({ _: [] }, ctx), /usage/i);
});

test('contact create: no identifying field → USAGE', async () => {
  const { ctx } = makeFakeCtx({ confirmed: true });
  await assert.rejects(() => run({ _: ['create'] }, ctx), /at least one of/i);
});

// ── delete (single-target) ─────────────────────────────────────────────────────
test('contact delete: no id → USAGE (never bulk)', async () => {
  const { ctx } = makeFakeCtx({ confirmed: true });
  await assert.rejects(() => run({ _: ['delete'] }, ctx),
    (e) => { assert.equal(e.code, EXIT.USAGE); assert.match(e.message, /one id, never bulk/i); return true; });
});

test('contact delete: unknown id (404 on GET) → NOTFOUND, no DELETE', async () => {
  const fixture = { 'GET /contacts/cid-NOPE': { status: 404, j: {} } };
  const { ctx, getCalledWrites } = makeFakeCtx({ confirmed: true, fixture });
  await assert.rejects(() => run({ _: ['delete', 'cid-NOPE'] }, ctx),
    (e) => { assert.equal(e.code, EXIT.NOTFOUND); assert.match(e.message, /nothing deleted/i); return true; });
  assert.equal(getCalledWrites().length, 0);
});

test('contact delete: --confirm → names contact then one DELETE, exit 0', async () => {
  const fixture = {
    'GET /contacts/cid-1': { status: 200, j: { contact: { id: 'cid-1', firstName: 'Acme', lastName: 'Co' } } },
    'DELETE /contacts/cid-1': { status: 200, j: { succeeded: true } },
  };
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ confirmed: true, fixture });
  const code = await run({ _: ['delete', 'cid-1'] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.deepEqual(getCalledWrites().filter(w => w.startsWith('DELETE')), ['DELETE /contacts/cid-1']);
  assert.equal(JSON.parse(getPrinted()).data.name, 'Acme Co');
});

// ── upsert (de-dupe on email/phone) ─────────────────────────────────────────────
test('contact upsert: no --confirm → CONFIRM (5), no write fired', async () => {
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ confirmed: false });
  const code = await run({ _: ['upsert'], email: 'a@b.co', name: 'Acme Co' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.CONFIRM);
  assert.equal(getCalledWrites().length, 0);
  assert.ok(JSON.parse(getPrinted()).data.changes.some(c => /Upsert contact on email/.test(c)));
});

test('contact upsert: needs --email or --phone (the de-dupe key) → USAGE', async () => {
  const { ctx } = makeFakeCtx({ confirmed: true });
  await assert.rejects(() => run({ _: ['upsert'], name: 'Acme Co' }, ctx), /de-dupe key/i);
});

test('contact upsert: new:true → created, POST /contacts/upsert fires once', async () => {
  const fixture = { 'POST /contacts/upsert': { status: 200, j: { contact: { id: 'up-1' }, new: true } } };
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ confirmed: true, fixture });
  const code = await run({ _: ['upsert'], email: 'a@b.co' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(getCalledWrites().filter(w => w.startsWith('POST /contacts/upsert')).length, 1);
  const d = JSON.parse(getPrinted()).data;
  assert.equal(d.created, true); assert.equal(d.updated, false); assert.equal(d.contactId, 'up-1');
});

test('contact upsert: new:false → updated (de-dupe, no duplicate)', async () => {
  const fixture = { 'POST /contacts/upsert': { status: 200, j: { contact: { id: 'up-1' }, new: false } } };
  const { ctx, getPrinted } = makeFakeCtx({ confirmed: true, fixture });
  await run({ _: ['upsert'], email: 'a@b.co' }, ctx);
  ctx.out.flush();
  const d = JSON.parse(getPrinted()).data;
  assert.equal(d.created, false); assert.equal(d.updated, true);
});

test('contact upsert: 401 → AUTH + contacts.write guidance', async () => {
  const fixture = { 'POST /contacts/upsert': { status: 401, j: {} } };
  const { ctx } = makeFakeCtx({ confirmed: true, fixture });
  await assert.rejects(() => run({ _: ['upsert'], email: 'a@b.co' }, ctx),
    (e) => { assert.equal(e.code, EXIT.AUTH); assert.match(e.message, /contacts\.write/); return true; });
});

// GHL's /contacts/upsert treats `tags` as the FULL desired list, not additive — verified live
// 2026-07-05: upserting an existing contact with --tag "x" wiped every other tag it had. sizmo
// now looks the contact up first and merges --tag's value into its existing tags before sending.
test('contact upsert --tag: merges with the existing contact\'s current tags — does not wipe them', async () => {
  const fixture = {
    'GET /contacts/?locationId=L-TEST&query=a%40b.co&limit=20': {
      status: 200, j: { contacts: [{ id: 'up-1', email: 'a@b.co', tags: ['vip', 'source-fb'] }] },
    },
    'POST /contacts/upsert': { status: 200, j: { contact: { id: 'up-1' }, new: false } },
  };
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, fixture });
  const code = await run({ _: ['upsert'], email: 'a@b.co', tag: 'follow-up' }, ctx);
  assert.equal(code, EXIT.OK);
  const body = getCalledBodies().find(b => b.path === '/contacts/upsert').body;
  assert.deepEqual(new Set(body.tags), new Set(['vip', 'source-fb', 'follow-up']), 'existing tags preserved, new tag added');
});

test('contact upsert --tag preview (no --confirm) names the merge so nothing is a surprise', async () => {
  const fixture = {
    'GET /contacts/?locationId=L-TEST&query=a%40b.co&limit=20': {
      status: 200, j: { contacts: [{ id: 'up-1', email: 'a@b.co', tags: ['vip', 'source-fb'] }] },
    },
  };
  const { ctx, getPrinted } = makeFakeCtx({ confirmed: false, fixture });
  const code = await run({ _: ['upsert'], email: 'a@b.co', tag: 'follow-up' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.CONFIRM);
  const changes = JSON.parse(getPrinted()).data.changes;
  assert.match(changes.find(c => c.includes('tags:')), /merged with 2 existing tag/);
});

test('contact upsert --tag on a brand-new contact (no match found): sends just the given tag, no merge needed', async () => {
  const fixture = {
    'GET /contacts/?locationId=L-TEST&query=new%40b.co&limit=20': { status: 200, j: { contacts: [] } },
    'POST /contacts/upsert': { status: 200, j: { contact: { id: 'up-2' }, new: true } },
  };
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, fixture });
  const code = await run({ _: ['upsert'], email: 'new@b.co', tag: 'follow-up' }, ctx);
  assert.equal(code, EXIT.OK);
  const body = getCalledBodies().find(b => b.path === '/contacts/upsert').body;
  assert.deepEqual(body.tags, ['follow-up']);
});

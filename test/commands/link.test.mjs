// test/commands/link.test.mjs — trigger link create + single-target delete (confirm-gated).
import { test } from 'node:test';
import assert from 'node:assert';
import { run } from '../../commands/link.mjs';
import { makeFakeCtx } from '../_helpers.mjs';
import { EXIT } from '../../lib/errors.mjs';

test('link create: no --confirm → CONFIRM (5), no write fired', async () => {
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ confirmed: false });
  const code = await run({ _: ['create'], name: 'Book a call', 'redirect-to': 'https://example.com/book' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.CONFIRM);
  assert.equal(getCalledWrites().length, 0);
  assert.ok(JSON.parse(getPrinted()).data.changes.some(c => /Create trigger link "Book a call"/.test(c)));
});

test('link create: --confirm → POST /links/ fires once, exit 0, body has name + redirectTo', async () => {
  const fixture = { 'POST /links/': { status: 200, j: { link: { id: 'link-1', name: 'Book a call' } } } };
  const { ctx, getPrinted, getCalledWrites, getCalledBodies } = makeFakeCtx({ confirmed: true, fixture });
  const code = await run({ _: ['create'], name: 'Book a call', 'redirect-to': 'https://example.com/book' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(getCalledWrites().filter(w => w.startsWith('POST /links/')).length, 1);
  const body = getCalledBodies().find(b => b.path === '/links/').body;
  assert.equal(body.name, 'Book a call');
  assert.equal(body.redirectTo, 'https://example.com/book');
  const d = JSON.parse(getPrinted()).data;
  assert.equal(d.linkId, 'link-1'); assert.equal(d.name, 'Book a call');
});

test('link create: no --name → USAGE', async () => {
  const { ctx } = makeFakeCtx({ confirmed: true });
  await assert.rejects(() => run({ _: ['create'], 'redirect-to': 'https://x.com' }, ctx), /needs --name/i);
});

test('link create: no --redirect-to → USAGE', async () => {
  const { ctx } = makeFakeCtx({ confirmed: true });
  await assert.rejects(() => run({ _: ['create'], name: 'X' }, ctx), /--redirect-to/i);
});

test('link create: 401 → AUTH + links.write guidance', async () => {
  const fixture = { 'POST /links/': { status: 401, j: {} } };
  const { ctx } = makeFakeCtx({ confirmed: true, fixture });
  await assert.rejects(() => run({ _: ['create'], name: 'X', 'redirect-to': 'https://x.com' }, ctx),
    (e) => { assert.equal(e.code, EXIT.AUTH); assert.match(e.message, /links\.write/); return true; });
});

test('link delete: no id → USAGE (never bulk)', async () => {
  const { ctx } = makeFakeCtx({ confirmed: true });
  await assert.rejects(() => run({ _: ['delete'] }, ctx), /exactly one id/i);
});

test('link delete: wrong id → NOTFOUND, nothing deleted', async () => {
  const fixture = { 'GET /links/id/nope?locationId=L-TEST': { status: 404, j: {} } };
  const { ctx, getCalledWrites } = makeFakeCtx({ confirmed: true, fixture });
  await assert.rejects(() => run({ _: ['delete', 'nope'] }, ctx),
    (e) => { assert.equal(e.code, EXIT.NOTFOUND); return true; });
  assert.equal(getCalledWrites().filter(w => w.startsWith('DELETE')).length, 0, 'no DELETE on a bad id');
});

test('link delete: --confirm → fetch-then-delete via the /id/ path, names it, single DELETE', async () => {
  const fixture = {
    'GET /links/id/link-9?locationId=L-TEST': { status: 200, j: { link: { id: 'link-9', name: 'Old Promo' } } },
    'DELETE /links/link-9': { status: 200, j: {} },
  };
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ confirmed: true, fixture });
  const code = await run({ _: ['delete', 'link-9'] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.deepEqual(getCalledWrites().filter(w => w.startsWith('DELETE')), ['DELETE /links/link-9']);
  assert.equal(JSON.parse(getPrinted()).data.name, 'Old Promo');
});

test('link delete: no --confirm → CONFIRM (5), names the target, no DELETE', async () => {
  const fixture = { 'GET /links/id/link-9?locationId=L-TEST': { status: 200, j: { link: { id: 'link-9', name: 'Old Promo' } } } };
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ confirmed: false, fixture });
  const code = await run({ _: ['delete', 'link-9'] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.CONFIRM);
  assert.equal(getCalledWrites().filter(w => w.startsWith('DELETE')).length, 0);
  assert.ok(JSON.parse(getPrinted()).data.changes.some(c => /Delete trigger link "Old Promo"/.test(c)));
});

test('link: unknown subcommand → USAGE', async () => {
  const { ctx } = makeFakeCtx({ confirmed: true });
  await assert.rejects(() => run({ _: ['frobnicate'] }, ctx), /usage/i);
});

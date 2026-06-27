// test/commands/invoice.test.mjs — draft + send (scope-gated, confirm-gated money ops).
import { test } from 'node:test';
import assert from 'node:assert';
import { run } from '../../commands/invoice.mjs';
import { makeFakeCtx } from '../_helpers.mjs';
import { EXIT } from '../../lib/errors.mjs';

// draft fetches the contact + location, then POSTs /invoices/
const draftFixture = {
  'GET /contacts/cid-1': { status: 200, j: { contact: { id: 'cid-1', firstName: 'Acme', email: 'a@b.co' } } },
  'GET /locations/L-TEST': { status: 200, j: { location: { business: { name: 'CoreSyndicate' } } } },
  'POST /invoices/': { status: 200, j: { invoice: { _id: 'inv-1' } } },
};

test('invoice draft: --confirm → POST /invoices/ fires once, exit 0', async () => {
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ confirmed: true, fixture: draftFixture });
  const code = await run({ _: ['draft'], contact: 'cid-1', item: 'Consulting:5000', currency: 'PHP' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(getCalledWrites().filter(w => w === 'POST /invoices/').length, 1);
  assert.equal(JSON.parse(getPrinted()).data.invoiceId, 'inv-1');
});

test('invoice draft: no --confirm → CONFIRM (5), no write, preview says draft-not-sent', async () => {
  const { ctx, getPrinted, getCalledWrites } = makeFakeCtx({ confirmed: false, fixture: draftFixture });
  const code = await run({ _: ['draft'], contact: 'cid-1', item: 'Consulting:5000' }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.CONFIRM);
  assert.equal(getCalledWrites().length, 0, 'no POST without --confirm');
  const env = JSON.parse(getPrinted());
  assert.ok(env.data.changes.some(c => /DRAFT invoice/.test(c)));
  assert.ok(env.data.changes.some(c => /NOT sent, no charge/i.test(c)), 'preview states no charge');
});

test('invoice draft: missing --contact / --item → USAGE', async () => {
  const { ctx } = makeFakeCtx({ confirmed: true });
  await assert.rejects(() => run({ _: ['draft'], item: 'X:1' }, ctx), /--contact/i);
  await assert.rejects(() => run({ _: ['draft'], contact: 'cid-1' }, ctx), /--item/i);
});

test('invoice draft: bad --item amount → USAGE', async () => {
  const { ctx } = makeFakeCtx({ confirmed: true });
  await assert.rejects(() => run({ _: ['draft'], contact: 'cid-1', item: 'Consulting:abc' }, ctx), /bad --item/i);
});

test('invoice draft: 401 on invoice POST → AUTH + invoices.write', async () => {
  const fixture = { ...draftFixture, 'POST /invoices/': { status: 401, j: {} } };
  const { ctx } = makeFakeCtx({ confirmed: true, fixture });
  await assert.rejects(() => run({ _: ['draft'], contact: 'cid-1', item: 'X:100' }, ctx),
    (e) => { assert.equal(e.code, EXIT.AUTH); assert.match(e.message, /invoices\.write/); return true; });
});

test('invoice send: --confirm → POST /invoices/{id}/send once, exit 0', async () => {
  const fixture = { 'POST /invoices/inv-9/send': { status: 200, j: { success: true } } };
  const { ctx, getCalledWrites } = makeFakeCtx({ confirmed: true, fixture });
  const code = await run({ _: ['send', 'inv-9'] }, ctx);
  assert.equal(code, EXIT.OK);
  assert.deepEqual(getCalledWrites().filter(w => w.startsWith('POST')), ['POST /invoices/inv-9/send']);
});

test('invoice send: no --confirm → CONFIRM, no write; no id → USAGE', async () => {
  const { ctx, getCalledWrites } = makeFakeCtx({ confirmed: false });
  const code = await run({ _: ['send', 'inv-9'] }, ctx);
  ctx.out.flush();
  assert.equal(code, EXIT.CONFIRM);
  assert.equal(getCalledWrites().length, 0);
  const { ctx: ctx2 } = makeFakeCtx({ confirmed: true });
  await assert.rejects(() => run({ _: ['send'] }, ctx2), /exactly one id/i);
});

test('invoice: unknown subcommand → USAGE', async () => {
  const { ctx } = makeFakeCtx();
  await assert.rejects(() => run({ _: ['frobnicate'] }, ctx), /usage/i);
});

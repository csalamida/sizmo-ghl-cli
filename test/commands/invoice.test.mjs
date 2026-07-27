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

// ─────────────────────────────────────────────────────────────────────────────
// BODY ASSERTIONS — added 2026-07-27 (lens 4: test depth)
//
// Ranked by assertion depth, this file was among the three WRITE commands whose tests never
// inspected what would actually be transmitted (tag and note were the others). Every test above
// checks an exit code or that a call happened. None checked the payload — so any field could be
// renamed, dropped or fabricated and the suite stayed green while the real API received garbage.
//
// invoice was picked first because it is the money surface: these fields become a document a
// paying customer reads. Writing these tests immediately surfaced two live defects, both fixed in
// commands/invoice.mjs and pinned below.
// ─────────────────────────────────────────────────────────────────────────────

const bodyOf = (bodies, path) => bodies.find(b => b.path === path)?.body;

test('invoice draft: the POST body carries every field GHL requires, in the right shape', async () => {
  const { ctx, getCalledBodies } = makeFakeCtx({
    confirmed: true, fixture: draftFixture, now: Date.UTC(2026, 6, 27),
  });
  await run({ _: ['draft'], contact: 'cid-1', item: 'Consulting:5000', currency: 'php' }, ctx);
  ctx.out.flush();
  const b = bodyOf(getCalledBodies(), '/invoices/');

  // altId/altType, NOT locationId — the invoices/payments family rejects locationId. A regression
  // here 4xxs against the real API while every exit-code test still passes.
  assert.equal(b.altId, 'L-TEST');
  assert.equal(b.altType, 'location');
  assert.ok(!('locationId' in b), 'the invoices API takes altId, never locationId');

  assert.equal(b.currency, 'PHP', '--currency php must be upper-cased before transmission');
  assert.equal(b.liveMode, true);
  assert.equal(b.issueDate, '2026-07-27');
  assert.equal(b.dueDate, '2026-08-10', 'default due date is issue + 14 days');
  assert.equal(b.businessDetails.name, 'CoreSyndicate');
});

test('invoice draft: items carry name/amount/qty/currency, qty defaults to 1', async () => {
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, fixture: draftFixture });
  await run({ _: ['draft'], contact: 'cid-1', item: 'Setup:5000, Retainer:3000:2' }, ctx);
  ctx.out.flush();
  const b = bodyOf(getCalledBodies(), '/invoices/');
  assert.deepEqual(b.items, [
    { name: 'Setup',    currency: 'PHP', amount: 5000, qty: 1 },
    { name: 'Retainer', currency: 'PHP', amount: 3000, qty: 2 },
  ], 'multi-item parsing must survive intact to the wire — amounts are money');
});

test('invoice draft: contactDetails uses phoneNo (GHL spelling), not phone', async () => {
  // A rename to `phone` would be silently dropped by GHL — the invoice would go out with no phone
  // number and nothing would fail. Only a body assertion can catch this class.
  const fixture = {
    ...draftFixture,
    'GET /contacts/cid-1': {
      status: 200,
      j: { contact: { id: 'cid-1', firstName: 'Ana', lastName: 'Cruz', email: 'ana@x.co', phone: '+639171234567' } },
    },
  };
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, fixture });
  await run({ _: ['draft'], contact: 'cid-1', item: 'X:100' }, ctx);
  ctx.out.flush();
  const cd = bodyOf(getCalledBodies(), '/invoices/').contactDetails;
  assert.equal(cd.id, 'cid-1');
  assert.equal(cd.name, 'Ana Cruz', 'first+last must be joined for the invoice name');
  assert.equal(cd.email, 'ana@x.co');
  assert.equal(cd.phoneNo, '+639171234567', 'GHL expects phoneNo — `phone` is silently ignored');
  assert.ok(!('phone' in cd));
});

test('invoice draft: a contact with no email/phone omits those keys, never sends null', async () => {
  const fixture = {
    ...draftFixture,
    'GET /contacts/cid-1': { status: 200, j: { contact: { id: 'cid-1', firstName: 'Solo' } } },
  };
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, fixture });
  await run({ _: ['draft'], contact: 'cid-1', item: 'X:100' }, ctx);
  ctx.out.flush();
  const cd = bodyOf(getCalledBodies(), '/invoices/').contactDetails;
  assert.ok(!('email' in cd) && !('phoneNo' in cd),
    'absent contact fields must be OMITTED from the body, never present-and-null');
});

test('invoice draft: --due overrides the computed due date verbatim', async () => {
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, fixture: draftFixture });
  await run({ _: ['draft'], contact: 'cid-1', item: 'X:100', due: '2026-12-25' }, ctx);
  ctx.out.flush();
  assert.equal(bodyOf(getCalledBodies(), '/invoices/').dueDate, '2026-12-25');
});

// ── the fabrication defects, found by writing the tests above ────────────────

for (const [label, locFix, wantCode] of [
  ['401', { status: 401, j: {} }, EXIT.AUTH],
  ['403', { status: 403, j: {} }, EXIT.AUTH],
  ['404', { status: 404, j: {} }, EXIT.API],
  ['500', { status: 500, j: {} }, EXIT.API],
]) {
  test(`invoice draft: location read ${label} REFUSES — never invents a business name`, async () => {
    // Until 2026-07-27 this response was unchecked. All four of these produced
    // businessDetails={"name":"Business"}, created the invoice, and exited 0 — so a paying
    // customer received a document naming the vendor "Business". sizmo already refuses to
    // fabricate numbers on a blocked source; a fabricated vendor NAME on a money document is the
    // same rule with a more visible consequence.
    const { ctx, getCalledWrites } = makeFakeCtx({
      confirmed: true,
      fixture: { ...draftFixture, 'GET /locations/L-TEST': locFix },
    });
    await assert.rejects(
      () => run({ _: ['draft'], contact: 'cid-1', item: 'X:100' }, ctx),
      (e) => e.code === wantCode,
      `location ${label} must abort the draft, not fall back to a placeholder name`);
    assert.deepEqual(getCalledWrites(), [],
      'no invoice may be created when the business name could not be read');
  });
}

test('invoice draft: a location with NO business name refuses rather than shipping a placeholder', async () => {
  const { ctx, getCalledWrites } = makeFakeCtx({
    confirmed: true,
    fixture: { ...draftFixture, 'GET /locations/L-TEST': { status: 200, j: { location: {} } } },
  });
  await assert.rejects(
    () => run({ _: ['draft'], contact: 'cid-1', item: 'X:100' }, ctx),
    (e) => e.code === EXIT.API && /business name/i.test(e.message));
  assert.deepEqual(getCalledWrites(), []);
});

test('invoice draft: contact 401 blames contacts.readonly, NOT invoices.write', async () => {
  // The failing call is GET /contacts/{id}. Blaming invoices.write sent the user to add a scope
  // they already had, while the scope actually missing stayed missing.
  const { ctx } = makeFakeCtx({
    confirmed: true,
    fixture: { ...draftFixture, 'GET /contacts/cid-1': { status: 401, j: {} } },
  });
  await assert.rejects(
    () => run({ _: ['draft'], contact: 'cid-1', item: 'X:100' }, ctx),
    (e) => e.code === EXIT.AUTH
        && /contacts\.readonly/.test(e.message)
        && !/invoices\.write/.test(e.message));
});

test('invoice send: body uses altId/altType + liveMode, and targets the right invoice', async () => {
  const fixture = { 'POST /invoices/inv-9/send': { status: 200, j: { invoice: { _id: 'inv-9' } } } };
  const { ctx, getCalledBodies } = makeFakeCtx({ confirmed: true, fixture });
  await run({ _: ['send', 'inv-9'] }, ctx);
  ctx.out.flush();
  const b = bodyOf(getCalledBodies(), '/invoices/inv-9/send');
  assert.equal(b.altId, 'L-TEST');
  assert.equal(b.altType, 'location');
  assert.equal(b.liveMode, true);
});

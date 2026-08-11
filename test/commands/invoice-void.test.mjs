// test/commands/invoice-void.test.mjs
//
// sizmo could create an invoice and send it to a customer, but not take it back. That asymmetry sat
// on a money surface, and on the one operation reached for in a hurry: "that should not have gone
// out". Without it the only route was the raw `sizmo api` escape hatch, under time pressure, against
// a document a customer has already seen.
//
// The design point under test is FETCH-FIRST. A void cannot be undone, so the preview names the
// RECORD — number, contact, amount, current status — not just the id that was typed. Approving
// `void inv_8f21c` is approving a string; approving "#1043 · Ana Cruz · ₱45,000 · sent" is approving
// the thing itself. Same reason `sizmo ask` refuses to fire a delete resolved from a sentence.
import { test } from 'node:test';
import assert from 'node:assert';
import { run } from '../../commands/invoice.mjs';
import { makeFakeCtx } from '../_helpers.mjs';
import { EXIT } from '../../lib/errors.mjs';

const invoice = (over = {}) => ({
  _id: 'inv_8f21c', invoiceNumber: '1043', status: 'sent', total: 45000, currency: 'PHP',
  contactDetails: { id: 'ct_1', name: 'Ana Cruz' }, ...over,
});

function mk({ confirmed = false, json = false, inv = invoice(), getCode = 200, postCode = 200 } = {}) {
  const h = makeFakeCtx({ json, confirmed });
  h.writes = [];
  h.reads = [];
  h.ctx.http.get = async (path, opts = {}) => {
    h.reads.push({ path, query: opts.query });
    return getCode === 200
      ? { code: 200, ok: true, txt: '{}', j: { invoice: inv } }
      : { code: getCode, ok: false, txt: 'nope', j: null };
  };
  h.ctx.http.post = async (path, body) => {
    h.writes.push({ path, body });
    return postCode === 200 ? { code: 200, ok: true, txt: '{}', j: {} }
                            : { code: postCode, ok: false, txt: 'nope', j: null };
  };
  return h;
}

test('the preview names the RECORD, not just the id', async () => {
  const h = mk();
  const code = await run({ _: ['void', 'inv_8f21c'] }, h.ctx);
  h.ctx.out.flush();
  const out = h.getPrinted();
  assert.equal(code, EXIT.CONFIRM);
  assert.match(out, /#1043/, 'the invoice number must be shown');
  assert.match(out, /Ana Cruz/, 'the contact must be shown');
  assert.match(out, /₱45,000/, 'the amount must be shown');
  assert.match(out, /current status: sent/, 'the current status must be shown');
  assert.match(out, /cannot be undone/);
});

test('nothing is voided without --confirm', async () => {
  const h = mk();
  await run({ _: ['void', 'inv_8f21c'] }, h.ctx);
  h.ctx.out.flush();
  assert.equal(h.writes.length, 0, 'a void fired before the human confirmed');
});

test('an ALREADY PAID invoice gets its own warning line', async () => {
  // The invoice you least want to void by accident. One word inside the status line is not enough.
  const h = mk({ inv: invoice({ status: 'paid' }) });
  await run({ _: ['void', 'inv_8f21c'] }, h.ctx);
  h.ctx.out.flush();
  assert.match(h.getPrinted(), /ALREADY PAID/);
});

test('partially_paid does NOT get the already-paid warning — the inverse guard', async () => {
  // Warning on every status that contains "paid" would make the loudest line meaningless.
  const h = mk({ inv: invoice({ status: 'partially_paid' }) });
  await run({ _: ['void', 'inv_8f21c'] }, h.ctx);
  h.ctx.out.flush();
  assert.ok(!/ALREADY PAID/.test(h.getPrinted()),
    'partially paid is not paid — the strongest warning must stay rare enough to read');
});

test('with --confirm it POSTs the documented body', async () => {
  // altId/altType are both REQUIRED per describe_operation on void-invoice. A missing altId is a 4xx
  // at best and the wrong location at worst.
  const h = mk({ confirmed: true });
  const code = await run({ _: ['void', 'inv_8f21c'] }, h.ctx);
  h.ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0].path, '/invoices/inv_8f21c/void');
  assert.deepEqual(h.writes[0].body, { altId: 'L-TEST', altType: 'location' });
});

test('it reads the invoice BEFORE writing, scoped to the location', async () => {
  const h = mk({ confirmed: true });
  await run({ _: ['void', 'inv_8f21c'] }, h.ctx);
  h.ctx.out.flush();
  assert.equal(h.reads[0].path, '/invoices/inv_8f21c');
  assert.deepEqual(h.reads[0].query, { altId: 'L-TEST', altType: 'location' });
});

test('an unreadable invoice is NOT voided — it refuses to act on what it cannot show', async () => {
  // The whole fetch-first premise. If the preview cannot be built, proceeding would mean the human
  // approved an id and nothing else.
  const h = mk({ confirmed: true, getCode: 500 });
  await assert.rejects(() => run({ _: ['void', 'inv_x'] }, h.ctx), (e) => {
    assert.equal(e.code, EXIT.API);
    assert.match(e.message, /Refusing to void a record I cannot show you/);
    return true;
  });
  assert.equal(h.writes.length, 0, 'it voided an invoice it could not read');
});

test('a missing invoice is NOTFOUND, not a server error', async () => {
  const h = mk({ confirmed: true, getCode: 404 });
  await assert.rejects(() => run({ _: ['void', 'gone'] }, h.ctx), (e) => e.code === EXIT.NOTFOUND);
  assert.equal(h.writes.length, 0);
});

test('the READ scope failure names invoices.readonly, the WRITE one names invoices.write', async () => {
  // Two different scopes on one command. Naming the wrong one sends someone to grant a permission
  // they already have while the real gap stays.
  const readFail = mk({ confirmed: true, getCode: 403 });
  await assert.rejects(() => run({ _: ['void', 'x'] }, readFail.ctx), (e) => {
    assert.equal(e.code, EXIT.AUTH);
    assert.match(e.remediation ?? '', /invoices\.readonly/);
    return true;
  });

  const writeFail = mk({ confirmed: true, postCode: 403 });
  await assert.rejects(() => run({ _: ['void', 'x'] }, writeFail.ctx), (e) => {
    assert.equal(e.code, EXIT.AUTH);
    assert.match(e.remediation ?? '', /invoices\.write/);
    return true;
  });
});

test('void is single-target — a second id is refused, not silently ignored', async () => {
  // A void loop typed by hand is exactly where a second id gets pasted by accident.
  const h = mk({ confirmed: true });
  await assert.rejects(() => run({ _: ['void', 'a', 'b'] }, h.ctx), (e) => {
    assert.equal(e.code, EXIT.USAGE);
    assert.match(e.message, /ONE id/);
    return true;
  });
  assert.equal(h.writes.length, 0);
});

test('a missing id is a usage error that says where to find one', async () => {
  const h = mk();
  await assert.rejects(() => run({ _: ['void'] }, h.ctx), (e) => {
    assert.equal(e.code, EXIT.USAGE);
    assert.match(e.remediation ?? '', /sizmo invoice list/);
    return true;
  });
});

test('the payload records what was voided, including its previous status', async () => {
  // "It is voided now" is not enough for an audit trail — what it WAS is the part you cannot recover.
  const h = mk({ confirmed: true, json: true });
  await run({ _: ['void', 'inv_8f21c'] }, h.ctx);
  h.ctx.out.flush();
  const d = JSON.parse(h.getPrinted()).data;
  assert.equal(d.invoiceId, 'inv_8f21c');
  assert.equal(d.number, '1043');
  assert.equal(d.contact, 'Ana Cruz');
  assert.equal(d.previousStatus, 'sent', 'the status before the void is the irrecoverable fact');
  assert.equal(d.total, 45000);
  assert.equal(d.currency, 'PHP');
});

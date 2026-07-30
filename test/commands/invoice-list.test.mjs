// test/commands/invoice-list.test.mjs
//
// `invoice draft` printed the new invoice's id exactly once, and `invoice send <id>` needs it. No
// command could find it again. `receivables` paginates every invoice but keeps only the
// unpaid-and-issued statuses, so a DRAFT is filtered out — correctly, since a draft is not
// receivable. Lose the terminal output and the draft was unreachable except through `sizmo api`.
//
// This reuses the request receivables has been paginating in production, so no new API assumption is
// introduced. Read-only.
import { test } from 'node:test';
import assert from 'node:assert';
import { run } from '../../commands/invoice.mjs';
import { makeFakeCtx } from '../_helpers.mjs';
import { EXIT } from '../../lib/errors.mjs';

const NOW = Date.parse('2026-07-30T00:00:00Z');
const inv = (id, status, total, daysAgo) => ({
  _id: id, invoiceNumber: id.replace('inv_', ''), status, total,
  amountPaid: status === 'paid' ? total : 0,
  name: 'Coaching ' + id, contactDetails: { id: 'ct_' + id, name: 'Client ' + id },
  currency: 'PHP',
  issueDate: new Date(NOW - daysAgo * 86400000).toISOString(),
  dueDate: new Date(NOW - daysAgo * 86400000 + 14 * 86400000).toISOString(),
});
const ALL = [
  inv('inv_1001', 'draft', 5000, 1),
  inv('inv_1002', 'sent', 12000, 3),
  inv('inv_1003', 'paid', 8000, 10),
  inv('inv_1004', 'draft', 2500, 0),
];

function harness({ json = true, invoices = ALL, pages = null } = {}) {
  const { ctx, getPrinted } = makeFakeCtx({ json, now: NOW });
  const seen = [];
  let call = 0;
  ctx.http.get = async (path, opts = {}) => {
    if (!path.includes('/invoices')) return { code: 200, ok: true, txt: '{}', j: {} };
    seen.push({ path, query: opts.query });
    if (pages) return pages(++call);
    return { code: 200, ok: true, txt: '{}', j: { invoices } };
  };
  return { ctx, getPrinted, seen };
}
const data = (h) => JSON.parse(h.getPrinted()).data;

test('list finds DRAFT invoices — the ones receivables filters out by design', async () => {
  // The whole reason the command exists.
  const h = harness();
  await run({ _: ['list'], status: 'draft' }, h.ctx);
  h.ctx.out.flush();
  const d = data(h);
  assert.equal(d.matched, 2);
  assert.deepEqual(d.invoices.map(i => i.id).sort(), ['inv_1001', 'inv_1004']);
  assert.ok(d.invoices.every(i => i.status === 'draft'));
});

test('every row carries the id that `invoice send` needs', async () => {
  const h = harness();
  await run({ _: ['list'] }, h.ctx);
  h.ctx.out.flush();
  for (const i of data(h).invoices) {
    assert.ok(i.id, 'a row with no id cannot be sent, which is the point of listing');
  }
});

test('the request matches the one receivables already paginates', async () => {
  // Pinned so this cannot drift onto an unproven param shape. altId/altType is what GHL wants here,
  // not locationId.
  const h = harness();
  await run({ _: ['list'] }, h.ctx);
  h.ctx.out.flush();
  assert.equal(h.seen[0].path, '/invoices/');
  assert.equal(h.seen[0].query.altId, 'L-TEST');
  assert.equal(h.seen[0].query.altType, 'location');
  assert.equal(h.seen[0].query.limit, 100);
  assert.equal(h.seen[0].query.offset, 0);
});

test('newest first, so the invoice you just drafted is the top row', async () => {
  const h = harness();
  await run({ _: ['list'] }, h.ctx);
  h.ctx.out.flush();
  assert.deepEqual(data(h).invoices.map(i => i.id),
    ['inv_1004', 'inv_1001', 'inv_1002', 'inv_1003'],
    'ordering must put the most recently issued first');
});

test('an unmatched --status names the statuses that DO exist', async () => {
  // Otherwise the user cannot tell "my filter is wrong" from "there are none".
  const h = harness({ json: false });
  await run({ _: ['list'], status: 'void' }, h.ctx);
  h.ctx.out.flush();
  const out = h.getPrinted();
  assert.match(out, /No invoice with status "void"/);
  assert.match(out, /Statuses present: draft, paid, sent/);
});

test('--status is matched case-insensitively and trimmed', async () => {
  const h = harness();
  await run({ _: ['list'], status: '  DRAFT ' }, h.ctx);
  h.ctx.out.flush();
  assert.equal(data(h).matched, 2, 'a stray capital or space must not silently return nothing');
});

test('byStatus counts the WHOLE scan, not just the filtered rows', async () => {
  // The summary has to describe the account, or it is useless next to a filter.
  const h = harness();
  await run({ _: ['list'], status: 'draft' }, h.ctx);
  h.ctx.out.flush();
  const d = data(h);
  assert.deepEqual(d.byStatus, { draft: 2, sent: 1, paid: 1 });
  assert.equal(d.scanned, 4, 'scanned is every invoice read');
  assert.equal(d.matched, 2, 'matched is what survived the filter');
});

test('--top limits rows shown but not rows counted', async () => {
  const h = harness();
  await run({ _: ['list'], top: 1 }, h.ctx);
  h.ctx.out.flush();
  const d = data(h);
  assert.equal(d.shown, 1);
  assert.equal(d.matched, 4, 'the count must not shrink to the display limit');
});

test('a bad --top is refused, never coerced', async () => {
  for (const bad of [0, -3, 1.5]) {
    const h = harness();
    await assert.rejects(() => run({ _: ['list'], top: bad }, h.ctx),
      (e) => e.code === EXIT.USAGE, `--top ${bad} was accepted`);
  }
});

test('a total failure is UNKNOWN and throws — never an empty list', async () => {
  // "You have no invoices" and "I could not read your invoices" are different answers, and only one
  // is safe to act on. An empty list here would read as a settled account.
  const h = harness({ pages: () => ({ code: 500, ok: false, txt: 'boom', j: null }) });
  await assert.rejects(() => run({ _: ['list'] }, h.ctx), (e) => {
    assert.equal(e.code, EXIT.API);
    return true;
  });
});

test('a scope failure names invoices.readonly, not the write scope', async () => {
  const h = harness({ pages: () => ({ code: 403, ok: false, txt: 'no', j: null }) });
  await assert.rejects(() => run({ _: ['list'] }, h.ctx), (e) => {
    assert.equal(e.code, EXIT.AUTH);
    assert.match(e.remediation ?? '', /invoices\.readonly/);
    assert.ok(!/invoices\.write/.test(e.remediation ?? ''), 'listing needs no write scope');
    return true;
  });
});

test('a page failing mid-scan makes the list a floor, not a fact', async () => {
  // Same rule as every other paginated report: what came back is real, the count is a floor.
  const full = Array.from({ length: 100 }, (_, i) => inv('inv_' + i, 'draft', 1000, i));
  const h = harness({ pages: (n) => n === 1
    ? { code: 200, ok: true, txt: '{}', j: { invoices: full } }
    : { code: 500, ok: false, txt: 'boom', j: null } });
  await run({ _: ['list'] }, h.ctx);
  h.ctx.out.flush();
  const env = JSON.parse(h.getPrinted());
  assert.equal(env.data.scanned, 100, 'the invoices that were read must still be reported');
  assert.equal(env.degraded, true, 'a partial list claimed to be complete');
  assert.equal(env.data.truncated, true);
  assert.ok(env.warnings.some(w => /floor|incomplete/i.test(w)));
});

test('a complete scan is not marked truncated — the inverse guard', async () => {
  const h = harness();
  await run({ _: ['list'] }, h.ctx);
  h.ctx.out.flush();
  const env = JSON.parse(h.getPrinted());
  assert.equal(env.degraded, false);
  assert.equal(env.data.truncated, undefined);
});

test('list never sends a write, even with --confirm', async () => {
  const h = harness();
  let wrote = 0;
  for (const m of ['post', 'put', 'delete']) h.ctx.http[m] = async () => { wrote++; return { code: 200, ok: true, j: {} }; };
  h.ctx.confirmed = true;
  const code = await run({ _: ['list'] }, h.ctx);
  h.ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.equal(wrote, 0, 'listing issued a write request');
});

test('money is rendered through the shared formatter', async () => {
  // A fractional amount must not be rounded per row here either — that bug was fixed tool-wide and
  // a new surface is exactly where it would reappear.
  const h = harness({ json: false, invoices: [inv('inv_x', 'draft', 100.5, 0)] });
  await run({ _: ['list'] }, h.ctx);
  h.ctx.out.flush();
  assert.match(h.getPrinted(), /₱100\.50/,
    'a fractional total must show its cents, not round to ₱101');
});

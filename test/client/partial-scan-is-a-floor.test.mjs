// test/client/partial-scan-is-a-floor.test.mjs
//
// Every paginated report guarded blindness with the same shape:
//     if (firstErr && items.length === 0) { ...report blocked... }
// which fires ONLY when the very FIRST page fails. Page 1 succeeding and a later page failing
// discarded the captured HTTP code and emitted the partial result as complete.
//
// Measured 2026-07-30 on receivables, page 1 returning 100 invoices of ₱1,000 and page 2 a 500:
//     exit 0 · degraded false · warnings [] · outstanding 100 · totalOwed 100000
// The true figure was unknown and at least ₱100,000, presented as exactly ₱100,000. Same violation
// the maxPages truncation work fixed, in the error dimension: an incomplete answer must never render
// as a complete one, and on a money surface it under-reports what is owed.
//
// NOT blocked — the records that came back are real. The total is a FLOOR.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFakeCtx } from '../_helpers.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NOW = Date.parse('2026-07-30T00:00:00Z');

// A paginated endpoint whose first page is FULL (so pagination continues) and whose second fails.
// `pageOne` must return a full page or the generator stops before the failure is ever reached — an
// earlier draft returned 3 items and the second page was never requested, so nothing was proven.
function failOnSecondPage(match, pageOne, status = 500) {
  let calls = 0;
  return async (path) => {
    if (!path.includes(match)) return { code: 200, ok: true, txt: '{}', j: {} };
    if (++calls === 1) return { code: 200, ok: true, txt: '{}', j: pageOne };
    return { code: status, ok: false, txt: 'upstream failed', j: null };
  };
}

const invoices = (n) => Array.from({ length: n }, (_, i) => ({
  _id: 'i' + i, invoiceNumber: String(1000 + i), status: 'sent', total: 1000, amountPaid: 0,
  dueDate: new Date(NOW - 40 * 86400000).toISOString(),
  contactDetails: { id: 'c' + i, name: 'Client ' + i }, currency: 'PHP',
}));

async function runWith(modPath, httpGet, args = {}) {
  const { run } = await import(modPath);
  const { ctx, getPrinted } = makeFakeCtx({ json: true, now: NOW });
  ctx.http.get = httpGet;
  ctx.ensureModel = async () => ({ entities: {} });
  const code = await run({ _: [], ...args }, ctx);
  ctx.out.flush();
  return { code, env: JSON.parse(getPrinted()) };
}

test('receivables: a failed second page makes the A/R total a floor, not a fact', async () => {
  const { env } = await runWith('../../commands/receivables.mjs',
    failOnSecondPage('/invoices', { invoices: invoices(100) }));
  assert.equal(env.data.outstanding, 100, 'the invoices that WERE read must still be reported');
  assert.equal(env.degraded, true,
    'a report missing an unknown number of invoices claimed to be complete');
  assert.equal(env.data.truncated, true, 'the payload must mark itself incomplete');
  assert.equal(env.data.partialScanError, 500, 'the HTTP code that caused it must survive');
  assert.ok(env.warnings.some(w => /500/.test(w) && /floor|incomplete/i.test(w)),
    `no warning named the failure and its consequence: ${JSON.stringify(env.warnings)}`);
});

test('receivables: the human line says "at least" when the scan was partial', async () => {
  const { run } = await import('../../commands/receivables.mjs');
  const { ctx, getPrinted } = makeFakeCtx({ json: false, now: NOW });
  ctx.http.get = failOnSecondPage('/invoices', { invoices: invoices(100) });
  await run({ _: [] }, ctx);
  ctx.out.flush();
  const printed = getPrinted();
  assert.match(printed, /at least/,
    'the header states a partial total as if it were the whole figure');
  assert.match(printed, /INCOMPLETE/, 'nothing on the card says a page failed');
});

test('a COMPLETE scan says nothing about truncation — the inverse guard', async () => {
  // The over-correction to guard against: warning on every run would make the signal meaningless
  // and mark healthy reports degraded.
  const { env } = await runWith('../../commands/receivables.mjs',
    async (p) => p.includes('/invoices')
      ? { code: 200, ok: true, txt: '{}', j: { invoices: invoices(3) } }   // short page = end of data
      : { code: 200, ok: true, txt: '{}', j: {} });
  assert.equal(env.data.outstanding, 3);
  assert.equal(env.degraded, false, 'a complete scan was marked degraded');
  assert.equal(env.data.truncated, undefined, 'a complete scan claimed to be truncated');
  assert.deepEqual(env.warnings, [], `a complete scan emitted warnings: ${JSON.stringify(env.warnings)}`);
});

test('a first-page failure is still BLOCKED, not merely a floor', async () => {
  // The distinction that matters: nothing came back at all, so the answer is UNKNOWN rather than a
  // floor. Collapsing the two would report totalOwed as a number when no invoice was ever seen.
  const { env } = await runWith('../../commands/receivables.mjs',
    async (p) => p.includes('/invoices')
      ? { code: 401, ok: false, txt: 'nope', j: null }
      : { code: 200, ok: true, txt: '{}', j: {} });
  assert.equal(env.data.blocked, 401);
  assert.strictEqual(env.data.totalOwed, null,
    'a total was reported for invoices that were never read — blocked is UNKNOWN, never a number');
  assert.equal(env.degraded, true);
});

test('reconcile: collected AND the flag counts are floors when a page failed', async () => {
  const txns = Array.from({ length: 100 }, (_, i) => ({
    _id: 't' + i, amount: 500, status: 'succeeded', currency: 'PHP',
    createdAt: new Date(NOW - 2 * 86400000).toISOString(),
  }));
  const { env } = await runWith('../../commands/reconcile.mjs',
    failOnSecondPage('/payments/transactions', { data: txns }));
  assert.equal(env.degraded, true, 'a partially-read ledger reported as complete');
  assert.equal(env.data.truncated, true);
  // "0 refunds / 0 failed / 0 orphans" on a partial ledger is an all-clear nobody verified.
  assert.ok(env.warnings.some(w => /floor|incomplete/i.test(w)),
    'the flag counts are floors too and nothing said so');
});

test('every paginated command reports a partial scan — no command left behind', () => {
  // The structural guard. Six commands had the identical bug; a seventh added later would have it
  // too unless something checks. Any command that captures a paginated page error must also feed it
  // to notePartialScan, not only to a `count === 0` blindness branch.
  // booked-not-paid is exempt, and it is a REFUTATION rather than a waiver: it never had this bug.
  // It warns with degraded:true on ANY captured page error (not gated on a zero count), and then
  // SUPPRESSES the never-billed bucket outright rather than presenting a partial one — a stricter
  // response than marking the result a floor, because a partial invoice list would falsely accuse a
  // client of not having been billed. This guard flagged it purely for not calling the shared helper.
  const ALLOWED = new Set(['booked-not-paid.mjs']);
  const offenders = [];
  for (const f of readdirSync(join(REPO, 'commands')).filter(f => f.endsWith('.mjs'))) {
    if (ALLOWED.has(f)) continue;
    const src = readFileSync(join(REPO, 'commands', f), 'utf8')
      .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');     // CODE only
    // Does it capture a per-page error at all? That is the `{ _err: r.code` idiom every caller uses.
    if (!/_err:\s*r\.code/.test(src)) continue;
    if (!/notePartialScan/.test(src)) offenders.push(f);
  }
  assert.deepEqual(offenders, [],
    `These paginate and capture a page error but never report a PARTIAL scan: ${offenders.join(', ')}. ` +
    `A "count === 0" branch only catches a first-page failure; a later page failing silently ships a ` +
    `truncated result as fact.`);
});

test('booked-not-paid warns and degrades on ANY invoice page error, not only a first-page one', () => {
  // The evidence behind the exemption above. Asserted on source because the command needs a full
  // calendar+invoice+payment fixture to reach the branch, and an earlier probe of mine silently
  // returned before the invoice fetch ran — proving nothing while looking like a clean result.
  const src = readFileSync(join(REPO, 'commands', 'booked-not-paid.mjs'), 'utf8')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');       // CODE only
  assert.match(src, /if \(invBlocked\) ctx\.out\.warn\(/,
    'the invoice-error warning must fire on the flag alone, with no count condition');
  assert.match(src, /if \(payBlocked\) ctx\.out\.warn\(/,
    'same for the payments error');
  assert.ok(!/invBlocked && inv\.length === 0/.test(src),
    'a count===0 condition would reintroduce exactly the bug this file is about');
  assert.match(src, /!invBlocked && !payBlocked\) neverBilled\.push/,
    'the never-billed bucket must stay suppressed while either source is incomplete — a partial ' +
    'invoice list would accuse a client who was in fact billed');
});

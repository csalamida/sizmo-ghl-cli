// test/commands/triage-concurrency.test.mjs
//
// triage fetches a last-inbound snippet per shown thread. That loop used to be
//     for (const c of top) { c._snippet = await lastInbound(c.id); }
// which is strictly sequential and scales linearly with --top. Measured 2026-07-28 at 10ms
// simulated latency:
//     default (--top 10)   10 fetches  maxConcurrent=1  114ms
//     --top 100           100 fetches  maxConcurrent=1 1118ms
// A real GoHighLevel round-trip is ~150ms, so --top 100 spent ~15s waiting one request at a time,
// and brief and focus both call triage.
//
// commands/noshow.mjs and lib/diagnose.mjs already fan out identical per-item work with
// mapLimit(…, 5). triage had simply never been switched over.
//
// A perf property needs a test that OBSERVES concurrency — a mutation reverting to the sequential
// loop left the whole suite green, because every other assertion only checks output.
import { test } from 'node:test';
import assert from 'node:assert';
import { run } from '../../commands/triage.mjs';
import { makeFakeCtx } from '../_helpers.mjs';

// Instrument triage's message fetches: count them, and record how many are ever in flight at once.
//
// Release is gated on reaching the expected concurrency, with a timer fallback so a SEQUENTIAL
// regression fails the assertion instead of hanging the suite forever.
function harness({ threads = 12, expectConcurrency = 5 } = {}) {
  const { ctx } = makeFakeCtx({ json: true });
  const state = { search: 0, msgs: 0, inFlight: 0, maxInFlight: 0 };
  let release = null;
  const gate = new Promise((r) => { release = r; });
  const fallback = setTimeout(() => release?.(), 250);

  ctx.ensureModel = async () => ({ entities: {} });
  ctx.http.get = async (path) => {
    const p = String(path);
    if (p.includes('/conversations/search')) {
      state.search++;
      return { code: 200, ok: true, txt: '{}', j: { conversations: Array.from({ length: threads }, (_, i) => ({
        id: `cv${i}`, contactId: `c${i}`, contactName: `N${i}`,
        lastMessageDate: Date.now() - 3600_000, unreadCount: 1, lastMessageType: 'TYPE_SMS' })) } };
    }
    state.msgs++;
    state.inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    if (state.inFlight >= expectConcurrency) release?.();   // enough overlap observed
    await gate;
    state.inFlight--;
    return { code: 200, ok: true, txt: '{}',
             j: { messages: { messages: [{ direction: 'inbound', body: 'hello', dateAdded: '2026-07-01' }] } } };
  };
  return { ctx, state, done: () => clearTimeout(fallback) };
}

test('triage fetches snippets CONCURRENTLY, not one at a time', async () => {
  const h = harness({ threads: 12 });
  await run({}, h.ctx);
  h.ctx.out.flush();
  h.done();
  assert.ok(h.state.msgs > 1, `sanity: expected several snippet fetches, got ${h.state.msgs}`);
  assert.ok(h.state.maxInFlight > 1,
    `snippet fetches ran strictly one at a time (maxConcurrent=${h.state.maxInFlight}). At a real ` +
    `~150ms round-trip that is ${h.state.msgs} x 150ms of serial waiting, and brief and focus both ` +
    `call triage. Use mapLimit like noshow does.`);
});

test('triage stays within the shared concurrency cap of 5 — polite to the rate limiter', async () => {
  // The inverse guard. Unbounded fan-out would be faster still and would get the account 429'd;
  // 5 is the cap noshow and diagnose already use, so the policy stays in one place.
  const h = harness({ threads: 40, expectConcurrency: 5 });
  await run({ top: 40 }, h.ctx);
  h.ctx.out.flush();
  h.done();
  assert.ok(h.state.maxInFlight <= 5,
    `fan-out reached ${h.state.maxInFlight} concurrent requests, above the shared cap of 5`);
});

test('triage does not fetch MORE than one snippet per shown thread', async () => {
  // Guards against the other way to "speed things up": firing extra requests. The change was meant
  // to buy latency, not spend API calls — which matters on an account near its rate limit.
  const h = harness({ threads: 12 });
  await run({ top: 5 }, h.ctx);
  h.ctx.out.flush();
  h.done();
  assert.equal(h.state.msgs, 5, `expected exactly one fetch per shown thread, got ${h.state.msgs}`);
});

test('every shown thread still gets its snippet — parallelising must not drop data', async () => {
  const { ctx, getPrinted } = makeFakeCtx({ json: true });
  ctx.ensureModel = async () => ({ entities: {} });
  ctx.http.get = async (path) => {
    const p = String(path);
    if (p.includes('/conversations/search')) {
      return { code: 200, ok: true, txt: '{}', j: { conversations: Array.from({ length: 6 }, (_, i) => ({
        id: `cv${i}`, contactId: `c${i}`, contactName: `N${i}`,
        lastMessageDate: Date.now() - 3600_000, unreadCount: 1, lastMessageType: 'TYPE_SMS' })) } };
    }
    // Each conversation returns a snippet naming ITS OWN id, so a mix-up is detectable.
    const id = p.match(/conversations\/([^/]+)\/messages/)?.[1] ?? '?';
    return { code: 200, ok: true, txt: '{}',
             j: { messages: { messages: [{ direction: 'inbound', body: `snippet-for-${id}`, dateAdded: '2026-07-01' }] } } };
  };
  await run({ top: 6 }, ctx);
  ctx.out.flush();
  const threads = JSON.parse(getPrinted()).data.threads;
  assert.equal(threads.length, 6);
  for (const t of threads) {
    assert.equal(t.snippet, `snippet-for-${t.conversationId}`,
      `thread ${t.conversationId} got the wrong snippet (${t.snippet}) — a concurrent write landed ` +
      `on the wrong object`);
  }
});

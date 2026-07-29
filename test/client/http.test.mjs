import { test } from 'node:test';
import assert from 'node:assert';
import { makeHttp } from '../../lib/http.mjs';

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url) => { calls.push(String(url)); const r = responses.shift();
    return { status: r.status, headers: new Map(Object.entries(r.headers||{})), text: async () => r.body ?? '' }; };
  fn.calls = calls; return fn;
}

test('GET returns parsed json + ok flag', async () => {
  const http = makeHttp({ pit:'pit-x', base:'https://api', fetch: fakeFetch([{ status:200, body:'{"a":1}' }]), sleep: async()=>{} });
  const r = await http.get('/x');
  assert.equal(r.ok, true); assert.equal(r.code, 200); assert.deepEqual(r.j, { a:1 });
});

test('429 retries honoring Retry-After then succeeds', async () => {
  const fetch = fakeFetch([{ status:429, headers:{ 'retry-after':'0' } }, { status:200, body:'{"ok":true}' }]);
  let slept = 0; const http = makeHttp({ pit:'p', base:'https://api', fetch, sleep: async(ms)=>{ slept+=ms; } });
  const r = await http.get('/y');
  assert.equal(r.ok, true); assert.equal(fetch.calls.length, 2);
});

test('auth header is sent', async () => {
  let seenHeaders; const fetch = async (url, opts) => { seenHeaders = opts.headers; return { status:200, headers:new Map(), text:async()=>'{}' }; };
  const http = makeHttp({ pit:'pit-abc', base:'https://api', fetch, sleep: async()=>{} });
  await http.get('/z');
  assert.equal(seenHeaders.Authorization, 'Bearer pit-abc');
});

test('AbortError (timeout) retries up to maxTimeoutRetries then returns timeout result', async () => {
  // I5 fix: timeouts retry up to maxTimeoutRetries (default 2) then give up.
  // Worst case = 1 initial + 2 retries = 3 total calls.
  let callCount = 0;
  const fetch = async () => {
    callCount++;
    const e = new Error('The operation was aborted');
    e.name = 'AbortError';
    throw e;
  };
  const http = makeHttp({ pit:'p', base:'https://api', fetch, sleep: async()=>{}, maxRetries:4, maxTimeoutRetries:2 });
  const r = await http.get('/timeout');
  assert.equal(callCount, 3, 'should attempt 1 initial + 2 retries = 3 total calls');
  assert.equal(r.ok, false);
  assert.equal(r.txt, 'timeout');
});

test('AbortError (timeout) with maxTimeoutRetries=0 returns immediately (no retry)', async () => {
  let callCount = 0;
  const fetch = async () => {
    callCount++;
    const e = new Error('The operation was aborted');
    e.name = 'AbortError';
    throw e;
  };
  const http = makeHttp({ pit:'p', base:'https://api', fetch, sleep: async()=>{}, maxRetries:4, maxTimeoutRetries:0 });
  const r = await http.get('/timeout');
  assert.equal(callCount, 1, 'maxTimeoutRetries=0 → only 1 attempt');
  assert.equal(r.ok, false);
  assert.equal(r.txt, 'timeout');
});

// ── 429 Retry-After: the branch that had no coverage ─────────────────────────
//
// The existing 429 test above uses `retry-after: '0'`. `Number('0') > 0` is false, so it takes the
// backoff arm — which incremented `attempt` correctly. The arm that HONOURS a server-supplied
// Retry-After never incremented it, so `attempt < maxRetries` stayed true forever and the loop ran
// without bound. Zero tests reached that arm.
//
// Found 2026-07-28 by a lib/ audit, reproduced with injected fetch/sleep before any fix:
//   GET,  Retry-After: 30  -> 41 attempts, 1230s simulated sleep, still going (maxRetries=4)
//   POST, Retry-After: 30  -> same, re-sending the request body every iteration
//   GET,  no Retry-After   -> code=429 after 5 attempts (correct)

function throttled({ retryAfter, status = 429 } = {}) {
  const state = { calls: 0, slept: 0 };
  const http = makeHttp({
    pit: 'pit-TEST',
    fetch: async () => {
      state.calls++;
      return {
        status,
        headers: { get: () => (retryAfter == null ? null : String(retryAfter)) },
        text: async () => '{}',
      };
    },
    sleep: async (ms) => {
      state.slept += ms;
      // A real bug here never returns; fail loudly instead of hanging the suite.
      if (state.calls > 40) throw new Error(`unbounded retry: ${state.calls} attempts`);
    },
  });
  return { http, state };
}

test('429 with a usable Retry-After is BOUNDED by maxRetries', async () => {
  const { http, state } = throttled({ retryAfter: 30 });
  const r = await http.get('/contacts/');
  assert.equal(r.code, 429, 'after exhausting retries the 429 must be returned, not retried forever');
  assert.equal(state.calls, 5, 'exactly maxRetries(4) + 1 attempts');
});

test('429 with Retry-After on a WRITE is bounded too — the body is not re-sent forever', async () => {
  // Worse than the read case: each iteration re-transmits the payload to an API that is explicitly
  // asking the client to stop.
  const { http, state } = throttled({ retryAfter: 30 });
  const r = await http.post('/contacts/', { name: 'x' });
  assert.equal(r.code, 429);
  assert.equal(state.calls, 5);
});

test('429 Retry-After is capped — a huge value cannot become a silent multi-hour sleep', async () => {
  // Retry-After: 3600 would otherwise sleep an hour PER attempt with no output.
  const { http, state } = throttled({ retryAfter: 3600 });
  await http.get('/contacts/');
  assert.ok(state.slept <= 4 * 60_000,
    `total sleep ${state.slept}ms exceeded the cap — a server can stall the CLI indefinitely`);
});

test('429 Retry-After is still HONOURED when it is small (the cap does not discard it)', async () => {
  // The cap must not turn into "ignore the server". 5s x 4 retries = 20s, well under the cap and
  // well above what plain backoff would produce (max 8s per attempt, halved by the test jitter).
  const { http, state } = throttled({ retryAfter: 5 });
  await http.get('/contacts/');
  assert.equal(state.slept, 4 * 5000, 'each retry should wait exactly the requested 5s');
});

test('429 with NO Retry-After header still falls back to backoff, bounded', async () => {
  const { http, state } = throttled({ retryAfter: null });
  const r = await http.get('/contacts/');
  assert.equal(r.code, 429);
  assert.equal(state.calls, 5);
});

test('429 with a non-numeric (HTTP-date) Retry-After falls back to backoff, bounded', async () => {
  const { http, state } = throttled({ retryAfter: 'Wed, 21 Oct 2026 07:28:00 GMT' });
  const r = await http.get('/contacts/');
  assert.equal(r.code, 429);
  assert.equal(state.calls, 5);
});

// ── non-idempotent writes must never be silently repeated ────────────────────
//
// A client-side abort at timeoutMs does NOT mean the server ignored the request — it means we
// stopped listening. Nor does a 502/504: gateways routinely fail AFTER the upstream has acted.
// Retrying a POST in either case re-delivers the side effect.
//
// Found 2026-07-28. Reproduced with an injected fetch where the server ALWAYS succeeds but the
// response is lost:
//     POST + client timeout    server processed 2x, client saw code=201
//     POST + 502 from gateway  server processed 2x, client saw code=201
// The affected POSTs are /conversations/messages, /invoices/{id}/send and /invoices/ — a contact
// messaged twice, an invoice delivered twice, a duplicate draft. And the client reported 201, so
// nothing surfaced it. sizmo's safety model is that one --confirm performs one write.

function lossyServer({ failMode, status = 201 } = {}) {
  const seen = [];
  const http = makeHttp({
    pit: 'pit-TEST',
    sleep: async () => {},
    fetch: async (_url, opts) => {
      seen.push(JSON.parse(opts.body || '{}'));       // the server received and ACTED on it
      if (seen.length === 1) {
        if (failMode === 'timeout') { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
        if (failMode === '5xx') return { status: 502, headers: { get: () => null }, text: async () => 'bad gateway' };
      }
      return { status, headers: { get: () => null }, text: async () => '{"ok":true}' };
    },
  });
  return { http, seen };
}

test('POST is NOT retried after a client timeout — the message is delivered once', async () => {
  const { http, seen } = lossyServer({ failMode: 'timeout' });
  const r = await http.post('/conversations/messages', { contactId: 'c1', message: 'hi' });
  assert.equal(seen.length, 1, 'a timed-out POST must not be re-sent — the first one may have landed');
  assert.equal(r.ok, false, 'and the caller must be told it failed rather than shown a fake 201');
  assert.match(r.txt, /may or may not have been delivered/,
    'the wording must warn against a blind retry, which is what causes the double-send');
});

test('POST is NOT retried after a 5xx — a gateway can fail after the upstream acted', async () => {
  const { http, seen } = lossyServer({ failMode: '5xx' });
  const r = await http.post('/invoices/inv-1/send', { altId: 'L' });
  assert.equal(seen.length, 1, 'a 502 must not trigger a re-send of an invoice');
  assert.equal(r.code, 502, 'the real status is surfaced, not masked by a retry that "succeeded"');
});

test('PUT IS still retried — idempotent, so repeating converges on the same state', async () => {
  // The fix must not overcorrect. PUT and DELETE are safe to repeat by HTTP semantics.
  const { http, seen } = lossyServer({ failMode: 'timeout', status: 200 });
  const r = await http.put('/contacts/c1', { name: 'Ana' });
  assert.equal(seen.length, 2, 'PUT should retry through a transient timeout');
  assert.equal(r.ok, true);
});

test('DELETE IS still retried — same reasoning as PUT', async () => {
  const { http, seen } = lossyServer({ failMode: '5xx', status: 200 });
  const r = await http.delete('/contacts/c1');
  assert.equal(seen.length, 2);
  assert.equal(r.ok, true);
});

test('a POST IS still retried on 429 — refused is not processed', async () => {
  // 429 means the request was rejected before any side effect, so repeating it cannot duplicate.
  // This is the one retry that stays safe for POST, and it must not be lost to the fix above.
  let n = 0;
  const http = makeHttp({
    pit: 'pit-TEST', sleep: async () => {},
    fetch: async () => {
      n++;
      return n === 1
        ? { status: 429, headers: { get: () => null }, text: async () => '{}' }
        : { status: 201, headers: { get: () => null }, text: async () => '{"ok":true}' };
    },
  });
  const r = await http.post('/contacts/c1/tags', { tags: ['vip'] });
  assert.equal(n, 2, 'a 429 must still be retried for POST');
  assert.equal(r.ok, true);
});

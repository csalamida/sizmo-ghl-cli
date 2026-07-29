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

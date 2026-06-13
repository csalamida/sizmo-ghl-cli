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

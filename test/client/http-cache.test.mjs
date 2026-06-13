import { test } from 'node:test'; import assert from 'node:assert';
import { makeHttp } from '../../lib/http.mjs';

function memCache(){ const m=new Map(); return { get:k=>m.has(k)?{value:m.get(k),ageMs:0}:null, set:(k,v)=>m.set(k,v), _m:m }; }

test('GET caches 2xx, second call hits cache', async () => {
  let calls=0; const fetch=async()=>{calls++;return{status:200,headers:new Map(),text:async()=>'{"a":1}'};};
  const cache=memCache(); const http=makeHttp({pit:'p',fetch,sleep:async()=>{},cache});
  await http.get('/x'); await http.get('/x');
  assert.equal(calls,1,'second GET served from cache');
});

test('403 is NOT cached', async () => {
  let calls=0; const fetch=async()=>{calls++;return{status:403,headers:new Map(),text:async()=>'no'};};
  const cache=memCache(); const http=makeHttp({pit:'p',fetch,sleep:async()=>{},cache});
  await http.get('/y'); await http.get('/y');
  assert.equal(calls,2,'blocked response must re-fetch, never cached');
});

test('fresh:true bypasses cache', async () => {
  let calls=0; const fetch=async()=>{calls++;return{status:200,headers:new Map(),text:async()=>'{}'};};
  const cache=memCache(); const http=makeHttp({pit:'p',fetch,sleep:async()=>{},cache,fresh:true});
  await http.get('/z'); await http.get('/z');
  assert.equal(calls,2,'--fresh always fetches');
});

test('cacheAge is present on cache hit', async () => {
  let calls=0; const fetch=async()=>{calls++;return{status:200,headers:new Map(),text:async()=>'{"b":2}'};};
  const cache=memCache(); const http=makeHttp({pit:'p',fetch,sleep:async()=>{},cache});
  await http.get('/w');
  const r2 = await http.get('/w');
  assert.equal(calls,1,'only one live fetch');
  assert.ok('cacheAge' in r2, 'cacheAge must be present on cache hit');
  assert.equal(r2.cacheAge, 0, 'memCache always returns ageMs:0');
});

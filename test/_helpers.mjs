// test/_helpers.mjs — in-process command testing. makeFakeCtx serves http from a fixture map,
// captures out.data() payload + warnings. No network, deterministic.
//
// STRICT mode: if the computed "GET <path><qs>" key is NOT in the fixture (and no bare
// "GET <path>" fallback exists), this throws Error('unmocked request: <key>').
// This forces every test to key every page it expects — pagination regressions now fail loudly
// instead of silently resolving page-2+ as empty.
import { makeOut } from '../lib/output.mjs';

export function makeFakeCtx({ fixture = {}, loc = 'L-TEST', now = 1_700_000_000_000, json = true } = {}) {
  // fixture: { "GET /contacts/?locationId=L-TEST&limit=100": { status:200, j:{...} }, ... } keyed by method+path+query
  const http = { get: async (path, { query } = {}) => {
    const qs = query ? '?' + new URLSearchParams(Object.fromEntries(Object.entries(query).filter(([,v])=>v!=null).map(([k,v])=>[k,String(v)]))).toString() : '';
    const key = `GET ${path}${qs}`;
    // Bare-path fallback only when request carries NO query string — this preserves backward
    // compat for tests that key as "GET /path" but DOES NOT swallow pagination misses:
    // a page-2 request ("GET /path?offset=100") will NOT fall back to "GET /path" and will throw.
    const hit = fixture[key] || (!qs ? fixture[`GET ${path}`] : undefined);
    if (!hit) throw new Error('unmocked request: ' + key);
    return { code: hit.status, ok: hit.status >= 200 && hit.status < 300, j: hit.j, txt: JSON.stringify(hit.j) };
  }};
  let printed = '';
  const out = makeOut({ json, tty: false, command: 'test', location: loc, write: s => printed += s, writeErr: () => {} });
  return { ctx: { http, cfg: { loc, tz: 'Asia/Manila', currency: null }, out, now }, getPrinted: () => printed };
}

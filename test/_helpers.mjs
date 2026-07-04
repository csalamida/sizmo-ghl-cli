// test/_helpers.mjs — in-process command testing. makeFakeCtx serves http from a fixture map,
// captures out.data() payload + warnings. No network, deterministic.
//
// STRICT mode: if the computed "GET <path><qs>" key is NOT in the fixture (and no bare
// "GET <path>" fallback exists), this throws Error('unmocked request: <key>').
// This forces every test to key every page it expects — pagination regressions now fail loudly
// instead of silently resolving page-2+ as empty.
//
// Model injection (C3): pass { model } to wire ctx.ensureModel / ctx.resolve / ctx.model
// exactly as buildCtx does, so recipe tests can drive the model path.
//   - model: a valid model blob (or null) to inject. Recipes see ctx.ensureModel() resolve with it.
//   - When model is provided, the http fixture MUST NOT include structure endpoints
//     (pipelines, calendars) — the test asserts these are never called.
import { makeOut } from '../lib/output.mjs';
import { makeResolver } from '../lib/resolver.mjs';

export function makeFakeCtx({
  fixture = {},
  loc = 'L-TEST',
  now = 1_700_000_000_000,
  json = true,
  model: injectedModel = undefined,
  confirmed = false,
  dryRun = false,
} = {}) {
  // fixture: { "GET /contacts/?locationId=L-TEST&limit=100": { status:200, j:{...} }, ... } keyed by method+path+query
  // Write fixture keys use the same format: "POST /contacts/id/tags", "DELETE /contacts/id/tags", etc.
  // Track which paths were actually called (for C3 + write-guard assertions)
  const calledPaths = [];
  const calledWrites = []; // separate log for write calls (POST/PUT/DELETE) so tests can assert none fired
  const calledBodies = []; // { method, path, body } for every write — so tests can assert on the ACTUAL
                            // outgoing request shape, not just that a call happened (a wrong field name
                            // sent to the real API is invisible if body is never inspected).

  function fakeFetch(method, path, opts = {}, body = undefined) {
    const qs = opts?.query ? '?' + new URLSearchParams(Object.fromEntries(Object.entries(opts.query).filter(([,v])=>v!=null).map(([k,v])=>[k,String(v)]))).toString() : '';
    const key = `${method} ${path}${qs}`;
    if (method !== 'GET') { calledWrites.push(key); calledBodies.push({ method, path, body }); }
    calledPaths.push(key);
    const hit = fixture[key] || (!qs ? fixture[`${method} ${path}`] : undefined);
    if (!hit) throw new Error('unmocked request: ' + key);
    return { code: hit.status, ok: hit.status >= 200 && hit.status < 300, j: hit.j, txt: JSON.stringify(hit.j) };
  }

  const http = {
    get:    async (path, opts = {})       => fakeFetch('GET',    path, opts),
    post:   async (path, body, opts = {}) => fakeFetch('POST',   path, opts, body),
    put:    async (path, body, opts = {}) => fakeFetch('PUT',    path, opts, body),
    delete: async (path, body, opts = {}) => fakeFetch('DELETE', path, opts, body),
  };
  let printed = '';
  const out = makeOut({ json, tty: false, command: 'test', location: loc, write: s => printed += s, writeErr: () => {} });

  // Model wiring (C3): if injectedModel provided, expose ensureModel/resolve/model on ctx
  // exactly as buildCtx does. This routes recipe tests through the model path, not live-fetch.
  let modelCtxExtras = {};
  if (injectedModel !== undefined) {
    const resolver = makeResolver(injectedModel, { now: typeof now === 'function' ? now : () => now });
    let _modelResolved = false;
    const ensureModel = async () => { _modelResolved = true; return injectedModel; };
    modelCtxExtras = {
      get model() { return injectedModel; },
      ensureModel,
      get resolve() { return resolver; },
    };
  }

  return {
    ctx: { http, cfg: { loc, tz: 'Asia/Manila', currency: null }, out, now, confirmed, dryRun, ...modelCtxExtras },
    getPrinted: () => printed,
    // C3: expose called paths so tests can assert structure endpoints were NOT called
    getCalledPaths: () => [...calledPaths],
    // Write-guard: expose write calls so tests can assert no write fired without --confirm
    getCalledWrites: () => [...calledWrites],
    // Body-guard: expose the actual outgoing body per write so tests can assert on real field
    // names/shape, not just that some call happened.
    getCalledBodies: () => [...calledBodies],
  };
}

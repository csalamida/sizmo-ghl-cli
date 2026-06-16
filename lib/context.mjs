// lib/context.mjs — assemble the injected ctx. Enforces "no creds → AUTH".
import { makeHttp } from './http.mjs';
import { makeOut } from './output.mjs';
import { makeCache } from './cache.mjs';
import { GhlError, EXIT } from './errors.mjs';
import { loadModel, syncModel, DEFAULT_MODEL_DIR } from './model.mjs';
import { makeResolver } from './resolver.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { env as processEnv } from 'node:process';

// XDG-style neutral cache path. Override with XDG_CONFIG_HOME.
const XDG = processEnv.XDG_CONFIG_HOME || join(homedir(), '.config');
const CACHE_DIR = join(XDG, 'sizmo', 'cache');
const CACHE_TTL_MS = 60_000; // 60 seconds

export function buildCtx({ creds, globals, now = Date.now(), httpFactory = makeHttp, confirmed = false, dryRun = false, write, writeErr } = {}) {
  if (!creds.pit) throw new GhlError('no PIT available', EXIT.AUTH, 'set GHL_PIT, or: sizmo config set --profile <name> --pit-stdin');
  if (!creds.loc) throw new GhlError('no location resolved', EXIT.AUTH, 'pass --profile <name>, or set GHL_LOCATION_ID');
  // --fresh / --no-cache: bypass cache entirely (always re-fetch)
  const fresh = !!(globals.fresh || globals['no-cache']);
  // --confirm: execute the queued write (agent-safety gate)
  const _confirmed = !!(confirmed || globals.confirmed);
  // --dry-run: show change description, never execute, exit 0
  const _dryRun = !!(dryRun || globals.dryRun);
  // --concise: emit values-only (no prose, no nested payloads)
  const concise = !!globals.concise;
  // --fields a,b,c: project list items to these keys only
  const fields = globals.fields ? String(globals.fields).split(',').map(s => s.trim()).filter(Boolean) : null;
  // Cache is keyed by full URL (includes locationId param) — no cross-profile bleed
  const cache = makeCache({ dir: CACHE_DIR, ttlMs: CACHE_TTL_MS });
  const rawHttp = httpFactory({ pit: creds.pit, cache, fresh });
  // write/writeErr default to process std streams inside makeOut; pass through when injected
  // (lets a caller — e.g. `init` auto-running `doctor` — capture/route the command's output).
  const out = makeOut({ json: !!globals.json, tty: !!globals.tty, command: globals.command, location: creds.loc, fields,
    ...(write ? { write } : {}), ...(writeErr ? { writeErr } : {}) });
  // Wrap http.get to forward cacheAge to out.noteCacheAge — so flush() can surface it in the envelope/TTY note.
  // Writes (post/put/delete) pass straight through — cache/fresh logic only applies to GET.
  const http = {
    get: async (path, opts) => {
      const r = await rawHttp.get(path, opts);
      if (typeof r.cacheAge === 'number') out.noteCacheAge(r.cacheAge);
      return r;
    },
    post:   (path, body, opts) => rawHttp.post(path, body, opts),
    put:    (path, body, opts) => rawHttp.put(path, body, opts),
    delete: (path, body, opts) => rawHttp.delete(path, body, opts),
  };

  // CRM model — lazy, loaded once per ctx. Auto-syncs if missing.
  // Recipes read ctx.model (the raw blob) and ctx.resolve (the resolver).
  // We expose a lazy getter so commands that don't need the model pay nothing.
  let _model = undefined; // undefined = not yet loaded; null = load attempted, none found + sync ran
  let _resolver = undefined;

  async function ensureModel() {
    if (_model !== undefined) return _model;
    _model = loadModel(creds.loc, DEFAULT_MODEL_DIR);
    if (!_model) {
      // Auto-sync on first use (model missing)
      try {
        _model = await syncModel({ http: rawHttp, loc: creds.loc, now: () => now });
      } catch {
        _model = null;
      }
    }
    _resolver = makeResolver(_model, { now: () => now });
    return _model;
  }

  return {
    http,
    cfg: creds,
    out,
    now,
    concise,
    fields,
    confirmed: _confirmed,
    dryRun: _dryRun,
    // Expose model access for recipes
    get model() { return _model; },
    // ensureModel() → async lazy-loads + returns model
    ensureModel,
    // resolve(kind, id) → sync resolver call (after ensureModel was awaited)
    get resolve() { return _resolver; },
  };
}

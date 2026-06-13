// lib/context.mjs — assemble the injected ctx. Enforces "no creds → AUTH".
import { makeHttp } from './http.mjs';
import { makeOut } from './output.mjs';
import { makeCache } from './cache.mjs';
import { GhlError, EXIT } from './errors.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { env as processEnv } from 'node:process';

// XDG-style neutral cache path. Override with XDG_CONFIG_HOME.
const XDG = processEnv.XDG_CONFIG_HOME || join(homedir(), '.config');
const CACHE_DIR = join(XDG, 'sizmo', 'cache');
const CACHE_TTL_MS = 60_000; // 60 seconds

export function buildCtx({ creds, globals, now = Date.now(), httpFactory = makeHttp } = {}) {
  if (!creds.pit) throw new GhlError('no PIT available', EXIT.AUTH, 'set GHL_PIT, or: sizmo config set --profile <name> --pit-stdin');
  if (!creds.loc) throw new GhlError('no location resolved', EXIT.AUTH, 'pass --profile <name>, or set GHL_LOCATION_ID');
  // --fresh / --no-cache: bypass cache entirely (always re-fetch)
  const fresh = !!(globals.fresh || globals['no-cache']);
  // Cache is keyed by full URL (includes locationId param) — no cross-profile bleed
  const cache = makeCache({ dir: CACHE_DIR, ttlMs: CACHE_TTL_MS });
  const rawHttp = httpFactory({ pit: creds.pit, cache, fresh });
  const out = makeOut({ json: !!globals.json, tty: !!globals.tty, command: globals.command, location: creds.loc });
  // Wrap http.get to forward cacheAge to out.noteCacheAge — so flush() can surface it in the envelope/TTY note.
  const http = {
    get: async (path, opts) => {
      const r = await rawHttp.get(path, opts);
      if (typeof r.cacheAge === 'number') out.noteCacheAge(r.cacheAge);
      return r;
    },
  };
  return { http, cfg: creds, out, now };
}

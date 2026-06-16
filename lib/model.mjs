// lib/model.mjs — per-profile CRM structure store + sync.
// Caches 6 slow-changing GHL entities (pipelines, calendars, tags, customFields, users, location)
// in a single JSON blob per location at ~/.config/sizmo/model/<loc>.json.
// Atomic write (temp+rename, same-dir to avoid EXDEV), 0600, per-entity age tracked, partial-sync-safe.
// READ-ONLY. No writes to GoHighLevel.
import { mkdirSync, writeFileSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { env as processEnv } from 'node:process';
import { mapLimit } from './pool.mjs';

const XDG = processEnv.XDG_CONFIG_HOME || join(homedir(), '.config');
export const DEFAULT_MODEL_DIR = join(XDG, 'sizmo', 'model');
export const SCHEMA_VERSION = 1;

// TTLs: pipelines/calendars/users/location 24h; tags/customFields 12h
const H24 = 24 * 60 * 60 * 1000;
const H12 = 12 * 60 * 60 * 1000;

// Entity specs — each describes how to fetch + parse one CRM entity.
// buildPath(loc) → the API path segment; version → GHL API Version header;
// scope → human-readable scope name for blocked messages;
// ttlMs → staleness threshold; extract(json) → items[] or item{}.
export const ENTITY_SPECS = [
  {
    name: 'pipelines',
    buildPath: (loc) => `/opportunities/pipelines?locationId=${encodeURIComponent(loc)}`,
    version: '2021-07-28',
    scope: 'opportunities.readonly',
    ttlMs: H24,
    extract: (j) => ({ items: j?.pipelines ?? [] }),
  },
  {
    name: 'calendars',
    buildPath: (loc) => `/calendars/?locationId=${encodeURIComponent(loc)}`,
    version: '2021-04-15',
    scope: 'calendars.readonly',
    ttlMs: H24,
    extract: (j) => ({ items: j?.calendars ?? [] }),
  },
  {
    name: 'tags',
    buildPath: (loc) => `/locations/${encodeURIComponent(loc)}/tags`,
    version: '2021-07-28',
    scope: 'locations/tags.readonly',
    ttlMs: H12,
    extract: (j) => ({ items: j?.tags ?? [] }),
  },
  {
    name: 'customFields',
    buildPath: (loc) => `/locations/${encodeURIComponent(loc)}/customFields?model=all`,
    version: '2021-07-28',
    scope: 'locations/customFields.readonly',
    ttlMs: H12,
    extract: (j) => ({ items: j?.customFields ?? [] }),
  },
  {
    name: 'users',
    buildPath: (loc) => `/users/?locationId=${encodeURIComponent(loc)}`,
    version: '2021-07-28',
    scope: 'users.readonly',
    ttlMs: H24,
    extract: (j) => ({ items: j?.users ?? [] }),
  },
  {
    name: 'location',
    buildPath: (loc) => `/locations/${encodeURIComponent(loc)}`,
    version: '2021-07-28',
    scope: 'locations.readonly',
    ttlMs: H24,
    extract: (j) => ({ item: j?.location ?? {} }),
  },
];

/**
 * syncModel — fetch (up to) 6 entities and write the blob atomically.
 * @param {object} opts
 * @param {object} opts.http        ctx.http (get returns {code,ok,j})
 * @param {string} opts.loc         locationId
 * @param {string} [opts.dir]       override default model dir (for tests)
 * @param {Function} [opts.now]     injectable clock () => ms
 * @param {string[]} [opts.only]    subset of entity names (partial sync; for `sync <entity>`)
 * @returns {object} the written model blob, with an `offline` boolean property:
 *   true  = at least one entity hit a network/transport error (couldn't reach GHL at all).
 *   false = all entities either succeeded or were blocked by an HTTP 401/403 scope error.
 * @throws {Error} if the model is missing AND all fetches hit network errors (cold+offline).
 *   Caller must show a real error — do NOT display a fresh-looking empty model in this case.
 */
export async function syncModel({ http, loc, dir = DEFAULT_MODEL_DIR, now = Date.now, only = null } = {}) {
  const specs = only ? ENTITY_SPECS.filter(s => only.includes(s.name)) : ENTITY_SPECS;
  const syncedAt = now();

  // Start from any existing model (keep entities not in this sync run)
  const base = loadModel(loc, dir) || {};
  const hadExistingModel = !!(base.entities && Object.keys(base.entities).length > 0);
  const entities = base.entities ? { ...base.entities } : {};

  let networkErrorCount = 0;

  await mapLimit(specs, 5, async (spec) => {
    const path = spec.buildPath(loc);
    let r;
    try {
      r = await http.get(path, spec.version !== '2021-07-28' ? { version: spec.version } : undefined);
    } catch (e) {
      // Transport/network failure — couldn't reach GHL at all. Distinct from auth errors.
      networkErrorCount++;
      entities[spec.name] = { networkError: true, error: e?.message ?? 'network error', fetchedAt: now() };
      return;
    }
    // http.get returned code:0 signals a network-level failure (no response from server)
    if (r.code === 0) {
      networkErrorCount++;
      entities[spec.name] = { networkError: true, error: r.message ?? 'no response', fetchedAt: now() };
      return;
    }
    if (r.code === 401 || r.code === 403) {
      // Scope/auth blocked — this is NOT a network error. Clearly distinguished.
      entities[spec.name] = { blocked: true, scope: spec.scope, fetchedAt: now() };
      return;
    }
    if (!r.ok) {
      // Other HTTP errors (5xx, 404, etc.) — mark blocked with code, NOT networkError.
      entities[spec.name] = { blocked: true, scope: spec.scope, httpCode: r.code, fetchedAt: now() };
      return;
    }
    const extracted = spec.extract(r.j);
    entities[spec.name] = { fetchedAt: now(), ...extracted };
  });

  const offline = networkErrorCount > 0;

  // Cold + offline: no existing model AND all/some fetches hit network errors.
  // Do NOT write a fresh-looking empty blob. Throw so the caller shows a real error.
  if (!hadExistingModel && offline) {
    const err = new Error(
      "can't reach GoHighLevel — check your connection; run `sizmo sync` when online"
    );
    err.offline = true;
    err.networkErrorCount = networkErrorCount;
    throw err;
  }

  const model = {
    schemaVersion: SCHEMA_VERSION,
    locationId: loc,
    syncedAt,
    entities,
    offline,
  };

  writeModelAtomic(loc, model, dir);
  return model;
}

/**
 * loadModel — read the blob for a location. Returns null if missing, corrupt,
 * or schemaVersion mismatch (caller must re-sync).
 */
export function loadModel(loc, dir = DEFAULT_MODEL_DIR) {
  const path = join(dir, `${loc}.json`);
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * isStale — true if the entity's fetchedAt is older than ttlMs relative to now.
 * @param {object} entity  model.entities[name]
 * @param {number} nowMs   current time in ms
 * @param {number} ttlMs   TTL for this entity type
 */
export function isStale(entity, nowMs, ttlMs) {
  if (!entity || entity.blocked || entity.networkError || typeof entity.fetchedAt !== 'number') return true;
  return (nowMs - entity.fetchedAt) > ttlMs;
}

/**
 * ageMs — ms since this entity was last fetched.
 */
export function ageMs(entity, nowMs) {
  if (!entity || typeof entity.fetchedAt !== 'number') return null;
  return nowMs - entity.fetchedAt;
}

// ── internal ──────────────────────────────────────────────────────────────────

/**
 * writeModelAtomic — write model to disk with a same-directory temp+rename pattern.
 * Same-dir temp avoids EXDEV (cross-filesystem rename failure) that occurs when tmpdir()
 * is on a different mount than the model dir. Throws on any write failure so callers can
 * surface the error (M1 + M2 fix).
 */
function writeModelAtomic(loc, model, dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = join(dir, `${loc}.json`);
  // Same directory as dest — no cross-FS EXDEV risk.
  const tmp = join(dir, `.${loc}.json.tmp.${process.pid}`);
  try {
    writeFileSync(tmp, JSON.stringify(model, null, 2), { mode: 0o600 });
    renameSync(tmp, dest);
  } catch (e) {
    // Clean up orphaned temp file on failure; ignore cleanup error.
    try { unlinkSync(tmp); } catch { /* ignore */ }
    // Re-throw so the caller (sync command) can surface "sync failed — nothing written".
    throw e;
  }
}

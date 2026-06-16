// lib/update-notify.mjs — zero-dependency update notifier.
//
// Tells a globally-installed user that a newer sizmo is on npm, so they don't sit on a stale
// version forever (npx users are always current; `npm i -g` users are not). Mirrors the
// `update-notifier` pattern without the dependency (sizmo ships zero runtime deps).
//
// HARD CONSTRAINTS (all enforced here):
//   · stderr only, and the CALLER must skip it on --json — the machine envelope stays byte-clean
//   · cached 24h in the config dir — at most one registry hit per day; every other run reads cache
//   · fail-silent + offline-safe — any error/timeout → null, never blocks, never throws to the user
//   · opt-out — NO_UPDATE_NOTIFIER or SIZMO_NO_UPDATE_CHECK env, or the caller's --no-update-check
//   · no telemetry — a plain GET of a PUBLIC endpoint; sends nothing about the user
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const DAY_MS = 86_400_000;
const XDG = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
export const DEFAULT_CACHE_FILE = join(XDG, 'sizmo', 'update-check.json');
const REGISTRY_URL = 'https://registry.npmjs.org/sizmo/latest';

// isNewer(latest, current) → true if latest is a higher semver than current.
// Numeric major.minor.patch compare; prerelease/build suffixes are stripped (a stable
// release is never "older" than itself because of a -tag). Non-parseable → false (safe).
export function isNewer(latest, current) {
  if (!latest || !current) return false;
  const parse = (v) => String(v).trim().split('+')[0].split('-')[0].split('.').map(x => parseInt(x, 10) || 0);
  const [a0, a1, a2] = parse(latest);
  const [b0, b1, b2] = parse(current);
  if (a0 !== b0) return a0 > b0;
  if (a1 !== b1) return a1 > b1;
  return a2 > b2;
}

// fetchLatest() → the latest published version string, or null on ANY failure (offline,
// timeout, non-2xx, malformed). Never throws. fetchImpl/timeout injectable for tests.
export async function fetchLatest({ fetchImpl = globalThis.fetch, timeoutMs = 1500 } = {}) {
  if (typeof fetchImpl !== 'function') return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(REGISTRY_URL, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!r || !r.ok) return null;
    const j = await r.json();
    return (j && typeof j.version === 'string') ? j.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// readCachedLatest() → the cached latest version if the cache exists AND is within ttl,
// else null. Pure read — NEVER fetches. Used by `doctor` to surface version freshness
// without making doctor do network I/O.
export function readCachedLatest({ cacheFile = DEFAULT_CACHE_FILE, now = Date.now, ttlMs = DAY_MS } = {}) {
  try {
    const { checkedAt, latest } = JSON.parse(readFileSync(cacheFile, 'utf8'));
    if (typeof checkedAt === 'number' && (now() - checkedAt) < ttlMs && typeof latest === 'string') return latest;
  } catch { /* missing / corrupt → null */ }
  return null;
}

// checkForUpdate() → { current, latest, updateAvailable } or null.
// Reads the 24h cache; on miss, fetches once and persists. Honors opt-out env. Fail-silent.
export async function checkForUpdate({
  current,
  cacheFile = DEFAULT_CACHE_FILE,
  now = Date.now,
  ttlMs = DAY_MS,
  fetchImpl,
  env = process.env,
} = {}) {
  if (env.NO_UPDATE_NOTIFIER || env.SIZMO_NO_UPDATE_CHECK) return null;
  if (!current) return null;

  let latest = readCachedLatest({ cacheFile, now, ttlMs });
  if (latest == null) {
    latest = await fetchLatest({ fetchImpl });
    if (latest == null) return null; // offline / failed — say nothing
    try {
      mkdirSync(dirname(cacheFile), { recursive: true, mode: 0o700 });
      const tmp = cacheFile + '.tmp.' + process.pid;
      writeFileSync(tmp, JSON.stringify({ checkedAt: now(), latest }), { mode: 0o600 });
      renameSync(tmp, cacheFile);
    } catch { /* cache write best-effort */ }
  }
  return { current, latest, updateAvailable: isNewer(latest, current) };
}

// updateNotice(result) → the one-line stderr nudge, or null when there's nothing to say.
export function updateNotice(result) {
  if (!result || !result.updateAvailable) return null;
  return `\n  ⚠ sizmo ${result.latest} available (you have ${result.current}) — update: npm i -g sizmo@latest\n`;
}

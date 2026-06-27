// lib/config.mjs — credential resolution + profiles. NO baked location default.
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { env as processEnv } from 'node:process';

// XDG-style neutral config path. Override with XDG_CONFIG_HOME.
// Resolved LAZILY (at call time, not import time) so a changed XDG_CONFIG_HOME takes effect — which
// lets tests isolate from the real ~/.config/sizmo and never depend on the machine's saved profiles.
const cfgDir = () => join(processEnv.XDG_CONFIG_HOME || join(homedir(), '.config'), 'sizmo');
const profilesPath = () => join(cfgDir(), 'profiles.json');

export function loadProfiles() { try { return JSON.parse(readFileSync(profilesPath(), 'utf8')); } catch { return { default: null, profiles: {} }; } }
export function saveProfiles(db) {
  const dir = cfgDir(), PROFILES = profilesPath();
  mkdirSync(dir, { recursive: true });
  // Atomic write: create temp with 0o600 from the start (no chmod-after-write window),
  // then rename atomically. Prevents partial-write corruption + TOCTOU permission leak.
  const tmp = PROFILES + '.tmp.' + process.pid;
  try {
    writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
    renameSync(tmp, PROFILES);
  } finally {
    // On a crash between write and rename, never leave a cleartext-PIT temp behind.
    // (After a successful rename the temp is already gone — force makes this a no-op.)
    try { rmSync(tmp, { force: true }); } catch {}
  }
}

// pure + injectable for tests: precedence env > profile. NO default loc.
export function resolveCreds(env, profile) {
  const pit = env.GHL_PIT || profile?.pit || null;
  const loc = env.GHL_LOCATION_ID || profile?.locationId || null;
  const source = env.GHL_PIT ? 'env GHL_PIT' : profile?.pit ? 'profile' : null;
  const tz = profile?.tz || 'UTC';
  const currency = profile?.currency || null;
  return { pit, loc, tz, currency, source };
}
// pure + injectable for tests. Precedence: explicit --profile flag > SIZMO_PROFILE env
// > saved default. Mirrors AWS_PROFILE/STRIPE_* — a per-client shell or CI lane can pick a
// profile without passing --profile every call, and an explicit flag always wins.
export function pickProfileName(flagName, env, db) {
  return flagName || env.SIZMO_PROFILE || db?.default || null;
}
export function resolve(profileName) {
  const db = loadProfiles();
  const name = pickProfileName(profileName, process.env, db);
  const profile = name ? db.profiles?.[name] : null;
  const r = resolveCreds(process.env, profile);
  return { ...r, profileName: name, profile, label: profile?.label, createdAt: profile?.createdAt };
}
// confirm the PIT actually belongs to loc (one live read). http = makeHttp(pit).
export async function validateToken(http, loc) {
  const r = await http.get('/contacts/', { query: { locationId: loc, limit: 1 } });
  if (r.code === 401 || r.code === 403) return { ok: false, reason: `PIT rejected for ${loc} (HTTP ${r.code})` };
  if (!r.ok && r.code !== 200) return { ok: false, reason: `unexpected HTTP ${r.code}` };
  return { ok: true };
}
export const mask = (pit) => pit ? `pit-…${pit.slice(-4)}` : '(none)';
export const pitAgeDays = (createdAt) => createdAt ? Math.floor((Date.now() - new Date(createdAt).getTime()) / 86400000) : null;

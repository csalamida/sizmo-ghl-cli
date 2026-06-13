// lib/config.mjs — credential resolution + profiles. NO baked location default.
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { env as processEnv } from 'node:process';

// XDG-style neutral config path. Override with XDG_CONFIG_HOME.
const XDG = processEnv.XDG_CONFIG_HOME || join(homedir(), '.config');
const CFG_DIR = join(XDG, 'sizmo');
const PROFILES = join(CFG_DIR, 'profiles.json');

export function loadProfiles() { try { return JSON.parse(readFileSync(PROFILES, 'utf8')); } catch { return { default: null, profiles: {} }; } }
export function saveProfiles(db) { mkdirSync(CFG_DIR, { recursive: true }); writeFileSync(PROFILES, JSON.stringify(db, null, 2)); chmodSync(PROFILES, 0o600); }

// pure + injectable for tests: precedence env > profile. NO default loc.
export function resolveCreds(env, profile) {
  const pit = env.GHL_PIT || profile?.pit || null;
  const loc = env.GHL_LOCATION_ID || profile?.locationId || null;
  const source = env.GHL_PIT ? 'env GHL_PIT' : profile?.pit ? 'profile' : null;
  const tz = profile?.tz || 'UTC';
  const currency = profile?.currency || null;
  return { pit, loc, tz, currency, source };
}
export function resolve(profileName) {
  const db = loadProfiles();
  const name = profileName || db.default;
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

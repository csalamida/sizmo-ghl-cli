// lib/ask-memory.mjs — local-only state for `sizmo ask`: last-resolved-contact (pronoun
// support) + pending-write-plan (the "type it once, --confirm to fire" cache).
// Same atomic-write pattern as lib/memory.mjs. Nothing here is ever sent to the LLM provider —
// the LLM only ever sees the <recent-contact> placeholder token, never a real name/id.
//
// SAFETY CONTRACT for the pending plan: it is written ONCE per unconfirmed `ask` call (a fully
// concretized plan — every contact/opportunity/value/field/calendar/business name already
// resolved to a real id). The --confirm leg REPLAYS that exact cached plan; it never re-resolves
// via the LLM or re-runs a live search. This guarantees "what you previewed is what fires" even
// though the human typed a name, not an id — an ask-specific risk that ordinary sizmo commands
// don't have (their id is typed directly by the human both times).

import { mkdirSync, writeFileSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { env as processEnv } from 'node:process';

const XDG = processEnv.XDG_CONFIG_HOME || join(homedir(), '.config');
export const DEFAULT_ASK_MEMORY_DIR = join(XDG, 'sizmo', 'ask-memory');

export const LAST_CONTACT_TTL_MS = 20 * 60 * 1000;   // 20 min — informational only, not write-authorizing
export const PENDING_PLAN_TTL_MS = 10 * 60 * 1000;   // 10 min — bounds the preview→confirm gap

function writeAtomic(dir, filename, data) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = join(dir, filename);
  const tmp = join(dir, `.${filename}.tmp.${process.pid}`);
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(tmp, dest);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

function readSafe(dir, filename) {
  try { return JSON.parse(readFileSync(join(dir, filename), 'utf8')); } catch { return null; }
}

function removeSafe(dir, filename) {
  try { unlinkSync(join(dir, filename)); } catch { /* ignore — already gone */ }
}

// ── last-resolved-contact (pronoun support) ─────────────────────────────────────

/** saveLastContact(loc, {id, name}, now, dir?) — remembers who "her/him/them/it" means next. */
export function saveLastContact(loc, { id, name }, now, dir = DEFAULT_ASK_MEMORY_DIR) {
  if (!id) return;
  writeAtomic(dir, `${loc}.last-contact.json`, { id, name: name ?? null, savedAt: now, expiresAt: now + LAST_CONTACT_TTL_MS });
}

/** loadLastContact(loc, now, dir?) → {id, name} or null if missing/expired. */
export function loadLastContact(loc, now, dir = DEFAULT_ASK_MEMORY_DIR) {
  const data = readSafe(dir, `${loc}.last-contact.json`);
  if (!data || typeof data.expiresAt !== 'number' || now > data.expiresAt) return null;
  return { id: data.id, name: data.name };
}

// ── pending write plan (preview → confirm replay) ───────────────────────────────

/**
 * savePendingPlan(loc, steps, now, dir?) — steps is the fully concretized array (every id
 * already resolved — no placeholders remain). Overwrites any prior pending plan for this loc.
 */
export function savePendingPlan(loc, steps, now, dir = DEFAULT_ASK_MEMORY_DIR) {
  writeAtomic(dir, `${loc}.pending-plan.json`, { steps, savedAt: now, expiresAt: now + PENDING_PLAN_TTL_MS });
}

/** loadPendingPlan(loc, now, dir?) → steps array or null if missing/expired. */
export function loadPendingPlan(loc, now, dir = DEFAULT_ASK_MEMORY_DIR) {
  const data = readSafe(dir, `${loc}.pending-plan.json`);
  if (!data || typeof data.expiresAt !== 'number' || now > data.expiresAt) return null;
  return data.steps;
}

/** clearPendingPlan(loc, dir?) — call after executing (success or hard-stop) so a stray extra
 * --confirm can't silently replay an already-fired plan. */
export function clearPendingPlan(loc, dir = DEFAULT_ASK_MEMORY_DIR) {
  removeSafe(dir, `${loc}.pending-plan.json`);
}

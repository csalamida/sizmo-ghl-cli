// lib/memory.mjs — per-profile run memory: delta tracking + ack/snooze.
// All state is LOCAL ONLY — never reads or writes GoHighLevel.
// Atomic write (same-dir temp+rename to avoid EXDEV), 0600, XDG-style path.
//
// HONESTY contract (fake-state discipline):
//   - No baseline → delta.firstRun:true + no "no change" implication.
//   - Old baseline (>7d) → delta.baselineStale:true + age shown.
//   - Acked items are HIDDEN not deleted — footer count always emitted.
//   - --no-memory → skip both read + record (pure stateless run).
//   - Machine-readable delta + snooze fields so agents can branch without parsing prose.

import { mkdirSync, writeFileSync, readFileSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { env as processEnv } from 'node:process';
import { SYM } from './money.mjs';
import { GhlError, EXIT } from './errors.mjs';

const XDG = processEnv.XDG_CONFIG_HOME || join(homedir(), '.config');
export const DEFAULT_MEMORY_DIR = join(XDG, 'sizmo', 'memory');

export const SCHEMA_VERSION = 1;

// Default snooze duration: 7 days in ms
export const DEFAULT_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

// Threshold above which baseline is considered "old" (7 days)
const OLD_BASELINE_MS = 7 * 24 * 60 * 60 * 1000;

// ── internal: atomic write pattern (mirrors model.mjs) ──────────────────────

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

// ── internal: cross-process mutual exclusion ────────────────────────────────
//
// WHY THIS EXISTS
// Every state change here is a read-modify-write: load the whole file, change one key, write it
// back. `writeAtomic` makes each individual WRITE atomic, so the file never lands corrupt — but
// atomic-write is not the same as atomic-update. Two processes that both read before either
// writes each hold a stale copy, and the second write silently discards the first one's change.
//
// Measured 2026-07-30, 12 real `addSnooze` processes started in parallel, each acking a
// different contact, three consecutive runs:
//     7/12 survived   ·   9/12 survived   ·   9/12 survived
// Every process exited 0. The user was told "snoozed c4" and c4 was not snoozed — silent loss of
// state the user explicitly asked for, with a success message on top of it.
//
// So the whole read-modify-write runs under an exclusive lock. `writeFileSync(..., flag: 'wx')`
// is the primitive: on POSIX, create-if-absent is atomic, so exactly one racer wins the create
// and the losers see EEXIST and wait their turn.
const LOCK_TIMEOUT_MS = 2000;   // hold time is sub-millisecond, so this queues thousands deep
const LOCK_STALE_MS = 10_000;   // older than this and the owner died without cleaning up
const SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

// These functions are synchronous and so are their callers, so the wait has to be synchronous
// too. Atomics.wait is the only sync sleep Node offers without spinning a CPU core.
function sleepSync(ms) { Atomics.wait(SLEEP_BUF, 0, 0, ms); }

function withLock(dir, filename, fn) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, `.${filename}.lock`);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
      break;                                          // acquired
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // A lock older than LOCK_STALE_MS belongs to a process that died mid-update. Break it —
      // otherwise one crash makes `sizmo ack` permanently unusable for that location.
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { unlinkSync(lock); continue; }
      } catch { continue; }                            // vanished under us: the holder just left
      if (Date.now() >= deadline) {
        // A typed error so `ack` renders it through the normal envelope with a real exit code,
        // rather than falling through cli.mjs's unexpected-internal-error path.
        const err = new GhlError(
          `could not lock local memory for ${filename} after ${LOCK_TIMEOUT_MS}ms — another sizmo ` +
          `process is holding it`,
          EXIT.API,
          `retry the command; if it keeps failing, delete ${lock}`);
        err.lockTimeout = true;
        throw err;                                    // NEVER proceed unlocked: that is the data loss
      }
      sleepSync(2 + Math.floor(Math.random() * 8));    // jitter so racers do not re-collide in lockstep
    }
  }
  try { return fn(); } finally { try { unlinkSync(lock); } catch { /* ignore */ } }
}

function readSafe(dir, filename) {
  try {
    const raw = readFileSync(join(dir, filename), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── loadLast: read the previous run state ────────────────────────────────────

/**
 * loadLast(loc, dir?) → the stored run state, or null if missing/corrupt/version-mismatch.
 * Null = first run. Callers must treat null as "no baseline", never as "no change".
 */
export function loadLast(loc, dir = DEFAULT_MEMORY_DIR) {
  const data = readSafe(dir, `${loc}.json`);
  if (!data || data.schemaVersion !== SCHEMA_VERSION) return null;
  return data;
}

// ── recordRun: write the new baseline ────────────────────────────────────────

/**
 * recordRun(loc, { snapshot, actions }, now, dir?) → writes new baseline atomically.
 * @param {string} loc         locationId
 * @param {object} run         { snapshot: { leads, bookings, collected, ... }, actions: [...] }
 * @param {number} now         current time ms (injected for testability)
 * @param {string} [dir]       override default dir (for tests)
 */
export function recordRun(loc, { snapshot, actions }, now, dir = DEFAULT_MEMORY_DIR) {
  // Locked because this reads `existing.snoozes` and writes it back: an unlocked baseline write
  // racing an `ack` would drop the ack. brief's call site already treats a throw as non-fatal.
  return withLock(dir, `${loc}.json`, () => {
    const existing = loadLast(loc, dir) || {};
    const data = {
      schemaVersion: SCHEMA_VERSION,
      locationId: loc,
      recordedAt: now,
      snapshot: snapshot || {},
      actions: actions || [],
      snoozes: existing.snoozes || {},
    };
    writeAtomic(dir, `${loc}.json`, data);
  });
}

// ── diff: compute what changed ───────────────────────────────────────────────

/**
 * diff(prev, currSnapshot, currActions, now) → delta object.
 *
 * If prev is null → { firstRun: true }.
 * Otherwise → {
 *   firstRun: false,
 *   baselineAt: number (ms),
 *   ageMs: number,
 *   baselineStale: bool (age > 7d),
 *   metrics: { leads: { now, prev, change }, bookings: {...}, collected: {...}, ... },
 *   newSinceLast: [...actions not in prev by contactId+kind],
 * }
 *
 * HONESTY: never emits "no change" when truth is "no/old baseline".
 */
export function diff(prev, currSnapshot, currActions, now) {
  if (!prev) return { firstRun: true };

  const ageMs = now - prev.recordedAt;
  const baselineStale = ageMs > OLD_BASELINE_MS;

  // ── Metrics delta ─────────────────────────────────────────────────────────
  // We track: leads, bookings, collected (revenue), pipeline, replyRate
  const METRIC_KEYS = ['leads', 'bookings', 'collected', 'pipeline', 'replyRate'];
  const metrics = {};
  for (const key of METRIC_KEYS) {
    const prevVal = prev.snapshot?.[key] ?? null;
    const currVal = currSnapshot?.[key] ?? null;
    // Only emit numeric deltas — string/null values get 'unknown'
    if (typeof prevVal === 'number' && typeof currVal === 'number') {
      metrics[key] = { now: currVal, prev: prevVal, change: currVal - prevVal };
    } else {
      metrics[key] = { now: currVal, prev: prevVal, change: null };
    }
  }

  // ── New actions since last run ────────────────────────────────────────────
  // An action is "new" if no item in prev.actions matches the same contactId+kind.
  const prevSet = new Set(
    (prev.actions || []).map(a => `${a.contact || a.contactId}::${a.kind}`)
  );
  const newSinceLast = (currActions || []).filter(a => {
    const key = `${a.contact || a.contactId}::${a.kind}`;
    return !prevSet.has(key);
  });

  return {
    firstRun: false,
    baselineAt: prev.recordedAt,
    ageMs,
    baselineStale,
    metrics,
    newSinceLast,
  };
}

// ── ack / snooze ─────────────────────────────────────────────────────────────

/**
 * addSnooze(loc, contactId, { snoozeMs, reason }, now, dir?) → writes updated snooze map.
 * @param {string} loc
 * @param {string} contactId
 * @param {object} opts        { snoozeMs?: number, reason?: string }
 * @param {number} now         current time ms
 * @param {string} [dir]
 */
export function addSnooze(loc, contactId, { snoozeMs = DEFAULT_SNOOZE_MS, reason = '' } = {}, now, dir = DEFAULT_MEMORY_DIR) {
  // The read and the write must be one indivisible step — see withLock's note. Unlocked, parallel
  // acks lost 3-5 of every 12 while reporting success.
  return withLock(dir, `${loc}.json`, () => {
    const existing = loadLast(loc, dir) || { schemaVersion: SCHEMA_VERSION, locationId: loc, recordedAt: null, snapshot: {}, actions: [], snoozes: {} };
    const snoozes = existing.snoozes || {};
    snoozes[contactId] = {
      contactId,
      snoozeUntil: now + snoozeMs,
      reason: reason || '',
      ackedAt: now,
    };
    const updated = { ...existing, snoozes };
    writeAtomic(dir, `${loc}.json`, updated);
    return snoozes[contactId];
  });
}

/**
 * removeSnooze(loc, contactId, dir?) → clear snooze entry.
 */
export function removeSnooze(loc, contactId, dir = DEFAULT_MEMORY_DIR) {
  // Same race, opposite direction: an unlocked clear racing an ack can resurrect the entry it
  // just deleted, or wipe an unrelated ack made a millisecond earlier.
  return withLock(dir, `${loc}.json`, () => {
    const existing = loadLast(loc, dir);
    if (!existing) return;
    const snoozes = existing.snoozes || {};
    delete snoozes[contactId];
    writeAtomic(dir, `${loc}.json`, { ...existing, snoozes });
  });
}

/**
 * listSnoozes(loc, now, dir?) → array of active snooze entries (snoozeUntil > now).
 * Expired snoozes are returned with expired:true so callers can purge or display them.
 */
export function listSnoozes(loc, now, dir = DEFAULT_MEMORY_DIR) {
  const data = loadLast(loc, dir);
  if (!data?.snoozes) return [];
  return Object.values(data.snoozes).map(s => ({
    ...s,
    expired: s.snoozeUntil <= now,
    remainingMs: Math.max(0, s.snoozeUntil - now),
  }));
}

/**
 * isSnoozed(loc, contactId, now, dir?) → true if this contactId is actively snoozed.
 * Returns false for expired snoozes (they auto-expire, item returns to queue).
 */
export function isSnoozed(loc, contactId, now, dir = DEFAULT_MEMORY_DIR) {
  const data = loadLast(loc, dir);
  if (!data?.snoozes) return false;
  const s = data.snoozes[contactId];
  if (!s) return false;
  return s.snoozeUntil > now;
}

/**
 * filterSnoozed(loc, actions, now, dir?) → { visible, snoozedCount }
 * visible = actions with non-active snoozes; snoozedCount = number filtered out.
 */
export function filterSnoozed(loc, actions, now, dir = DEFAULT_MEMORY_DIR) {
  const data = loadLast(loc, dir);
  const snoozes = data?.snoozes || {};
  const visible = [];
  let snoozedCount = 0;
  for (const a of actions) {
    const id = a.contact || a.contactId;
    const s = id ? snoozes[id] : null;
    if (s && s.snoozeUntil > now) {
      snoozedCount++;
    } else {
      visible.push(a);
    }
  }
  return { visible, snoozedCount };
}

// ── human-readable helpers ────────────────────────────────────────────────────

/**
 * formatAge(ms) → "18h ago", "3d ago", "45m ago"
 */
export function formatAge(ms) {
  if (ms == null || !Number.isFinite(ms)) return 'unknown';
  const d = Math.floor(ms / 86400000);
  if (d >= 1) return `${d}d ago`;
  const h = Math.floor(ms / 3600000);
  if (h >= 1) return `${h}h ago`;
  const m = Math.floor(ms / 60000);
  return `${m}m ago`;
}

/**
 * formatDelta(delta) → short TTY line or null if nothing notable.
 * "vs your run 18h ago: +3 leads · 2 NEW stuck deals"
 * "first run — no baseline yet"
 * "vs your run 9 days ago (stale): ..."
 */
export function formatDelta(delta) {
  if (!delta) return null;
  if (delta.firstRun) return 'first run — no baseline yet';

  const ageStr = formatAge(delta.ageMs);
  const staleNote = delta.baselineStale ? ' (stale)' : '';
  const prefix = `vs your run ${ageStr}${staleNote}:`;

  const parts = [];

  // Numeric deltas worth surfacing
  const leadsChange = delta.metrics?.leads?.change;
  if (typeof leadsChange === 'number' && leadsChange !== 0) {
    parts.push(`${leadsChange > 0 ? '+' : ''}${leadsChange} leads`);
  }

  const bookingsChange = delta.metrics?.bookings?.change;
  if (typeof bookingsChange === 'number' && bookingsChange !== 0) {
    parts.push(`${bookingsChange > 0 ? '+' : ''}${bookingsChange} bookings`);
  }

  const newCount = delta.newSinceLast?.length ?? 0;
  if (newCount > 0) {
    parts.push(`${newCount} NEW action${newCount === 1 ? '' : 's'}`);
  }

  if (!parts.length) return `${prefix} no numeric changes detected`;
  return `${prefix} ${parts.join(' · ')}`;
}

// Currency symbols, longest first so 'A$' and 'HK$' are tried before '$'. Taken from money.mjs
// rather than re-listed here: this parser must accept exactly what fmtMoney produces, and one
// fact in two places is how the two drift apart.
const MONEY_SYMBOLS = Object.values(SYM)
  .map(s => s.trim()).filter(Boolean)
  .sort((a, b) => b.length - a.length);

/**
 * parseMetricNumber(raw) → a finite number, or null when the value is not ONE unambiguous number.
 *
 * The old implementation was `value.replace(/[^0-9.-]/g, '')` then `Number(...)`. Deleting every
 * character it did not recognise made three different unknowns look like real figures. Measured
 * 2026-07-30:
 *     '—'                       -> 0            <- fmtMoney's own "unknown" marker
 *     ''                        -> 0            <- Number('') === 0
 *     'n/a'                     -> 0
 *     '₱1,234 (3) + $500 (2)'   -> 123435002    <- multi-currency, digits concatenated
 * The first three fabricate a zero, which then lands in the stored baseline and is reported as a
 * real movement: with a ₱5,000 baseline, a BLOCKED Collected metric printed `change: -5000`. The
 * fourth invents ₱123 million out of a ₱1,234 + $500 account.
 *
 * A metric this cannot read is UNKNOWN, so it returns null and diff() emits `change: null`. An
 * unreadable number must never render as zero — least of all on a money surface.
 */
export function parseMetricNumber(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  const neg = s.startsWith('-');                     // '-₱100' — sign can precede the symbol
  if (neg) s = s.slice(1).trim();
  for (const sym of MONEY_SYMBOLS) {
    if (s.startsWith(sym)) { s = s.slice(sym.length).trim(); break; }
  }
  s = s.replace(/^[A-Z]{3}\s+/, '');                 // money.mjs's unknown-code fallback: 'XYZ 1,234'
  if (s.endsWith('%')) s = s.slice(0, -1).trim();
  s = s.replace(/,/g, '');                           // thousands grouping only
  // The WHOLE remainder must now be a single numeric literal. Any leftover text — a second
  // amount, a '+', a '(3)', an em dash — means this is not one number and must not be guessed at.
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

/**
 * snapshotFromMetrics(metrics) — extract a numeric snapshot from a brief/snapshot metrics array.
 * Returns { leads, bookings, collected, pipeline, replyRate } — all nullable.
 */
export function snapshotFromMetrics(metrics) {
  if (!Array.isArray(metrics)) return {};
  const out = {};
  for (const m of metrics) {
    const label = (m.label || '').toLowerCase();
    if (m.blocked) continue;
    const v = parseMetricNumber(m.value);
    if (label.includes('lead')) out.leads = v;
    else if (label.includes('booking')) out.bookings = v;
    else if (label.includes('collect') || label.includes('revenue')) out.collected = v;
    else if (label.includes('pipeline')) out.pipeline = v;
    else if (label.includes('reply')) out.replyRate = v;
  }
  return out;
}

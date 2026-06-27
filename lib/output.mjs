// lib/output.mjs — bimodal output. TTY → human card; non-TTY/--json → frozen envelope. warn() always stderr.

// project(obj, fields): return a shallow copy of obj with only the listed keys.
// Non-objects (primitives, null) are returned as-is.
export function project(obj, fields) {
  if (!fields || !fields.length || obj == null || typeof obj !== 'object') return obj;
  const out = {};
  for (const k of fields) { if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k]; }
  return out;
}

// projectPayload(data, fields): walk known list-bearing keys and project each item.
// Covers: data.list, data.threads, data.ranked, data.items, data.sample, data.contacts.
// Every list-bearing payload key any recipe emits. A key missing here = --fields silently
// no-ops on that recipe (the 1.0.x gap on brief/pipeline). The guard test in output.test.mjs
// fails if a known recipe's list key drifts out of this set.
export const LIST_KEYS = ['list', 'threads', 'ranked', 'unknownValue', 'items', 'sample', 'contacts', 'actions', 'stuck'];
function projectPayload(data, fields) {
  if (!fields || !fields.length || data == null || typeof data !== 'object') return data;
  const result = { ...data };
  for (const k of LIST_KEYS) {
    if (Array.isArray(result[k])) {
      result[k] = result[k].map(item => project(item, fields));
    }
  }
  return result;
}

export function makeOut({ json, ndjson = false, tty, command, location, fields = null,
                          write = (s) => process.stdout.write(s),
                          writeErr = (s) => process.stderr.write(s) } = {}) {
  const machine = !!(json || ndjson); // either machine mode suppresses the human card
  const warnings = [];
  let degraded = false;
  let payload = null;
  let flushed = false;
  let maxCacheAgeMs = null; // null = no cache hits; number = max age (ms) across all cached responses
  const api = {
    color: tty && !process.env.NO_COLOR,
    data(obj) { payload = obj; },                          // machine payload
    warn(str, { degraded: d = false } = {}) { warnings.push(str); if (d) degraded = true; writeErr(str + '\n'); },
    card(fn) { if (!machine) fn(); },                       // human render (no-op in any machine mode)
    line(s = '') { if (!machine) write(s + '\n'); },
    // Track the max cache age across all responses in this run.
    // Called by context.mjs after each http.get() that returns a cacheAge.
    noteCacheAge(ageMs) {
      if (typeof ageMs === 'number') {
        maxCacheAgeMs = maxCacheAgeMs === null ? ageMs : Math.max(maxCacheAgeMs, ageMs);
      }
    },
    flush() {
      if (flushed) return;
      flushed = true;
      // TTY cache note — never show cached data without surfacing the age (human mode only;
      // it would corrupt a machine stream).
      if (!machine && maxCacheAgeMs !== null) {
        const s = Math.round(maxCacheAgeMs / 1000);
        write(`· cached ${s}s ago · --fresh to refresh\n`);
      }
      // Apply --fields projection to list arrays when requested (same for json + ndjson).
      const emitPayload = fields && fields.length ? projectPayload(payload, fields) : payload;

      if (ndjson) {
        // Newline-delimited JSON: a LEADING meta line that carries degraded/warnings + every
        // non-list field, then one line per list item. The meta line is why ndjson — unlike a
        // bare CSV — can never drop the "this source was blocked/unknown" signal.
        const listKey = (emitPayload && typeof emitPayload === 'object' && !Array.isArray(emitPayload))
          ? LIST_KEYS.find(k => Array.isArray(emitPayload[k])) : undefined;
        if (listKey) {
          const { [listKey]: rows, ...restData } = emitPayload;
          const meta = { _meta: true, schemaVersion: 1, command, location, listKey, count: rows.length, degraded, warnings, data: restData };
          if (maxCacheAgeMs !== null) meta.cacheAgeMs = maxCacheAgeMs;
          write(JSON.stringify(meta) + '\n');
          for (const row of rows) write(JSON.stringify(row) + '\n');
        } else {
          // No streamable list (e.g. doctor/snapshot) — emit the whole envelope as one ndjson
          // line. Still honest: degraded/warnings ride along.
          const envelope = { schemaVersion: 1, command, location, data: emitPayload, degraded, warnings };
          if (maxCacheAgeMs !== null) envelope.cacheAgeMs = maxCacheAgeMs;
          write(JSON.stringify(envelope) + '\n');
        }
        return;
      }

      if (json) {
        const envelope = { schemaVersion: 1, command, location, data: emitPayload, degraded, warnings };
        if (maxCacheAgeMs !== null) envelope.cacheAgeMs = maxCacheAgeMs;
        write(JSON.stringify(envelope, null, 2) + '\n');
      }
    },
    get degraded() { return degraded; },
  };
  return api;
}

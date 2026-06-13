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
const LIST_KEYS = ['list', 'threads', 'ranked', 'items', 'sample', 'contacts'];
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

export function makeOut({ json, tty, command, location, fields = null,
                          write = (s) => process.stdout.write(s),
                          writeErr = (s) => process.stderr.write(s) } = {}) {
  const warnings = [];
  let degraded = false;
  let payload = null;
  let flushed = false;
  let maxCacheAgeMs = null; // null = no cache hits; number = max age (ms) across all cached responses
  const api = {
    color: tty && !process.env.NO_COLOR,
    data(obj) { payload = obj; },                          // machine payload
    warn(str, { degraded: d = false } = {}) { warnings.push(str); if (d) degraded = true; writeErr(str + '\n'); },
    card(fn) { if (!json) fn(); },                          // human render (no-op in json mode)
    line(s = '') { if (!json) write(s + '\n'); },
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
      // TTY cache note — never show cached data without surfacing the age
      if (!json && maxCacheAgeMs !== null) {
        const s = Math.round(maxCacheAgeMs / 1000);
        write(`· cached ${s}s ago · --fresh to refresh\n`);
      }
      if (json) {
        // Apply --fields projection to list arrays when requested
        const emitPayload = fields && fields.length ? projectPayload(payload, fields) : payload;
        const envelope = { schemaVersion: 1, command, location, data: emitPayload, degraded, warnings };
        if (maxCacheAgeMs !== null) envelope.cacheAgeMs = maxCacheAgeMs;
        write(JSON.stringify(envelope, null, 2) + '\n');
      }
    },
    get degraded() { return degraded; },
  };
  return api;
}

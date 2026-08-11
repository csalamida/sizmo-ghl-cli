// lib/output.mjs — bimodal output. The mode switch is `--json`/`--ndjson`, NOT the terminal.
//
// This header used to read "TTY → human card; non-TTY/--json → frozen envelope", which was wrong in
// a way that mattered: card() gates on `machine = json || ndjson` and has never consulted tty, so
// `sizmo brief > file.txt` writes the full human card, not an envelope. That is the correct and
// intended behaviour — redirecting is not the same as asking for machine output — but the comment
// described a tool that decides for you, and someone reading it would plan around a rule that does
// not exist.
//
// warn() always goes to stderr, in every mode.
//
// There is no colour here. A `color` flag was computed from tty and honoured NO_COLOR, but nothing
// ever read it and the codebase emits zero ANSI escapes — verified 2026-08-11: 0 reads outside this
// file, 0 escape sequences in commands/, lib/ or bin/. It was removed rather than left as a promise
// the output layer does not keep. If colour is ever wanted, it needs a real implementation, and the
// flag can come back with one.

// project(obj, fields): return a shallow copy of obj with only the listed keys.
// Non-objects (primitives, null) are returned as-is.
export function project(obj, fields) {
  if (!fields || !fields.length || obj == null || typeof obj !== 'object') return obj;
  const out = {};
  for (const k of fields) { if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k]; }
  return out;
}

// LIST_KEYS: the PRIMARY streamable list key per recipe, in preference order. Used ONLY by ndjson,
// which has to pick one array to emit as rows. It is no longer the projection list — see below.
export const LIST_KEYS = ['list', 'threads', 'ranked', 'unknownValue', 'items', 'sample', 'contacts', 'actions', 'stuck'];

// projectPayload projects EVERY array-of-objects in the payload.
//
// It used to walk LIST_KEYS instead, so --fields silently did nothing on any recipe whose array key
// was absent from that hand-written set. Measured 2026-07-30 against the real payload of every
// list-bearing command:
//     booked-not-paid   neverBilled, billedUnpaid    not projected
//     snapshot          metrics                      not projected
//     pipeline          pipelines                    not projected (only `stuck` was)
//     ack               snoozes                      not projected
//
// output.test.mjs claimed to guard exactly this drift, and could not: it compared LIST_KEYS against a
// SECOND hand-written table of recipe list keys — two lists checked against each other, neither
// derived from the code, both missing the same four recipes. A guard that cannot fail for the case it
// names is worse than no guard, because it reads as coverage.
//
// So the whitelist is gone from this path rather than extended: every array whose items are objects
// is projected, which removes the drift class instead of tracking it. Arrays of primitives (a
// warnings list, a list of tag names) pass through untouched, because project() returns non-objects
// unchanged.
// An array whose items carry NONE of the requested fields is left ALONE, not emptied.
//
// Projecting every array with one flat field list gutted the arrays it did not fit. Measured
// 2026-08-11 with `--fields name,total` against the real payload shapes:
//     pipeline.pipelines   [{}]              items are {pipeline, stages}
//     snapshot.metrics     [{}]              items are {label, value, note}
//     brief.actions        [{}]              items are {contact, kind, money, …}
//     ack.snoozes          [{}]              items are {contactId, snoozeUntil, reason}
//     receivables.list     [{name, total}]   correctly projected
//     pipeline.stuck       [{name}]          correctly projected
// Four of six arrays came back as lists of empty objects: the right LENGTH, carrying nothing. A
// consumer counting rows sees data; a consumer reading rows sees nothing, with no signal that the
// two disagree.
//
// This codebase's standing rule is that an unreadable source is UNKNOWN and never zero. The same
// applies a level up: fields that do not APPLY to an array must not render as an array of empties.
// Leaving it whole preserves the data and is visibly unprojected, so the caller can tell their
// field list did not match. Dropping the key or the items would lose the count instead.
//
// Partial matches still project per item — only an array where NOTHING matched is passed through.
function projectPayload(data, fields) {
  if (!fields || !fields.length || data == null || typeof data !== 'object') return data;
  const result = { ...data };
  for (const [k, v] of Object.entries(result)) {
    if (!Array.isArray(v) || v.length === 0) continue;
    const projected = v.map(item => project(item, fields));
    // Did the projection actually find anything anywhere in this array?
    const anyKept = projected.some(x => x && typeof x === 'object' && Object.keys(x).length > 0);
    // Non-objects (a list of tag names) pass through project() unchanged; those are not "gutted".
    const wasObjects = v.some(x => x && typeof x === 'object' && !Array.isArray(x));
    result[k] = (wasObjects && !anyKept) ? v : projected;
  }
  return result;
}

export function makeOut({ json, ndjson = false, command, location, profile = null, fields = null,
                          write = (s) => process.stdout.write(s),
                          writeErr = (s) => process.stderr.write(s) } = {}) {
  const machine = !!(json || ndjson); // either machine mode suppresses the human card
  const warnings = [];
  let degraded = false;
  let payload = null;
  let flushed = false;
  let maxCacheAgeMs = null; // null = no cache hits; number = max age (ms) across all cached responses
  // The location's IANA timezone, learned once the synced model loads (context.mjs calls
  // noteTimezone from ensureModel, so no command has to remember to).
  //
  // It belongs on the ENVELOPE, not in each command's data: it describes the LOCATION, not the
  // answer, and every report that prints a date already derives it the same way. Without it a
  // consumer re-rendering a report elsewhere cannot know which zone the dates were computed in —
  // "Tue 3pm" is a different appointment in Manila and New York.
  let timezone = null;
  const api = {
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
    // First writer wins: the model's timezone is the location's, and a later caller cannot know
    // better. Same shape as noteCacheAge — the command never calls it, context.mjs does.
    noteTimezone(tz) { if (tz && !timezone) timezone = String(tz); },
    flush() {
      if (flushed) return;
      flushed = true;
      // Cache note — surfaces the age of cached data. It's a DIAGNOSTIC, not data, so it goes to
      // stderr (like warnings) — never stdout. This keeps stdout byte-clean when a human command's
      // output is redirected/piped (e.g. `sizmo export > loc.json`) while still showing on a terminal.
      if (!machine && maxCacheAgeMs !== null) {
        const s = Math.round(maxCacheAgeMs / 1000);
        writeErr(`· cached ${s}s ago · --fresh to refresh\n`);
      }
      // Apply --fields projection to list arrays when requested (same for json + ndjson).
      const emitPayload = fields && fields.length ? projectPayload(payload, fields) : payload;

      // ONE envelope builder for all three emit sites below (ndjson-with-list meta, ndjson-flat,
      // json). It used to be written as a literal at each site, so adding a field meant remembering
      // all three — exactly the one-fact-in-several-places shape behind most bugs fixed here.
      // `extra` carries the only genuine per-site difference: the ndjson meta line's listKey/count.
      const envelopeOf = (extra) => {
        const e = { schemaVersion: 1, command, location, ...extra, degraded, warnings };
        if (profile) e.profile = profile;
        if (timezone) e.timezone = timezone;
        if (maxCacheAgeMs !== null) e.cacheAgeMs = maxCacheAgeMs;
        return e;
      };

      if (ndjson) {
        // Newline-delimited JSON: a LEADING meta line that carries degraded/warnings + every
        // non-list field, then one line per list item. The meta line is why ndjson — unlike a
        // bare CSV — can never drop the "this source was blocked/unknown" signal.
        const listKey = (emitPayload && typeof emitPayload === 'object' && !Array.isArray(emitPayload))
          ? LIST_KEYS.find(k => Array.isArray(emitPayload[k])) : undefined;
        if (listKey) {
          const { [listKey]: rows, ...restData } = emitPayload;
          const meta = { _meta: true, ...envelopeOf({ listKey, count: rows.length, data: restData }) };
          write(JSON.stringify(meta) + '\n');
          for (const row of rows) write(JSON.stringify(row) + '\n');
        } else {
          // No streamable list (e.g. doctor/snapshot) — emit the whole envelope as one ndjson
          // line. Still honest: degraded/warnings ride along.
          write(JSON.stringify(envelopeOf({ data: emitPayload })) + '\n');
        }
        return;
      }

      if (json) {
        write(JSON.stringify(envelopeOf({ data: emitPayload }), null, 2) + '\n');
      }
    },
    get degraded() { return degraded; },
    // Symmetric with degraded — the JSON envelope already ships `warnings`, but callers had no
    // in-process way to read them. brief needs it to tell a permission failure (exit AUTH, "add
    // the scope") from an outage (exit API, "try again"); without it every total failure has to
    // be reported as the vaguer of the two. Copy, so a caller cannot mutate the real list.
    get warnings() { return [...warnings]; },
  };
  return api;
}

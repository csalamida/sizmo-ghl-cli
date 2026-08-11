// lib/dates.mjs — the shared time helpers. Every date/age string in this tool comes from here.
//
// WHY THIS FILE EXISTS
// These were copy-pasted across commands, and the copies had already diverged:
//     ymd()            2 identical copies      invoice.mjs, reconcile.mjs
//     parseAgeDays()   2 copies                brief.mjs, focus.mjs — focus's took a `nowMs`
//                                              parameter its body never used
//     ago()            4 copies, TWO BEHAVIOURS (see below), one file defining it twice
//     short date       2 identical copies      snapshot.mjs, booked-not-paid.mjs
//     long date        3 identical copies      all inside brief.mjs
//
// Money reports depend on these, and "one fact in several places" is the shape behind most defects
// this codebase has had to fix. Nothing here changes rendered output — the two `ago` behaviours are
// preserved exactly and given names that say which is which, so the difference is now a choice
// rather than an accident of which file someone copied from.
//
// KNOWN LOSSY PATH, deliberately left alone
// Age is computed as a NUMBER, rendered to a STRING here, then parsed back to a number by
// parseAgeDays() for ranking in brief/focus. That round-trip loses precision: agoCoarse floors
// anything under an hour to '1h', so a 20-minute-old item ranks as an hour old. The fix is to carry
// the raw timestamp alongside the label rather than re-parsing prose, which is a change to the
// ranking inputs and is out of scope here. Recorded so it is not rediscovered as a surprise.

/** ymd(ms) → 'YYYY-MM-DD' in UTC. The wire format GoHighLevel's date params expect. */
export const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * agoCoarse(nowMs, t) → '3d' | '5h'. Never emits minutes: anything under an hour floors to '1h'.
 *
 * Used where sub-hour precision is noise — a deal is not meaningfully "stuck for 20m", and an
 * appointment no-show is measured in hours at best. Preserved verbatim from noshow.mjs and
 * pipeline.mjs so their output does not shift.
 */
export function agoCoarse(nowMs, t) {
  const d = Math.floor((nowMs - t) / 86400000);
  return d >= 1 ? d + 'd' : Math.max(1, Math.floor((nowMs - t) / 3600000)) + 'h';
}

/**
 * agoFine(nowMs, t) → '3d' | '5h' | '20m'. Falls through to minutes.
 *
 * Used where minutes genuinely matter: how long a person has been waiting on a reply. Preserved
 * verbatim from triage.mjs (which defined it twice, identically).
 */
export function agoFine(nowMs, t) {
  const d = Math.floor((nowMs - t) / 86400000);
  if (d >= 1) return d + 'd';
  const h = Math.floor((nowMs - t) / 3600000);
  if (h >= 1) return h + 'h';
  return Math.max(1, Math.floor((nowMs - t) / 60000)) + 'm';
}

/**
 * parseAgeDays(str) → number of days, rounding partial units UP.
 *
 * The inverse of the ago* helpers, used by brief/focus to rank actions by staleness. A number
 * passes through; anything unparseable is 0 — deliberately NOT NaN, since NaN would poison a sort
 * silently rather than simply ranking the item as fresh.
 *
 * focus.mjs's copy declared a second `nowMs` parameter that its body never referenced. Dropped.
 */
export function parseAgeDays(str) {
  if (typeof str === 'number') return str;
  if (!str) return 0;
  const m = String(str).match(/^(\d+(?:\.\d+)?)(d|h|m)$/i);
  if (!m) return 0;
  const n = Number(m[1]);
  if (m[2] === 'd') return n;
  if (m[2] === 'h') return Math.ceil(n / 24);
  return Math.max(0, Math.ceil(n / 1440));
}

// ── display formats ─────────────────────────────────────────────────────────
// All take an explicit tz. None defaults it: a date rendered in the wrong zone is a wrong date, and
// the caller always has the location's tz via timezoneFromModel(). See lib/model.mjs.

/** fmtShortDate(ms, tz) → 'Aug 4'. */
export const fmtShortDate = (ms, tz) =>
  new Date(ms).toLocaleString('en-US', { timeZone: tz, month: 'short', day: 'numeric' });

/** fmtDateTime(ms, tz) → 'Aug 4, 3:00 PM'. Short date plus clock time. */
export const fmtDateTime = (ms, tz) =>
  new Date(ms).toLocaleString('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** fmtLongDate(ms, tz) → 'Monday, Aug 4'. The report header form. */
export const fmtLongDate = (ms, tz) =>
  new Date(ms).toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'short', day: 'numeric' });

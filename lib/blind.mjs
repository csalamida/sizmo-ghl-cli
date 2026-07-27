// lib/blind.mjs — exit-code policy for a report that could not see anything.
//
// THE BUG THIS EXISTS FOR
// A report command whose only data source is denied still produced a well-formed envelope and
// exited 0. `sizmo receivables && ship-it` proceeded, and an agent checking `$?` concluded nothing
// was owed — when the truth was "your token is not allowed to look at invoices."
//
// The envelopes were already honest: `{ blocked: 401, totalOwed: null, outstanding: null }` —
// UNKNOWN, never zero, exactly as README promises. Only the exit code lied, and the exit code is
// what shell chains and agents branch on.
//
// commands/brief.mjs was fixed for this on 2026-07-27 and its comment states the argument in full.
// Six more commands had the identical shape and were missed: receivables, booked-not-paid,
// reconcile, noshow, triage, pipeline. Found 2026-07-27 by running every read command against the
// live API with an invalid PIT and comparing exit codes.
//
// WHY THE POLICY LIVES HERE
// brief detects blindness by scanning its four lanes; these six carry an explicit top-level
// `blocked` marker. The DETECTION differs because the shapes differ — but the DECISION (what a
// blind report should exit with) is one fact and belongs in one place. brief imports the same
// mapping so the two cannot drift apart.
import { EXIT } from './errors.mjs';

// Only these mean "you were not permitted to look". A 500 means the API broke, which is a
// different thing and must not be reported as an auth problem — telling someone to fix permissions
// that are already correct is a worse bug than the one being fixed. This mirrors the bar brief set:
// exit non-zero only on DENIAL, not on mere emptiness or a transient outage.
const AUTH_BLOCKED = new Set([401, 403]);

/**
 * Map a report's blocked-marker to an exit code.
 *
 * @param {number|boolean|null|undefined} blockedCode  the `blocked` value the command put in its
 *   envelope — an HTTP status when the source could not be read, falsy when it WAS readable
 * @returns {number} AUTH when denied, API when the source failed for any other reason, OK when it
 *   was readable (including a readable-but-empty account)
 *
 * The earlier version of this returned OK for a non-auth failure, so a total API outage exited 0.
 * That was carried over from brief and documented as a known limitation. It is now closed, and the
 * reasoning that justified it turned out to be a conflation:
 *
 *   The objection was "failing on any error would report broken auth to someone whose auth is
 *   fine." True — but only if the exit code is AUTH. A 500 is not an auth problem and must not
 *   claim to be one; it is an API problem, and EXIT.API says exactly that. Splitting the two
 *   removes the objection entirely rather than trading one wrong answer for another.
 *
 * What still exits 0, correctly: a source that was READ and simply had nothing in it. That is the
 * case the old limitation was protecting, and it is protected by `blocked` being falsy — an empty
 * account never sets the marker at all.
 */
export function exitForBlockedSource(blockedCode) {
  if (!blockedCode) return EXIT.OK;          // readable — empty is not a failure
  const n = Number(blockedCode);
  if (AUTH_BLOCKED.has(n)) return EXIT.AUTH; // denied: fix the token
  return EXIT.API;                           // unreadable for some other reason: retry / report
}

/**
 * Pick one exit code for a multi-lane report, given each lane's blocked marker.
 *
 * Used by brief, which has four lanes and no single top-level marker. A report is only failed when
 * EVERY lane was unreadable — one dead lane beside three readable ones still produced real data and
 * must exit 0, which is the legitimately-empty-account case the old limitation worried about.
 *
 * When every lane is down, a denial outranks a generic failure: "your token lacks a scope" is the
 * more actionable diagnosis, and it is also the more likely explanation when several lanes fail at
 * once.
 *
 * @param {Array<object>} lanes
 * @returns {number|null} an exit code when every lane was unreadable, or null to defer
 */
export function exitForAllLanesBlocked(lanes) {
  if (!Array.isArray(lanes) || lanes.length === 0) return null;
  const marks = lanes.map(l => (l && typeof l === 'object' ? l.blocked : null));
  if (!marks.every(Boolean)) return null;    // at least one lane was readable — not blind
  const codes = marks.map(Number).filter(Number.isFinite);
  const denied = codes.find(c => AUTH_BLOCKED.has(c));
  return exitForBlockedSource(denied ?? codes[0] ?? true);
}

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
 * @param {number|null|undefined} blockedCode  the `blocked` value the command put in its envelope
 *   (an HTTP status when the source was refused, falsy when it was readable)
 * @returns {number} EXIT.AUTH when the source was DENIED, EXIT.OK otherwise
 *
 * KNOWN LIMITATION, stated rather than hidden — carried over from brief verbatim: a source that
 * fails for a NON-auth reason (a total API outage, HTTP 500) still exits 0. The report is visibly
 * degraded in both renders and carries degraded:true + warnings in the envelope, but the exit code
 * alone will not catch it. Closing that would mean treating any failure as fatal, which would fail
 * a legitimately-empty account whose auth is fine. Denial is the signal we can stand behind.
 */
export function exitForBlockedSource(blockedCode) {
  const n = Number(blockedCode);
  return AUTH_BLOCKED.has(n) ? EXIT.AUTH : EXIT.OK;
}

// lib/diagnose.mjs — shared scope-lane diagnostic engine.
// Single source of truth for the per-scope probe used by BOTH `auth check` (lib/cli.mjs)
// and `doctor` (commands/doctor.mjs). No new API surface — same live GET-probe semantics
// as the original inline `auth check` LANES table.
//
// Probe rule (unchanged): 401/403 = scope MISSING; 200 or a 4xx param error (400/422)
// = scope PRESENT (the PIT can reach the endpoint, it just didn't like the params).
// READ-ONLY — every probe path is a GET with limit=1.
import { mapLimit } from './pool.mjs';

// LANES — the 6 read scopes the full `brief` needs. Each lane names the GHL scope string
// (verbatim, must match README's copy-block) and a probe path that requires that scope.
// `affects` lists the recipe(s) that degrade when this scope is missing — used by doctor
// to trace every blocked lane to a named consequence + fix.
export function buildLanes(loc) {
  // Encode loc — a stray &/?/# or path char in a hand-edited or env-supplied loc would
  // otherwise corrupt the request shape (inject query params / escape the path segment).
  const L = encodeURIComponent(loc);
  return [
    { name: 'contacts',      scope: 'contacts.readonly',              path: `/contacts/?locationId=${L}&limit=1`,                               affects: ['brief', 'triage', 'segment', 'snapshot'] },
    { name: 'conversations', scope: 'conversations.readonly',         path: `/conversations/search?locationId=${L}&limit=1`,                     affects: ['triage', 'brief'] },
    { name: 'opportunities', scope: 'opportunities.readonly',         path: `/opportunities/search?location_id=${L}&limit=1`,                    affects: ['pipeline', 'focus', 'brief'] },
    { name: 'calendars',     scope: 'calendars.readonly',             path: `/calendars/?locationId=${L}`,                                       affects: ['noshow', 'booked-not-paid', 'brief'] },
    { name: 'invoices',      scope: 'invoices.readonly',              path: `/invoices/?altId=${L}&altType=location&limit=1`,                    affects: ['receivables', 'booked-not-paid', 'brief'] },
    { name: 'payments',      scope: 'payments/transactions.readonly', path: `/payments/transactions?altId=${L}&altType=location&limit=1`,        affects: ['reconcile', 'booked-not-paid', 'brief'] },
  ];
}

// The write scopes (not probed live — writes are confirm-gated and not part of the read brief),
// surfaced verbatim for the init copy-block so a user grants everything in one paste.
export const READ_SCOPES = [
  'contacts.readonly', 'conversations.readonly', 'opportunities.readonly',
  'calendars.readonly', 'invoices.readonly', 'payments/transactions.readonly',
];
export const WRITE_SCOPES = [
  'contacts.write', 'opportunities.write', 'calendars.write', 'conversations/message.write',
];

/**
 * probeLanes(http, loc) → array of { name, scope, ok, code, affects, error? }
 * Probes all lanes concurrently (cap 5). A transport error → ok:false, code:0.
 * Returns the same per-lane shape `auth check` produced inline, plus `affects`.
 * Does NOT decide an exit code — callers map results to their own contract.
 */
export async function probeLanes(http, loc) {
  const lanes = buildLanes(loc);
  return mapLimit(lanes, 5, async (lane) => {
    try {
      const r = await http.get(lane.path);
      const ok = r.code !== 401 && r.code !== 403;
      return { name: lane.name, scope: lane.scope, ok, code: r.code, affects: lane.affects };
    } catch (e) {
      return { name: lane.name, scope: lane.scope, ok: false, code: 0, affects: lane.affects, error: e?.message ?? 'error' };
    }
  });
}

// scripts/daily-loop/mcos-log-run.mjs — log one daily-loop run as a task in MC OS.
//
// Talks to the MC OS local API (:54321), NOT a JSON file. mission-control-os migrated to SQLite
// on 2026-07-22 and retired data/mcos.json; this script kept writing the dead path and silently
// logged nothing from 07-16 onward — which matters because "Daily run history" is the telemetry
// that caught the UTC/local date bug on 07-15. A blind loop is worse than a slow one.
//
// Still non-fatal by design: if the API is down, the audit run itself must not fail. Discord
// notification is run.mjs's job (notify.mjs), separate from this bookkeeping.
//
// Usage: node mcos-log-run.mjs <lane-key> <outcome: pr|clean|failed|timeout> "<summary>" [prUrl] [dateStr]
import { randomUUID } from 'node:crypto';

const API = 'http://localhost:54321/rest/v1';
const HEADERS = {
  'apikey': 'local-anon-key-dev',
  'Authorization': 'Bearer local-access-token',
  'Content-Type': 'application/json',
};
const GOAL_ID = '78ccda5e-829b-40c0-9afe-5ab5cc0c09d6';       // Sizmo CLI: Recurring Engineering Loop
const HISTORY_MISSION_ID = '5f85e5ba-c2fe-495c-b3bf-6cb40b15d924'; // Daily run history
// IDs, not titles — titles get reworded during migrations/cleanups and a title lookup then fails
// silently ("goal not found", exit 0). Both IDs survived the SQLite migration unchanged.

const [, , laneKey, outcome, summary, prUrl, passedDateStr] = process.argv;
if (!laneKey || !outcome || !summary) {
  console.error('usage: mcos-log-run.mjs <lane-key> <outcome> "<summary>" [prUrl] [dateStr]');
  process.exit(1);
}

const now = Date.now();
// Prefer the date run.mjs stamped at the START of the run — deriving our own here disagrees with
// the branch name whenever a run crosses midnight (seen live 2026-07-26: branch 07-26, row 07-27).
// The local-date fallback is for direct/manual invocation only, and matches run.mjs's formula.
const dateStr = passedDateStr || (() => {
  const d = new Date(now);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
})();

const OUTCOME_LABEL = { pr: 'PR opened', clean: 'clean — nothing found', failed: 'FAILED', timeout: 'TIMED OUT' };
const label = OUTCOME_LABEL[outcome] || outcome;
const isBad = outcome === 'failed' || outcome === 'timeout';

async function main() {
  // Order-index = current row count, so history stays append-ordered in the UI.
  let orderIndex = 0;
  try {
    const res = await fetch(`${API}/tasks?select=id&mission_id=eq.${HISTORY_MISSION_ID}`, { headers: HEADERS });
    if (res.ok) orderIndex = (await res.json()).length;
  } catch { /* fall back to 0 — ordering is cosmetic, never worth failing the log over */ }

  const task = {
    id: randomUUID(),
    created_at: new Date(now).toISOString(),
    updated_at: new Date(now).toISOString(),
    mission_id: HISTORY_MISSION_ID,
    goal_id: GOAL_ID,
    title: `${dateStr} · ${laneKey} · ${label}`,
    priority: 'medium',
    status: isBad ? 'blocked' : 'completed',
    order_index: orderIndex,
    created_by: 'daily-loop',
    created_at_ts: now,
    notes: summary + (prUrl ? `\nPR: ${prUrl}` : ''),
    assigned_to: null,
    completed_at: isBad ? null : now,
  };

  const res = await fetch(`${API}/tasks`, {
    method: 'POST',
    headers: { ...HEADERS, Prefer: 'return=minimal' },
    body: JSON.stringify(task),
  });
  if (!res.ok) throw new Error(`POST /tasks ${res.status}: ${(await res.text()).slice(0, 200)}`);

  console.log(`✓ logged: ${dateStr} · ${laneKey} · ${label}`);
}

main().catch((e) => {
  // Non-fatal on purpose — MC OS being down must never fail the actual audit run. But it prints
  // loudly to the log so a silent telemetry outage is visible on the next glance, not invisible.
  console.error(`MC OS log FAILED (run itself unaffected): ${e.message}`);
  process.exit(0);
});

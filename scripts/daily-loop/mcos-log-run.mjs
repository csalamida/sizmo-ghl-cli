// scripts/daily-loop/mcos-log-run.mjs — log one daily-loop run as a task in MC OS.
// Writes directly to mission-control-os/data/mcos.json (same pattern as the existing
// seed-*.mjs scripts in that repo) — silent bookkeeping, no Discord (run.mjs handles that
// separately via notify.mjs, since a JSON-only write skips the notify path entirely).
//
// Usage: node mcos-log-run.mjs <lane-key> <outcome: pr|clean|failed|timeout> "<summary>" [prUrl]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const MCOS_FILE = '/Users/cjay1107/Desktop/clawd-local/Clawd Projects/mission-control-os/data/mcos.json';
const GOAL_TITLE = 'Sizmo CLI: Recurring Engineering Loop (Daily Audit + Weekly Ship)';
const HISTORY_MISSION_TITLE = 'Daily run history';

const [, , laneKey, outcome, summary, prUrl] = process.argv;
if (!laneKey || !outcome || !summary) {
  console.error('usage: mcos-log-run.mjs <lane-key> <outcome> "<summary>" [prUrl]');
  process.exit(1);
}
if (!existsSync(MCOS_FILE)) {
  console.error('mcos.json not found — skipping MC OS log (daily-loop run itself is unaffected)');
  process.exit(0); // non-fatal — MC OS being down must never fail the actual audit run
}

const now = Date.now();
const iso = ts => new Date(ts).toISOString();
const db = JSON.parse(readFileSync(MCOS_FILE, 'utf8'));
db.goals ||= []; db.missions ||= []; db.tasks ||= []; db.logs ||= [];

const goal = db.goals.find(g => g.title === GOAL_TITLE);
if (!goal) {
  console.error(`goal "${GOAL_TITLE}" not found — run the seed script first`);
  process.exit(0); // non-fatal, same reasoning
}

let mission = db.missions.find(m => m.goal_id === goal.id && m.title === HISTORY_MISSION_TITLE);
if (!mission) {
  mission = {
    id: randomUUID(), created_at: iso(now), updated_at: iso(now), title: HISTORY_MISSION_TITLE,
    state: 'Waiting', priority: 'Medium', deadline: now + 365 * 86400000, assigned_to: 'CTO',
    deliverables: [], goal_id: goal.id, last_activity: now, confidence: 0.9, created_at_ts: now,
    agent_ids: [], notes: '[ops] Ongoing — one task per daily-loop run, appended as it fires.',
    budget_allocated: 0, budget_spent: 0, timeline: 'Ongoing',
  };
  db.missions.push(mission);
  goal.mission_ids = [...(goal.mission_ids || []), mission.id];
}

const OUTCOME_LABEL = { pr: 'PR opened', clean: 'clean — nothing found', failed: 'FAILED', timeout: 'TIMED OUT' };
const label = OUTCOME_LABEL[outcome] || outcome;
// Local date, not UTC — must match run.mjs's dateStr (same bug class: toISOString() is UTC and
// drifts a day behind local time before UTC midnight, e.g. a 7am fire in UTC+8).
const nowDate = new Date(now);
const dateStr = [
  nowDate.getFullYear(),
  String(nowDate.getMonth() + 1).padStart(2, '0'),
  String(nowDate.getDate()).padStart(2, '0'),
].join('-');

db.tasks.push({
  id: randomUUID(), created_at: iso(now), updated_at: iso(now), mission_id: mission.id, goal_id: goal.id,
  title: `${dateStr} · ${laneKey} · ${label}`, priority: 'medium',
  status: outcome === 'failed' || outcome === 'timeout' ? 'blocked' : 'completed',
  order_index: db.tasks.filter(t => t.mission_id === mission.id).length,
  created_by: 'daily-loop', created_at_ts: now,
  notes: summary + (prUrl ? `\nPR: ${prUrl}` : ''),
  assigned_to: null, ...(outcome !== 'failed' && outcome !== 'timeout' ? { completed_at: now } : {}),
});

mission.last_activity = now;
mission.updated_at = iso(now);
goal.updated_at = iso(now);

db.logs.unshift({
  id: randomUUID(), created_at: iso(now), created_at_ts: now, mission_id: mission.id, agent_id: 'daily-loop',
  level: outcome === 'failed' || outcome === 'timeout' ? 'error' : 'info',
  message: `Daily loop [${laneKey}]: ${label} — ${summary}`,
});

writeFileSync(MCOS_FILE, JSON.stringify(db, null, 2));
console.log(`✓ logged: ${dateStr} · ${laneKey} · ${label}`);

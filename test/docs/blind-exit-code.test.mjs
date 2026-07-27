// test/docs/blind-exit-code.test.mjs
// A report that was DENIED its data source must not exit 0.
//
// WHY: found 2026-07-27 by running every read command against the live API with an invalid PIT and
// comparing exit codes. Six reports produced an honest envelope — `{blocked: 401, totalOwed: null,
// outstanding: null}`, UNKNOWN never zero, exactly as README promises — and then exited 0.
//
//     sizmo receivables && ship-it     # proceeds
//     $?                               # 0 — "nothing owed"
//
// The envelope was right and the exit code lied, and the exit code is what shell chains and agents
// branch on. commands/brief.mjs was fixed for this earlier the same day; receivables,
// booked-not-paid, reconcile, noshow, triage and pipeline had the identical shape and were missed.
//
// This file guards the CLASS, not just the six. Any future report that can emit a `blocked` marker
// must route its exit code through lib/blind.mjs.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitForBlockedSource } from '../../lib/blind.mjs';
import { EXIT } from '../../lib/errors.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CMD_DIR = join(REPO, 'commands');
const sourceOf = (c) => readFileSync(join(CMD_DIR, `${c}.mjs`), 'utf8');

// ── the policy itself ────────────────────────────────────────────────────────

test('exitForBlockedSource: 401 and 403 are the only codes that mean AUTH', () => {
  assert.equal(exitForBlockedSource(401), EXIT.AUTH);
  assert.equal(exitForBlockedSource(403), EXIT.AUTH);
  assert.equal(exitForBlockedSource('401'), EXIT.AUTH, 'a string status must map the same way');
});

test('exitForBlockedSource: a readable source exits OK', () => {
  for (const v of [null, undefined, 0, false, '']) {
    assert.equal(exitForBlockedSource(v), EXIT.OK,
      `blocked=${JSON.stringify(v)} means the source WAS readable — a legitimately empty account ` +
      `must still exit 0. Failing it would report broken auth to someone whose auth is fine.`);
  }
});

test('exitForBlockedSource: a NON-auth failure does not claim an auth problem', () => {
  // Deliberate, carried over from brief: a 500 means the API broke, not that permissions are
  // wrong. Telling someone to fix a scope that is already correct is worse than the bug being
  // fixed. Stated as a known limitation in lib/blind.mjs rather than hidden.
  assert.equal(exitForBlockedSource(500), EXIT.OK);
  assert.equal(exitForBlockedSource(429), EXIT.OK);
});

// ── every report that can go blind routes through it ─────────────────────────

const BLIND_CAPABLE_REPORTS = ['receivables', 'booked-not-paid', 'reconcile', 'noshow', 'triage', 'pipeline'];

for (const cmd of BLIND_CAPABLE_REPORTS) {
  test(`${cmd}: exit code is derived from its blocked marker, not hardcoded 0`, () => {
    const src = sourceOf(cmd);
    assert.match(src, /exitForBlockedSource/,
      `${cmd} emits a \`blocked\` marker when its source is denied but does not use it to pick an ` +
      `exit code. A denied report that exits 0 is a fake-green: the envelope says UNKNOWN and the ` +
      `exit code says fine.`);
    assert.ok(!/^\s*return 0;\s*$/m.test(src),
      `${cmd} still has a bare \`return 0\` — the exit code must come from exitForBlockedSource()`);
  });
}

test('brief uses the SAME policy, so the two cannot drift apart', () => {
  // brief detects blindness differently (it scans four lanes; it has no single blocked marker),
  // but the DECISION about what a blind report exits with is one fact and lives in one place.
  const src = sourceOf('brief');
  assert.match(src, /exitForBlockedSource/,
    'brief must route its final exit through lib/blind.mjs, not keep a second copy of the policy');
});

// Every command that can emit a `blocked` marker must be classified as ONE of these. A new command
// that emits `blocked` and appears in neither list fails the test below — forcing an explicit
// decision rather than defaulting to whichever behaviour happened to get written.
//
// FULLY-BLIND-CAPABLE: `blocked` sits at the TOP LEVEL of the emitted data with every metric null,
// meaning the whole report saw nothing. Exit code must come from the shared policy.
const FULLY_BLIND_CAPABLE = new Set([...BLIND_CAPABLE_REPORTS, 'segment', 'brief']);

// PARTIAL-BLINDNESS: `blocked` is marked PER ENTITY or PER METRIC, so one denied source among many
// is normal and the report is still useful. Exiting AUTH because 1 of 12 entities is blocked would
// be wrong — the denial is conveyed by degraded:true + warnings + the per-item marker.
//
//   export    writes { blocked: <scope> } per resource into a bundle whose whole point is to record
//             what was and was not readable
//   snapshot  marks individual metrics (Leads, Bookings, Show rate) blocked; the others still count
//   sync      records per-entity block state INTO the model cache — that IS its output
//   crm       converted 2026-07-27 to THROW GhlError instead (AUTH on a scope denial, API when an
//             httpCode is present), matching list.mjs and surveys.mjs. It needs no exit policy
//             because it never returns on a blocked path.
const PARTIAL_BLINDNESS = new Set(['export', 'snapshot', 'sync', 'crm']);

test('every command emitting a `blocked` marker is classified fully-blind or partial', () => {
  const emitters = readdirSync(CMD_DIR)
    .filter(f => f.endsWith('.mjs'))
    .map(f => f.replace('.mjs', ''))
    .filter(cmd => {
      // Strip comments so prose about the bug cannot trip its own guard.
      const code = sourceOf(cmd).split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
      return /\bblocked:\s*[a-zA-Z_]/.test(code);
    })
    .sort();

  const unclassified = emitters
    .filter(c => !FULLY_BLIND_CAPABLE.has(c) && !PARTIAL_BLINDNESS.has(c));
  assert.deepEqual(unclassified, [],
    `These emit a \`blocked\` marker but are in neither list: ${unclassified.join(', ')}. ` +
    `Decide which it is. If the marker means the WHOLE report saw nothing, add it to ` +
    `FULLY_BLIND_CAPABLE and return exitForBlockedSource(data.blocked). If it marks one source ` +
    `among several, add it to PARTIAL_BLINDNESS with a line saying why exiting 0 is honest there.`);
});

test('the fully-blind reports all route through the shared policy', () => {
  const missing = [...FULLY_BLIND_CAPABLE]
    .filter(c => !/exitForBlockedSource/.test(sourceOf(c)))
    .sort();
  assert.deepEqual(missing, [],
    `Classified fully-blind but not using the policy: ${missing.join(', ')}`);
});

test('the partial-blindness commands deliberately do NOT use the policy', () => {
  // Keeps the classification honest in the other direction: if one of these later grows a
  // top-level blind path, it should move lists rather than quietly gain an exit-code change.
  const unexpected = [...PARTIAL_BLINDNESS]
    .filter(c => /exitForBlockedSource/.test(sourceOf(c)))
    .sort();
  assert.deepEqual(unexpected, [],
    `These are classified partial-blindness but now use the blind-exit policy: ${unexpected.join(', ')}. ` +
    `If that is intentional, move them to FULLY_BLIND_CAPABLE and say why.`);
});

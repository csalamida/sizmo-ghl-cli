// test/commands/memory.test.mjs — unit tests for lib/memory.mjs
// TDD: injected clock + temp dir — no real fs side-effects persisted.
// Covers: recordRun, loadLast, diff, addSnooze, removeSnooze, listSnoozes,
//         filterSnoozed, isSnoozed, formatAge, formatDelta, snapshotFromMetrics.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  recordRun, loadLast, diff,
  addSnooze, removeSnooze, listSnoozes, filterSnoozed, isSnoozed,
  formatAge, formatDelta, snapshotFromMetrics,
  DEFAULT_SNOOZE_MS, SCHEMA_VERSION,
} from '../../lib/memory.mjs';

// ── helpers ──────────────────────────────────────────────────────────────────

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'sizmo-mem-test-'));
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const NOW = 1_700_000_000_000; // fixed clock
const LOC = 'L-TEST';

const SAMPLE_SNAPSHOT = { leads: 5, bookings: 3, collected: 50000, pipeline: 200000, replyRate: 85 };
const SAMPLE_ACTIONS = [
  { contact: 'c1', contactId: 'c1', kind: 'stuck-deals', name: 'Deal A' },
  { contact: 'c2', contactId: 'c2', kind: 'waiting-reply', name: 'Thread B' },
];

// ── recordRun + loadLast ──────────────────────────────────────────────────────

test('memory: recordRun writes + loadLast reads back schemaVersion=1', () => {
  const dir = tmpDir();
  try {
    recordRun(LOC, { snapshot: SAMPLE_SNAPSHOT, actions: SAMPLE_ACTIONS }, NOW, dir);
    const loaded = loadLast(LOC, dir);
    assert.equal(loaded.schemaVersion, SCHEMA_VERSION);
    assert.equal(loaded.locationId, LOC);
    assert.equal(loaded.recordedAt, NOW);
    assert.deepEqual(loaded.snapshot, SAMPLE_SNAPSHOT);
    assert.deepEqual(loaded.actions, SAMPLE_ACTIONS);
  } finally { cleanup(dir); }
});

test('memory: loadLast returns null when no file exists', () => {
  const dir = tmpDir();
  try {
    const result = loadLast(LOC, dir);
    assert.strictEqual(result, null);
  } finally { cleanup(dir); }
});

test('memory: loadLast returns null on corrupt JSON', () => {
  const dir = tmpDir();
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, `${LOC}.json`), 'NOT_JSON', { mode: 0o600 });
    assert.strictEqual(loadLast(LOC, dir), null);
  } finally { cleanup(dir); }
});

test('memory: recordRun preserves existing snoozes on re-record', () => {
  const dir = tmpDir();
  try {
    recordRun(LOC, { snapshot: SAMPLE_SNAPSHOT, actions: SAMPLE_ACTIONS }, NOW, dir);
    addSnooze(LOC, 'c99', { snoozeMs: DEFAULT_SNOOZE_MS }, NOW, dir);
    recordRun(LOC, { snapshot: { leads: 10 }, actions: [] }, NOW + 1000, dir);
    const loaded = loadLast(LOC, dir);
    assert.ok(loaded.snoozes?.['c99'], 'snooze survives re-record');
  } finally { cleanup(dir); }
});

// ── diff ──────────────────────────────────────────────────────────────────────

test('memory diff: null prev → firstRun:true', () => {
  const result = diff(null, SAMPLE_SNAPSHOT, SAMPLE_ACTIONS, NOW);
  assert.equal(result.firstRun, true);
  assert.ok(!('metrics' in result), 'no metrics in firstRun diff');
  assert.ok(!('baselineAt' in result), 'no baselineAt in firstRun diff');
});

test('memory diff: prev present → firstRun:false, correct metric deltas', () => {
  const dir = tmpDir();
  try {
    // prev: leads=3, bookings=2
    const prevSnap = { leads: 3, bookings: 2, collected: 30000, pipeline: 100000, replyRate: 70 };
    recordRun(LOC, { snapshot: prevSnap, actions: [] }, NOW - 3600000, dir);
    const prev = loadLast(LOC, dir);

    const currSnap = { leads: 6, bookings: 2, collected: 45000, pipeline: 100000, replyRate: 80 };
    const result = diff(prev, currSnap, SAMPLE_ACTIONS, NOW);

    assert.equal(result.firstRun, false);
    assert.equal(result.baselineAt, NOW - 3600000);
    assert.ok(result.ageMs > 0);
    assert.equal(result.baselineStale, false, 'not stale for 1h baseline');

    // leads: +3
    assert.equal(result.metrics.leads.change, 3);
    assert.equal(result.metrics.leads.prev, 3);
    assert.equal(result.metrics.leads.now, 6);

    // bookings: 0 change
    assert.equal(result.metrics.bookings.change, 0);

    // replyRate: +10
    assert.equal(result.metrics.replyRate.change, 10);
  } finally { cleanup(dir); }
});

test('memory diff: baselineStale=true when prev is >7d old', () => {
  const dir = tmpDir();
  try {
    const NINE_DAYS_MS = 9 * 24 * 60 * 60 * 1000;
    recordRun(LOC, { snapshot: SAMPLE_SNAPSHOT, actions: [] }, NOW - NINE_DAYS_MS, dir);
    const prev = loadLast(LOC, dir);
    const result = diff(prev, SAMPLE_SNAPSHOT, [], NOW);
    assert.equal(result.baselineStale, true);
  } finally { cleanup(dir); }
});

test('memory diff: newSinceLast only contains items not in prev actions', () => {
  const dir = tmpDir();
  try {
    const prevActions = [{ contact: 'c1', kind: 'stuck-deals' }];
    recordRun(LOC, { snapshot: SAMPLE_SNAPSHOT, actions: prevActions }, NOW - 1000, dir);
    const prev = loadLast(LOC, dir);

    const currActions = [
      { contact: 'c1', kind: 'stuck-deals' }, // old — should NOT be in newSinceLast
      { contact: 'c3', kind: 'receivables' }, // NEW
      { contact: 'c4', kind: 'waiting-reply' }, // NEW
    ];
    const result = diff(prev, SAMPLE_SNAPSHOT, currActions, NOW);
    assert.equal(result.newSinceLast.length, 2);
    const ids = result.newSinceLast.map(a => a.contact);
    assert.ok(ids.includes('c3'));
    assert.ok(ids.includes('c4'));
    assert.ok(!ids.includes('c1'));
  } finally { cleanup(dir); }
});

test('memory diff: metrics null when prev value is non-numeric', () => {
  const dir = tmpDir();
  try {
    const prevSnap = { leads: null, bookings: 'unknown' };
    recordRun(LOC, { snapshot: prevSnap, actions: [] }, NOW - 1000, dir);
    const prev = loadLast(LOC, dir);
    const result = diff(prev, { leads: 5, bookings: 3 }, [], NOW);
    // leads: prev null → change null
    assert.strictEqual(result.metrics.leads.change, null);
  } finally { cleanup(dir); }
});

// ── addSnooze + isSnoozed + removeSnooze ─────────────────────────────────────

test('memory ack: addSnooze writes entry, isSnoozed returns true', () => {
  const dir = tmpDir();
  try {
    addSnooze(LOC, 'c10', { snoozeMs: DEFAULT_SNOOZE_MS, reason: 'called back' }, NOW, dir);
    assert.equal(isSnoozed(LOC, 'c10', NOW, dir), true);
  } finally { cleanup(dir); }
});

test('memory ack: isSnoozed returns false for unknown contact', () => {
  const dir = tmpDir();
  try {
    assert.equal(isSnoozed(LOC, 'nobody', NOW, dir), false);
  } finally { cleanup(dir); }
});

test('memory ack: isSnoozed returns false for expired snooze', () => {
  const dir = tmpDir();
  try {
    // snooze for 1ms, then check 1s later
    addSnooze(LOC, 'c11', { snoozeMs: 1 }, NOW, dir);
    assert.equal(isSnoozed(LOC, 'c11', NOW + 1000, dir), false);
  } finally { cleanup(dir); }
});

test('memory ack: removeSnooze clears the entry', () => {
  const dir = tmpDir();
  try {
    addSnooze(LOC, 'c12', { snoozeMs: DEFAULT_SNOOZE_MS }, NOW, dir);
    assert.equal(isSnoozed(LOC, 'c12', NOW, dir), true);
    removeSnooze(LOC, 'c12', dir);
    assert.equal(isSnoozed(LOC, 'c12', NOW, dir), false);
  } finally { cleanup(dir); }
});

test('memory ack: removeSnooze is safe when no file exists', () => {
  const dir = tmpDir();
  try {
    assert.doesNotThrow(() => removeSnooze(LOC, 'nobody', dir));
  } finally { cleanup(dir); }
});

test('memory ack: addSnooze stores reason correctly', () => {
  const dir = tmpDir();
  try {
    addSnooze(LOC, 'c13', { snoozeMs: DEFAULT_SNOOZE_MS, reason: 'called yesterday' }, NOW, dir);
    const snoozes = listSnoozes(LOC, NOW, dir);
    const entry = snoozes.find(s => s.contactId === 'c13');
    assert.ok(entry, 'entry found');
    assert.equal(entry.reason, 'called yesterday');
  } finally { cleanup(dir); }
});

test('memory ack: multiple snoozes coexist independently', () => {
  const dir = tmpDir();
  try {
    addSnooze(LOC, 'cA', { snoozeMs: DEFAULT_SNOOZE_MS }, NOW, dir);
    addSnooze(LOC, 'cB', { snoozeMs: 1000 }, NOW, dir); // expires in 1s
    assert.equal(isSnoozed(LOC, 'cA', NOW, dir), true);
    assert.equal(isSnoozed(LOC, 'cB', NOW, dir), true);
    // After 2s, cB expired
    assert.equal(isSnoozed(LOC, 'cA', NOW + 2000, dir), true);
    assert.equal(isSnoozed(LOC, 'cB', NOW + 2000, dir), false);
  } finally { cleanup(dir); }
});

// ── listSnoozes ──────────────────────────────────────────────────────────────

test('memory: listSnoozes returns empty array when no file', () => {
  const dir = tmpDir();
  try {
    assert.deepEqual(listSnoozes(LOC, NOW, dir), []);
  } finally { cleanup(dir); }
});

test('memory: listSnoozes returns active + expired with correct flags', () => {
  const dir = tmpDir();
  try {
    addSnooze(LOC, 'active1', { snoozeMs: DEFAULT_SNOOZE_MS }, NOW, dir);
    addSnooze(LOC, 'expired1', { snoozeMs: 1 }, NOW, dir);
    const list = listSnoozes(LOC, NOW + 5000, dir); // 5s later, expired1 is expired
    const active = list.filter(s => !s.expired);
    const expired = list.filter(s => s.expired);
    assert.ok(active.some(s => s.contactId === 'active1'));
    assert.ok(expired.some(s => s.contactId === 'expired1'));
  } finally { cleanup(dir); }
});

// ── filterSnoozed ────────────────────────────────────────────────────────────

test('memory: filterSnoozed removes active snoozes, keeps rest', () => {
  const dir = tmpDir();
  try {
    addSnooze(LOC, 'c1', { snoozeMs: DEFAULT_SNOOZE_MS }, NOW, dir);
    const actions = [
      { contact: 'c1', kind: 'stuck-deals' },
      { contact: 'c2', kind: 'receivables' },
      { contact: 'c3', kind: 'waiting-reply' },
    ];
    const { visible, snoozedCount } = filterSnoozed(LOC, actions, NOW, dir);
    assert.equal(snoozedCount, 1);
    assert.equal(visible.length, 2);
    assert.ok(visible.every(a => a.contact !== 'c1'), 'c1 filtered out');
  } finally { cleanup(dir); }
});

test('memory: filterSnoozed keeps expired snoozes (item returns to queue)', () => {
  const dir = tmpDir();
  try {
    addSnooze(LOC, 'c1', { snoozeMs: 100 }, NOW, dir);
    const actions = [{ contact: 'c1', kind: 'stuck-deals' }];
    // Check AFTER expiry
    const { visible, snoozedCount } = filterSnoozed(LOC, actions, NOW + 1000, dir);
    assert.equal(snoozedCount, 0, 'expired snooze not counted');
    assert.equal(visible.length, 1, 'item returned to queue');
  } finally { cleanup(dir); }
});

test('memory: filterSnoozed with no memory file = all visible, 0 snoozed', () => {
  const dir = tmpDir();
  try {
    const actions = [{ contact: 'c1', kind: 'stuck-deals' }];
    const { visible, snoozedCount } = filterSnoozed(LOC, actions, NOW, dir);
    assert.equal(snoozedCount, 0);
    assert.equal(visible.length, 1);
  } finally { cleanup(dir); }
});

// ── formatAge ────────────────────────────────────────────────────────────────

test('memory: formatAge handles days, hours, minutes', () => {
  assert.equal(formatAge(2 * 86400000), '2d ago');
  assert.equal(formatAge(18 * 3600000), '18h ago');
  assert.equal(formatAge(45 * 60000), '45m ago');
  assert.equal(formatAge(0), '0m ago');
  assert.equal(formatAge(null), 'unknown');
});

// ── formatDelta ───────────────────────────────────────────────────────────────

test('memory: formatDelta firstRun says "no baseline yet"', () => {
  const result = formatDelta({ firstRun: true });
  assert.ok(result.includes('no baseline'));
  assert.ok(!result.includes('no change'), 'must not imply no change');
});

test('memory: formatDelta with stale baseline notes staleness', () => {
  const result = formatDelta({
    firstRun: false,
    ageMs: 9 * 24 * 60 * 60 * 1000,
    baselineStale: true,
    metrics: { leads: { change: 2, now: 7, prev: 5 } },
    newSinceLast: [],
  });
  assert.ok(result.includes('stale'), 'stale noted');
  assert.ok(result.includes('+2 leads'), 'change shown');
});

test('memory: formatDelta with no numeric changes says "no numeric changes detected"', () => {
  const result = formatDelta({
    firstRun: false,
    ageMs: 3 * 3600000,
    baselineStale: false,
    metrics: { leads: { change: 0 }, bookings: { change: 0 } },
    newSinceLast: [],
  });
  assert.ok(result.includes('no numeric changes detected'));
});

test('memory: formatDelta null input returns null', () => {
  assert.strictEqual(formatDelta(null), null);
});

test('memory: formatDelta shows newSinceLast count', () => {
  const result = formatDelta({
    firstRun: false,
    ageMs: 3600000,
    baselineStale: false,
    metrics: { leads: { change: 0 } },
    newSinceLast: [{ contact: 'x', kind: 'stuck-deals' }],
  });
  assert.ok(result.includes('1 NEW action'));
});

// ── snapshotFromMetrics ───────────────────────────────────────────────────────

test('memory: snapshotFromMetrics extracts numeric values from label matches', () => {
  const metrics = [
    { label: 'Leads', value: 7, blocked: false },
    { label: 'Bookings', value: 4, blocked: false },
    { label: 'Collected', value: '₱50,000', blocked: false },
    { label: 'Show rate', value: '85%', blocked: false },
    { label: 'Pipeline value', value: '₱200,000', blocked: false },
    { label: 'Reply rate', value: '70%', blocked: false },
  ];
  const snap = snapshotFromMetrics(metrics);
  assert.equal(snap.leads, 7);
  assert.equal(snap.bookings, 4);
  assert.equal(snap.collected, 50000);
  assert.equal(snap.pipeline, 200000);
  assert.equal(snap.replyRate, 70);
});

test('memory: snapshotFromMetrics skips blocked metrics', () => {
  const metrics = [
    { label: 'Leads', value: null, blocked: true, blocker: 'contacts read failed' },
    { label: 'Bookings', value: 3, blocked: false },
  ];
  const snap = snapshotFromMetrics(metrics);
  assert.ok(!('leads' in snap), 'blocked leads not extracted');
  assert.equal(snap.bookings, 3);
});

test('memory: snapshotFromMetrics returns empty object for non-array input', () => {
  assert.deepEqual(snapshotFromMetrics(null), {});
  assert.deepEqual(snapshotFromMetrics(undefined), {});
  assert.deepEqual(snapshotFromMetrics('not an array'), {});
});

// test/lib/ask-memory.test.mjs — local-only TTL caches for `sizmo ask` pronoun support and the
// preview→confirm plan replay. Every test uses a throwaway temp dir (never touches ~/.config).
import { test, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  saveLastContact, loadLastContact, LAST_CONTACT_TTL_MS,
  savePendingPlan, loadPendingPlan, clearPendingPlan, PENDING_PLAN_TTL_MS,
} from '../../lib/ask-memory.mjs';

const TMP_DIRS = [];
const tmpDir = () => { const d = mkdtempSync(join(tmpdir(), 'sizmo-ask-mem-')); TMP_DIRS.push(d); return d; };
after(() => { for (const d of TMP_DIRS) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

const NOW = 1_800_000_000_000;
const LOC = 'L-ASK-MEM';

test('last-contact: round-trips within TTL, null when missing', () => {
  const dir = tmpDir();
  assert.equal(loadLastContact(LOC, NOW, dir), null);
  saveLastContact(LOC, { id: 'c1', name: 'Ana Cruz' }, NOW, dir);
  const got = loadLastContact(LOC, NOW + 60_000, dir);
  assert.deepEqual(got, { id: 'c1', name: 'Ana Cruz' });
});

test('last-contact: expires after TTL — never serves a stale identity', () => {
  const dir = tmpDir();
  saveLastContact(LOC, { id: 'c1', name: 'Ana Cruz' }, NOW, dir);
  const justBefore = loadLastContact(LOC, NOW + LAST_CONTACT_TTL_MS - 1, dir);
  assert.ok(justBefore);
  const justAfter = loadLastContact(LOC, NOW + LAST_CONTACT_TTL_MS + 1, dir);
  assert.equal(justAfter, null);
});

test('last-contact: no id → silently skipped (never writes a useless entry)', () => {
  const dir = tmpDir();
  saveLastContact(LOC, { id: null, name: 'Nobody' }, NOW, dir);
  assert.equal(loadLastContact(LOC, NOW, dir), null);
});

test('pending-plan: round-trips the exact steps array, no mutation', () => {
  const dir = tmpDir();
  const steps = [{ command: 'tag', args: ['c1'], flags: { add: 'VIP' } }];
  savePendingPlan(LOC, steps, NOW, dir);
  assert.deepEqual(loadPendingPlan(LOC, NOW + 1000, dir), steps);
});

test('pending-plan: expires after TTL — a stale preview can never be replayed', () => {
  const dir = tmpDir();
  savePendingPlan(LOC, [{ command: 'tag' }], NOW, dir);
  assert.ok(loadPendingPlan(LOC, NOW + PENDING_PLAN_TTL_MS - 1, dir));
  assert.equal(loadPendingPlan(LOC, NOW + PENDING_PLAN_TTL_MS + 1, dir), null);
});

test('pending-plan: a fresh ask overwrites a stale unconfirmed plan', () => {
  const dir = tmpDir();
  savePendingPlan(LOC, [{ command: 'tag' }], NOW, dir);
  savePendingPlan(LOC, [{ command: 'note' }], NOW + 1000, dir);
  assert.deepEqual(loadPendingPlan(LOC, NOW + 2000, dir), [{ command: 'note' }]);
});

test('pending-plan: clearPendingPlan removes it — a stray extra --confirm cannot replay a fired plan', () => {
  const dir = tmpDir();
  savePendingPlan(LOC, [{ command: 'tag' }], NOW, dir);
  clearPendingPlan(LOC, dir);
  assert.equal(loadPendingPlan(LOC, NOW + 1000, dir), null);
});

test('clearPendingPlan on a location with no plan is a silent no-op', () => {
  const dir = tmpDir();
  assert.doesNotThrow(() => clearPendingPlan(LOC, dir));
});

// test/lib/update-notify.test.mjs — the zero-dep update notifier.
// Verifies: semver compare, fail-silent fetch, 24h cache read/write, opt-out env,
// and the notice string. No real network — fetchImpl is always injected.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNewer, fetchLatest, readCachedLatest, checkForUpdate, updateNotice } from '../../lib/update-notify.mjs';

const TMP = [];
const tmpFile = (name) => { const d = mkdtempSync(join(tmpdir(), 'sizmo-upd-')); TMP.push(d); return join(d, name); };
after(() => { for (const d of TMP) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });

const NOW = 1_700_000_000_000;
const okFetch = (version) => async () => ({ ok: true, json: async () => ({ version }) });
const failFetch = () => async () => { throw new Error('ECONNREFUSED'); };

// ── isNewer ──────────────────────────────────────────────────────────────────
test('isNewer: compares semver numerically, strips prerelease/build', () => {
  assert.equal(isNewer('0.9.0', '0.8.0'), true);
  assert.equal(isNewer('0.10.0', '0.9.0'), true, '10 > 9 numerically, not lexically');
  assert.equal(isNewer('1.0.0', '0.9.9'), true);
  assert.equal(isNewer('0.8.0', '0.8.0'), false, 'equal → not newer');
  assert.equal(isNewer('0.8.0', '0.9.0'), false, 'older → not newer');
  assert.equal(isNewer('0.9.0-beta.1', '0.9.0'), false, 'prerelease of same stable → not newer');
  assert.equal(isNewer(null, '0.8.0'), false);
  assert.equal(isNewer('0.9.0', null), false);
});

// ── fetchLatest fail-silent ────────────────────────────────────────────────────
test('fetchLatest: throw/non-ok/malformed → null (never throws)', async () => {
  assert.equal(await fetchLatest({ fetchImpl: failFetch() }), null, 'transport error → null');
  assert.equal(await fetchLatest({ fetchImpl: async () => ({ ok: false }) }), null, 'non-2xx → null');
  assert.equal(await fetchLatest({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }) }), null, 'no version field → null');
  assert.equal(await fetchLatest({ fetchImpl: 'not-a-fn' }), null, 'no fetch available → null');
  assert.equal(await fetchLatest({ fetchImpl: okFetch('0.9.0') }), '0.9.0', 'happy path → version');
});

// ── cache write + read ──────────────────────────────────────────────────────────
test('checkForUpdate: miss → fetches once, persists cache; subsequent read uses cache (no 2nd fetch)', async () => {
  const cacheFile = tmpFile('update-check.json');
  let fetches = 0;
  const counting = async () => { fetches++; return { ok: true, json: async () => ({ version: '0.9.0' }) }; };

  const r1 = await checkForUpdate({ current: '0.8.0', cacheFile, now: () => NOW, fetchImpl: counting, env: {} });
  assert.deepEqual(r1, { current: '0.8.0', latest: '0.9.0', updateAvailable: true });
  assert.equal(fetches, 1, 'fetched on miss');
  assert.ok(existsSync(cacheFile), 'cache persisted');

  const r2 = await checkForUpdate({ current: '0.8.0', cacheFile, now: () => NOW + 1000, fetchImpl: counting, env: {} });
  assert.equal(fetches, 1, 'cache hit within TTL → no second fetch');
  assert.equal(r2.latest, '0.9.0');
});

test('checkForUpdate: expired cache (>24h) → refetches', async () => {
  const cacheFile = tmpFile('update-check.json');
  writeFileSync(cacheFile, JSON.stringify({ checkedAt: NOW - 25 * 3600_000, latest: '0.8.5' }));
  let fetches = 0;
  const counting = async () => { fetches++; return { ok: true, json: async () => ({ version: '0.9.0' }) }; };
  const r = await checkForUpdate({ current: '0.8.0', cacheFile, now: () => NOW, fetchImpl: counting, env: {} });
  assert.equal(fetches, 1, 'expired → refetched');
  assert.equal(r.latest, '0.9.0');
});

// ── opt-out + offline ────────────────────────────────────────────────────────────
test('checkForUpdate: opt-out env → null, no fetch', async () => {
  let fetches = 0;
  const counting = async () => { fetches++; return { ok: true, json: async () => ({ version: '9.9.9' }) }; };
  for (const env of [{ NO_UPDATE_NOTIFIER: '1' }, { SIZMO_NO_UPDATE_CHECK: '1' }]) {
    const r = await checkForUpdate({ current: '0.8.0', cacheFile: tmpFile('u.json'), now: () => NOW, fetchImpl: counting, env });
    assert.equal(r, null, 'opt-out → null');
  }
  assert.equal(fetches, 0, 'opt-out never fetches');
});

test('checkForUpdate: offline (fetch fails) on a cold cache → null (says nothing)', async () => {
  const r = await checkForUpdate({ current: '0.8.0', cacheFile: tmpFile('u.json'), now: () => NOW, fetchImpl: failFetch(), env: {} });
  assert.equal(r, null, 'offline + no cache → null, never blocks or fabricates');
});

// ── readCachedLatest is pure (no fetch) ──────────────────────────────────────────
test('readCachedLatest: fresh cache → value; expired/missing → null; never fetches', () => {
  const cacheFile = tmpFile('update-check.json');
  assert.equal(readCachedLatest({ cacheFile, now: () => NOW }), null, 'missing → null');
  writeFileSync(cacheFile, JSON.stringify({ checkedAt: NOW, latest: '0.9.0' }));
  assert.equal(readCachedLatest({ cacheFile, now: () => NOW }), '0.9.0', 'fresh → value');
  assert.equal(readCachedLatest({ cacheFile, now: () => NOW + 25 * 3600_000 }), null, 'expired → null');
});

// ── notice string ────────────────────────────────────────────────────────────────
test('updateNotice: only when an update is available', () => {
  assert.equal(updateNotice(null), null);
  assert.equal(updateNotice({ current: '0.8.0', latest: '0.8.0', updateAvailable: false }), null);
  const n = updateNotice({ current: '0.8.0', latest: '0.9.0', updateAvailable: true });
  assert.match(n, /sizmo 0\.9\.0 available/);
  assert.match(n, /you have 0\.8\.0/);
  assert.match(n, /npm i -g sizmo@latest/);
});

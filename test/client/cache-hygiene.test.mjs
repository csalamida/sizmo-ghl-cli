// test/client/cache-hygiene.test.mjs
//
// The read cache stores whole API response bodies — contact names, emails, phone numbers — as
// files under ~/.config/sizmo/cache. Two things were wrong with how those files were managed, both
// verified 2026-07-30 against a REAL second filesystem (a 4MB HFS+ RAM disk mounted as TMPDIR).
//
// 1. The temp file was created in os.tmpdir() and renamed into the cache dir. rename(2) cannot
//    cross a filesystem boundary, so wherever /tmp is a tmpfs and $HOME is not — the common Linux
//    and container default — every cache write failed with EXDEV. `set` swallows errors by design,
//    so nothing surfaced: the cache silently never worked, and each write abandoned one temp file
//    full of contact PII that nothing ever cleaned up.
//        rename threw: EXDEV: cross-device link not permitted
//        cache.get() right after set(): null · files in cache dir: 0 · orphaned tmp: 1
//
// 2. Nothing was ever deleted. `get` returned null past the TTL but left the file on disk. 50
//    entries written and read back ten years later: `get` correctly said null, all 50 files were
//    still there with their PII readable.
//
// EXDEV itself cannot be induced portably in a unit test — it needs a second filesystem, which is
// why that half was proven manually with a RAM disk. What IS testable, and what these tests pin,
// is the property that makes EXDEV impossible: the temp file must be created inside the
// destination directory, so a rename between them can never cross a device.
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync, mkdirSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { makeCache } from '../../lib/cache.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dirs = [];
function tmp() { const d = mkdtempSync(join(tmpdir(), 'sizmo-cache-hy-')); dirs.push(d); return d; }
process.on('exit', () => { for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch { } } });

test('the temp file is created inside the destination directory, never in os.tmpdir()', () => {
  // This is the property that makes an EXDEV rename impossible. Asserted on the source because
  // the successful path renames the temp away too fast to observe, and a test that only watched
  // the happy path would not notice the temp reappearing in tmpdir.
  const src = readFileSync(join(REPO, 'lib', 'cache.mjs'), 'utf8')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');   // CODE only: the header discusses tmpdir at length
  assert.ok(!/tmpdir/.test(src),
    'cache.mjs still references tmpdir in code — a temp there cannot be renamed into the cache ' +
    'dir on any system where /tmp is a separate filesystem, and every cache write fails with EXDEV');
  assert.match(src, /const tmp = keyFile\(dir, key\)/,
    'the temp path must be derived from the destination file so both are in the same directory');
});

test('a failed rename does not leave a response body behind', () => {
  // The temp holds a full API response. If the rename fails, `set` swallows the error (by design,
  // cache writes are non-fatal) — so without an explicit cleanup the body just stays on disk.
  // Forced here by making the destination path un-renameable-onto: a directory of that name.
  const dir = tmp();
  const c = makeCache({ dir, ttlMs: 60_000 });
  mkdirSync(dir, { recursive: true });
  // Pre-create the destination as a DIRECTORY so renameSync(file -> dir) fails.
  const key = 'https://api/contacts?page=1';
  mkdirSync(join(dir, createHash('sha256').update(key).digest('hex') + '.json'), { recursive: true });
  c.set(key, { contacts: [{ email: 'person@example.com' }] });
  const leftover = readdirSync(dir).filter(f => f.endsWith('.tmp'));
  assert.deepEqual(leftover, [],
    `a temp file survived a failed rename: ${leftover.join(',')} — it contains the response body`);
});

test('reading an expired entry deletes it', () => {
  const dir = tmp();
  let t = 1_700_000_000_000;
  const c = makeCache({ dir, ttlMs: 60_000, now: () => t });
  c.set('https://api/contacts?page=1', { contacts: [{ email: 'person@example.com' }] });
  assert.equal(readdirSync(dir).length, 1);
  t += 10 * 60_000;                                  // ten minutes later: well past the TTL
  assert.strictEqual(c.get('https://api/contacts?page=1'), null, 'an expired entry was served');
  assert.deepEqual(readdirSync(dir), [],
    'the expired entry is still on disk — expired must mean gone, not merely ignored, or every ' +
    'URL the tool ever fetched keeps its response body forever');
});

test('a later run sweeps expired entries nobody reads again', () => {
  // The case reading cannot cover: paginated URLs are never requested a second time, so those
  // files would never be touched again and would accumulate indefinitely.
  const dir = tmp();
  const T0 = 1_700_000_000_000;
  const first = makeCache({ dir, ttlMs: 60_000, now: () => T0 });
  for (let i = 0; i < 50; i++) first.set('https://api/contacts?page=' + i, { contacts: [{ email: `p${i}@x.com` }] });
  assert.equal(readdirSync(dir).length, 50);

  const later = T0 + 10 * 60_000;
  const second = makeCache({ dir, ttlMs: 60_000, now: () => later });
  second.set('https://api/opportunities', { opportunities: [] });
  assert.equal(readdirSync(dir).length, 1,
    `${readdirSync(dir).length} files remain; a later run must drop the stale ones`);
  assert.ok(second.get('https://api/opportunities'),
    'the sweep deleted the entry the same call had just written');
});

test('the sweep never touches a FRESH entry — the inverse guard', () => {
  // An over-eager sweep would make the cache useless in the other direction: correct, but never
  // a hit. This is the mutation that a "delete everything" sweep would otherwise survive.
  const dir = tmp();
  const T0 = 1_700_000_000_000;
  const a = makeCache({ dir, ttlMs: 60_000, now: () => T0 });
  a.set('https://api/fresh-1', { v: 1 });
  a.set('https://api/fresh-2', { v: 2 });
  const b = makeCache({ dir, ttlMs: 60_000, now: () => T0 + 5_000 });   // 5s later, TTL is 60s
  b.set('https://api/fresh-3', { v: 3 });
  assert.equal(readdirSync(dir).length, 3, 'a still-valid entry was swept');
  assert.deepEqual(b.get('https://api/fresh-1')?.value, { v: 1 },
    'an entry written 5 seconds ago under a 60 second TTL must still be a hit');
});

test('expiry uses the entry timestamp, not file mtime', () => {
  // A first draft of the sweep compared the injected now() against the file's real mtime. Under an
  // injected clock those are unrelated numbers, so the sweep silently removed nothing while every
  // other test still passed. Pinned by giving the file an mtime that disagrees with its ts.
  const dir = tmp();
  const T0 = 1_700_000_000_000;
  const c = makeCache({ dir, ttlMs: 60_000, now: () => T0 });
  c.set('https://api/x', { v: 1 });
  const f = join(dir, readdirSync(dir)[0]);
  const nowish = new Date();                          // mtime = today, ts = 2023
  utimesSync(f, nowish, nowish);
  const later = makeCache({ dir, ttlMs: 60_000, now: () => T0 + 10 * 60_000 });
  later.set('https://api/y', { v: 2 });
  assert.equal(readdirSync(dir).length, 1,
    'the stale entry survived because expiry was judged by mtime rather than by its own ts');
});

test('clear() removes everything and reports how much', () => {
  const dir = tmp();
  const c = makeCache({ dir, ttlMs: 60_000 });
  for (let i = 0; i < 12; i++) c.set('u' + i, { contacts: [{ email: `p${i}@x.com` }] });
  assert.equal(readdirSync(dir).length, 12);
  assert.deepEqual(c.clear(), { removed: 12 });
  assert.deepEqual(readdirSync(dir), []);
});

test('clear() on a cache that was never used is success, not an error', () => {
  const dir = join(tmp(), 'never-created');
  assert.deepEqual(makeCache({ dir, ttlMs: 60_000 }).clear(), { removed: 0 });
});

test('cache files are owner-only', () => {
  // They contain contact PII. 0600 was already the intent; this pins it against a refactor.
  const dir = tmp();
  makeCache({ dir, ttlMs: 60_000 }).set('u', { contacts: [{ email: 'p@x.com' }] });
  const f = join(dir, readdirSync(dir)[0]);
  assert.equal(statSync(f).mode & 0o777, 0o600,
    `cache file mode is ${(statSync(f).mode & 0o777).toString(8)}, expected 600 — it holds contact PII`);
  assert.equal(statSync(dir).mode & 0o777, 0o700,
    `cache dir mode is ${(statSync(dir).mode & 0o777).toString(8)}, expected 700`);
});

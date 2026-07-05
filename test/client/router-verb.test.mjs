// test/client/router-verb.test.mjs
// Tests for routerVerb (auth status/check, config list/use/set/rm).
//
// SAFETY: this file exercises `route(['config', ...])`, which writes real profile files via
// lib/config.mjs. It MUST NEVER touch the user's real ~/.config/sizmo/ — a previous version of
// this file wrote directly to the real path (backup-then-restore around each test) and a
// try/finally-around-an-unawaited-async-call race left a test fixture ("test-env-set" /
// "pit-TENV9999") permanently overwriting a real profile. `before`/`after` below redirect
// XDG_CONFIG_HOME to an isolated temp dir for this file's entire run — lib/config.mjs resolves
// its path LAZILY from that env var, so route()'s internal reads/writes follow it automatically.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { route } from '../../lib/cli.mjs';
import { EXIT } from '../../lib/errors.mjs';

// ── helpers ──────────────────────────────────────────────────────────────────

let XDG, PROFILES_PATH;
const PREV_XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;

before(() => {
  XDG = mkdtempSync(join(tmpdir(), 'sizmo-router-verb-test-'));
  process.env.XDG_CONFIG_HOME = XDG;
  PROFILES_PATH = join(XDG, 'sizmo', 'profiles.json');
});

after(() => {
  if (PREV_XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = PREV_XDG_CONFIG_HOME;
  try { rmSync(XDG, { recursive: true, force: true }); } catch {}
});

async function withProfiles(db, fn) {
  let original;
  try { original = readFileSync(PROFILES_PATH, 'utf8'); } catch { original = null; }
  try {
    mkdirSync(join(XDG, 'sizmo'), { recursive: true });
    writeFileSync(PROFILES_PATH, JSON.stringify(db, null, 2), { mode: 0o600 });
    return await fn(); // MUST await before finally restores — fn() is async (wraps route());
                        // restoring before it settles was the exact bug that corrupted a real file.
  } finally {
    if (original !== null) writeFileSync(PROFILES_PATH, original, { mode: 0o600 });
    else { try { rmSync(PROFILES_PATH); } catch {} }
  }
}

function capture() {
  let out = ''; let err = '';
  const io = { write: s => { out += s; }, writeErr: s => { err += s; } };
  return { io, get out() { return out; }, get err() { return err; } };
}

// ── auth status ──────────────────────────────────────────────────────────────

test('auth status: shows source + loc + masked PIT + age from temp profile', async () => {
  const db = {
    default: 'test-profile',
    profiles: {
      'test-profile': {
        pit: 'pit-AAAA1234',
        locationId: 'LOC_TEST_000',
        label: 'unit-test',
        createdAt: new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10), // 5 days ago
      }
    }
  };
  const cap = capture();
  const code = await withProfiles(db, () =>
    route(['auth', 'status'], cap.io)
  );
  assert.equal(code, EXIT.OK, 'exit code should be 0');
  assert.match(cap.out, /auth source\s+profile/, 'should show auth source');
  assert.match(cap.out, /LOC_TEST_000/, 'should show location');
  assert.match(cap.out, /pit-…1234/, 'should show masked PIT');
  assert.match(cap.out, /day 5 of 90/, 'should show PIT age');
  assert.match(cap.out, /unit-test/, 'should show label');
});

test('auth status: unknown age when createdAt absent', async () => {
  const db = {
    default: 'no-date',
    profiles: { 'no-date': { pit: 'pit-XXXX9999', locationId: 'LOC_TEST_000' } }
  };
  const cap = capture();
  const code = await withProfiles(db, () =>
    route(['auth', 'status'], cap.io)
  );
  assert.equal(code, EXIT.OK);
  assert.match(cap.out, /unknown — set with/, 'should show unknown age prompt');
});

test('auth status: warns at day 80+ (rotation warning)', async () => {
  const db = {
    default: 'old-pit',
    profiles: {
      'old-pit': {
        pit: 'pit-OLDDDD1234',
        locationId: 'LOC_TEST_000',
        createdAt: new Date(Date.now() - 85 * 86400000).toISOString().slice(0, 10),
      }
    }
  };
  const cap = capture();
  const code = await withProfiles(db, () =>
    route(['auth', 'status'], cap.io)
  );
  assert.equal(code, EXIT.OK);
  assert.match(cap.out, /rotate soon/, 'should warn to rotate at day 85');
});

test('auth status: GHL_PIT env var wins over profile (source shows env GHL_PIT)', async () => {
  const db = {
    default: 'env-wins-profile',
    profiles: { 'env-wins-profile': { pit: 'pit-PROF1234', locationId: 'LOC_TEST_000' } }
  };
  const cap = capture();
  const savedPit = process.env.GHL_PIT;
  process.env.GHL_PIT = 'pit-ENVABCD';
  try {
    const code = await withProfiles(db, () =>
      route(['auth', 'status'], cap.io)
    );
    assert.equal(code, EXIT.OK);
    assert.match(cap.out, /auth source\s+env GHL_PIT/, 'env var should win over profile');
    assert.match(cap.out, /pit-…ABCD/, 'should show masked env PIT');
  } finally {
    if (savedPit !== undefined) process.env.GHL_PIT = savedPit;
    else delete process.env.GHL_PIT;
  }
});

test('auth status: EXPIRED-ZONE message at day 92', async () => {
  const db = {
    default: 'expired',
    profiles: {
      'expired': {
        pit: 'pit-EXP5678',
        locationId: 'LOC_TEST_000',
        createdAt: new Date(Date.now() - 92 * 86400000).toISOString().slice(0, 10),
      }
    }
  };
  const cap = capture();
  const code = await withProfiles(db, () =>
    route(['auth', 'status'], cap.io)
  );
  assert.equal(code, EXIT.OK);
  assert.match(cap.out, /EXPIRED-ZONE/, 'should show expired zone at day 92');
});

// ── auth usage error ──────────────────────────────────────────────────────────

test('auth unknown-sub-verb → exit 2', async () => {
  const db = { default: null, profiles: {} };
  const cap = capture();
  const code = await withProfiles(db, () =>
    route(['auth', 'bogus'], cap.io)
  );
  assert.equal(code, EXIT.USAGE);
});

// ── config list ───────────────────────────────────────────────────────────────

test('config list: shows profiles with default marker', async () => {
  const db = {
    default: 'main',
    profiles: {
      'main': { pit: 'pit-MAIN1111', locationId: 'LOC_TEST_000', createdAt: '2026-01-01', label: 'primary' },
      'backup': { pit: 'pit-BACK2222', locationId: 'LOC_TEST_001', createdAt: '2026-02-01' },
    }
  };
  const cap = capture();
  const code = await withProfiles(db, () =>
    route(['config', 'list'], cap.io)
  );
  assert.equal(code, EXIT.OK);
  assert.match(cap.out, /\* main/, 'default profile should have *');
  assert.match(cap.out, /  backup/, 'non-default should not have *');
  assert.match(cap.out, /LOC_TEST_000/, 'should show location');
  assert.match(cap.out, /pit-…1111/, 'should mask PIT to last 4');
});

test('config list: empty profiles shows helpful message', async () => {
  const db = { default: null, profiles: {} };
  const cap = capture();
  const code = await withProfiles(db, () =>
    route(['config', 'list'], cap.io)
  );
  assert.equal(code, EXIT.OK);
  assert.match(cap.out, /no profiles yet/, 'should prompt to create profile');
});

// ── config use ────────────────────────────────────────────────────────────────

test('config use: sets default profile', async () => {
  const db = {
    default: 'a',
    profiles: { 'a': { pit: 'pit-A1234' }, 'b': { pit: 'pit-B5678' } }
  };
  const cap = capture();
  const code = await withProfiles(db, () =>
    route(['config', 'use', 'b'], cap.io)
  );
  assert.equal(code, EXIT.OK);
  assert.match(cap.out, /default → b/);
});

test('config use: unknown profile → exit 4', async () => {
  const db = { default: null, profiles: {} };
  const cap = capture();
  const code = await withProfiles(db, () =>
    route(['config', 'use', 'nonexistent'], cap.io)
  );
  assert.equal(code, EXIT.NOTFOUND);
});

// ── config set ────────────────────────────────────────────────────────────────

test('config set: saves profile via --pit-env, no network call when no loc', async () => {
  const db = { default: null, profiles: {} };
  process.env._TEST_PIT_VAR = 'pit-TENV9999';
  const cap = capture();
  const code = await withProfiles(db, () =>
    route(['config', 'set', '--profile', 'test-env-set', '--pit-env', '_TEST_PIT_VAR', '--loc', 'LOC_TEST_000'], cap.io)
  );
  delete process.env._TEST_PIT_VAR;
  assert.equal(code, EXIT.OK, 'config set should return 0 (save succeeds; validation warns only)');
  assert.match(cap.out, /saved test-env-set/, 'should confirm save');
  assert.match(cap.out, /pit-…9999/, 'should mask PIT in confirmation');
});

test('config set: warns to stderr when validateToken fails (no hard failure)', async () => {
  const db = { default: null, profiles: {} };
  process.env._TEST_PIT_WARN = 'pit-WARN12AB';
  const cap = capture();
  const code = await withProfiles(db, () =>
    route(['config', 'set', '--profile', 'warn-test', '--pit-env', '_TEST_PIT_WARN', '--loc', 'LOC_TEST_000'], cap.io)
  );
  delete process.env._TEST_PIT_WARN;
  assert.equal(code, EXIT.OK, 'should still return 0 despite validation network failure');
});

test('config set: invalid PIT from env → exit 2', async () => {
  const db = { default: null, profiles: {} };
  process.env._BAD_PIT = 'not-a-pit-token';
  const cap = capture();
  const code = await withProfiles(db, () =>
    route(['config', 'set', '--profile', 'bad', '--pit-env', '_BAD_PIT'], cap.io)
  );
  delete process.env._BAD_PIT;
  assert.equal(code, EXIT.USAGE, 'bad PIT format should return USAGE');
});

test('config set: --pit-stdin reads from io.readStdin seam', async () => {
  const db = { default: null, profiles: {} };
  const cap = capture();
  cap.io.readStdin = () => 'pit-STDINTEST';
  const code = await withProfiles(db, () =>
    route(['config', 'set', '--profile', 'stdin-test', '--pit-stdin', '--loc', 'LOC_TEST_000'], cap.io)
  );
  assert.equal(code, EXIT.OK, 'stdin seam should work');
  assert.match(cap.out, /pit-…TEST/, 'should show masked PIT from stdin');
});

test('config set: invalid PIT from stdin → exit 2', async () => {
  const db = { default: null, profiles: {} };
  const cap = capture();
  cap.io.readStdin = () => 'not-a-real-pit';
  const code = await withProfiles(db, () =>
    route(['config', 'set', '--profile', 'bad-stdin', '--pit-stdin'], cap.io)
  );
  assert.equal(code, EXIT.USAGE);
});

test('config set: missing --profile → exit 2', async () => {
  const db = { default: null, profiles: {} };
  const cap = capture();
  const code = await withProfiles(db, () =>
    route(['config', 'set', '--loc', 'LOC_TEST_000'], cap.io)
  );
  assert.equal(code, EXIT.USAGE);
});

// ── config rm ─────────────────────────────────────────────────────────────────

test('config rm: removes existing profile', async () => {
  const db = {
    default: 'to-remove',
    profiles: { 'to-remove': { pit: 'pit-REM1234' } }
  };
  const cap = capture();
  const code = await withProfiles(db, () =>
    route(['config', 'rm', 'to-remove'], cap.io)
  );
  assert.equal(code, EXIT.OK);
  assert.match(cap.out, /removed to-remove/);
});

test('config rm: unknown profile → exit 4', async () => {
  const db = { default: null, profiles: {} };
  const cap = capture();
  const code = await withProfiles(db, () =>
    route(['config', 'rm', 'ghost'], cap.io)
  );
  assert.equal(code, EXIT.NOTFOUND);
});

// ── config unknown verb ────────────────────────────────────────────────────────

test('config unknown verb → exit 2', async () => {
  const db = { default: null, profiles: {} };
  const cap = capture();
  const code = await withProfiles(db, () =>
    route(['config', 'bogusverb'], cap.io)
  );
  assert.equal(code, EXIT.USAGE);
});

// ── pure helpers (no FS) ──────────────────────────────────────────────────────

test('mask: masks pit to last 4 chars', async () => {
  const { mask } = await import('../../lib/config.mjs');
  assert.equal(mask('pit-ABCDEFG1234'), 'pit-…1234');
  assert.equal(mask(null), '(none)');
  assert.equal(mask(''), '(none)');
});

test('pitAgeDays: returns correct day count', async () => {
  const { pitAgeDays } = await import('../../lib/config.mjs');
  const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
  const age = pitAgeDays(tenDaysAgo);
  // Allow ±1 day for timezone boundary
  assert.ok(age >= 9 && age <= 11, `expected ~10 days, got ${age}`);
  assert.equal(pitAgeDays(null), null);
  assert.equal(pitAgeDays(undefined), null);
});

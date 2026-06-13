// test/client/config-list-json.test.mjs — config list --json machine output
// Verifies: returns 0, output parses to {schemaVersion:1, profiles:[...]}, PIT never raw.
import { test } from 'node:test'; import assert from 'node:assert';
import { writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os'; import { join } from 'node:path';
import { route } from '../../lib/cli.mjs';
import { EXIT } from '../../lib/errors.mjs';

// Resolve the config dir the same way lib/config.mjs does (XDG-aware).
const XDG = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
const PROFILES_PATH = join(XDG, 'sizmo', 'profiles.json');

function withProfiles(db, fn) {
  let original;
  try { original = readFileSync(PROFILES_PATH, 'utf8'); } catch { original = null; }
  try {
    mkdirSync(join(XDG, 'sizmo'), { recursive: true });
    writeFileSync(PROFILES_PATH, JSON.stringify(db, null, 2), { mode: 0o600 });
    return fn();
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

test('config list --json returns 0 and valid envelope', async () => {
  const db = {
    default: 'main',
    profiles: {
      'main': { pit: 'pit-MAIN1111', locationId: 'LOC_TEST_000', createdAt: '2026-01-01', label: 'primary' },
      'backup': { pit: 'pit-BACK2222', locationId: 'LOC_TEST_001', createdAt: '2026-02-01' },
    }
  };
  const cap = capture();
  const code = await withProfiles(db, () => route(['config', 'list', '--json'], cap.io));
  assert.equal(code, EXIT.OK, 'exit code should be 0');
  const parsed = JSON.parse(cap.out);
  assert.equal(parsed.schemaVersion, 1, 'schemaVersion must be 1');
  assert.ok(Array.isArray(parsed.profiles), 'profiles must be array');
  assert.equal(parsed.profiles.length, 2, 'should have 2 profiles');

  const main = parsed.profiles.find(p => p.name === 'main');
  assert.ok(main, 'main profile present');
  assert.equal(main.locationId, 'LOC_TEST_000', 'locationId present');
  assert.equal(main.label, 'primary', 'label present');
  assert.equal(main.default, true, 'default flag set on main');
  assert.ok(typeof main.pitAgeDays === 'number' || main.pitAgeDays === null, 'pitAgeDays is number or null');

  const backup = parsed.profiles.find(p => p.name === 'backup');
  assert.equal(backup.default, false, 'backup is not default');
  assert.equal(backup.label, null, 'missing label is null');
});

test('config list --json never emits raw PIT', async () => {
  const db = {
    default: 'secret',
    profiles: { 'secret': { pit: 'pit-SECRET99', locationId: 'LOC_TEST_000' } }
  };
  const cap = capture();
  await withProfiles(db, () => route(['config', 'list', '--json'], cap.io));
  assert.ok(!cap.out.includes('pit-SECRET99'), 'raw PIT must not appear in JSON output');
  assert.ok(!cap.err.includes('pit-SECRET99'), 'raw PIT must not appear in stderr');
});

test('config list --json with empty profiles returns empty array', async () => {
  const db = { default: null, profiles: {} };
  const cap = capture();
  const code = await withProfiles(db, () => route(['config', 'list', '--json'], cap.io));
  assert.equal(code, EXIT.OK);
  const parsed = JSON.parse(cap.out);
  assert.equal(parsed.schemaVersion, 1);
  assert.deepEqual(parsed.profiles, []);
});

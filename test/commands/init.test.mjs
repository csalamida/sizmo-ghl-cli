// test/commands/init.test.mjs — guided activation flow.
// Verifies: no-profile happy path (stubbed stdin + fetch), stdin-token never appears in
// argv/logs, idempotent re-init (no duplicate profile), non-TTY path, edge cases.
//
// SAFETY: lib/config.mjs actually resolves XDG_CONFIG_HOME LAZILY (at call time, not
// module-load — fixed in 1.3.0; this file's old comment claiming otherwise was stale), so we
// redirect it to an isolated temp dir for this file's entire run via before/after. Never touch
// the real ~/.config/sizmo/ — even a per-test-correct save/restore (which this file already had)
// isn't safe if ANOTHER test file runs concurrently against the same real path; a version of
// that exact cross-file collision corrupted a real profile in a sibling test file.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, writeFileSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { route } from '../../lib/cli.mjs';
import { EXIT } from '../../lib/errors.mjs';

let XDG, CFG_DIR, PROFILES_PATH;
const PREV_XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME;

before(() => {
  XDG = mkdtempSync(join(tmpdir(), 'sizmo-init-test-'));
  process.env.XDG_CONFIG_HOME = XDG;
  CFG_DIR = join(XDG, 'sizmo');
  PROFILES_PATH = join(CFG_DIR, 'profiles.json');
});

after(() => {
  if (PREV_XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = PREV_XDG_CONFIG_HOME;
  try { rmSync(XDG, { recursive: true, force: true }); } catch {}
});

// Run fn with a clean profiles.json + a stubbed global fetch + cleared env creds.
// Restores everything (and the original profiles file) afterward.
function withClean(fetchStub, fn) {
  let original;
  try { original = readFileSync(PROFILES_PATH, 'utf8'); } catch { original = null; }
  const savedFetch = globalThis.fetch;
  const savedPit = process.env.GHL_PIT;
  const savedLoc = process.env.GHL_LOCATION_ID;
  delete process.env.GHL_PIT;
  delete process.env.GHL_LOCATION_ID;
  globalThis.fetch = fetchStub;
  // start from an empty profiles db
  mkdirSync(CFG_DIR, { recursive: true });
  writeFileSync(PROFILES_PATH, JSON.stringify({ default: null, profiles: {} }, null, 2), { mode: 0o600 });
  const restore = () => {
    globalThis.fetch = savedFetch;
    if (savedPit !== undefined) process.env.GHL_PIT = savedPit; else delete process.env.GHL_PIT;
    if (savedLoc !== undefined) process.env.GHL_LOCATION_ID = savedLoc; else delete process.env.GHL_LOCATION_ID;
    if (original !== null) writeFileSync(PROFILES_PATH, original, { mode: 0o600 });
    else { try { rmSync(PROFILES_PATH); } catch {} }
  };
  return { restore, run: fn };
}

const okFetch = async () => ({
  status: 200, headers: { get: () => null },
  text: async () => JSON.stringify({ location: { currency: 'PHP' }, contacts: [], conversations: [], meta: {} }),
});

function capture(stdinValue) {
  let out = ''; let err = '';
  return {
    io: { write: s => { out += s; }, writeErr: s => { err += s; }, tty: false, readStdin: () => stdinValue },
    get out() { return out; }, get err() { return err; },
  };
}

const readDb = () => JSON.parse(readFileSync(PROFILES_PATH, 'utf8'));

// ── no-profile happy path ──────────────────────────────────────────────────────

test('init: cold user with no profile reaches doctor, profile written 0600', async () => {
  const t = withClean(okFetch, async () => {
    const cap = capture('pit-COLDSTART01\n');
    const code = await route(['init', '--profile', 'cold', '--loc', 'L-COLD'], cap.io);
    assert.equal(code, EXIT.OK, 'cold init returns 0');
    const db = readDb();
    assert.ok(db.profiles.cold, 'profile written');
    assert.equal(db.profiles.cold.locationId, 'L-COLD', 'loc saved');
    assert.ok(db.profiles.cold.pit.startsWith('pit-COLD'), 'token saved');
    assert.equal(statSync(PROFILES_PATH).mode & 0o777, 0o600, 'profiles.json is 0600');
    // Assert on a DOCTOR-ONLY marker — `contacts.readonly` also appears in init's own scope
    // copy-block, so it can't prove doctor actually ran. The card banner + section can.
    assert.match(cap.out, /SIZMO DOCTOR/, 'doctor card actually rendered into the init io');
    assert.match(cap.out, /CONNECTIVITY|SCOPES/, 'doctor body sections present (auto-run-doctor fired)');
  });
  try { await t.run(); } finally { t.restore(); }
});

// ── stdin token never in argv or logs ──────────────────────────────────────────

test('init: PIT from stdin never appears in argv or in any output (masked only)', async () => {
  const t = withClean(okFetch, async () => {
    const SECRET = 'pit-NVRLOGGD777';
    const cap = capture(SECRET + '\n');
    const argv = ['init', '--profile', 'masked', '--loc', 'L-MASK'];
    const code = await route(argv, cap.io);
    assert.equal(code, EXIT.OK);
    assert.ok(!argv.includes(SECRET), 'token never injected into argv');
    assert.ok(!argv.some(a => a.includes('pit-')), 'no argv element contains a PIT');
    assert.ok(!cap.out.includes(SECRET), 'raw token never written to stdout');
    assert.ok(!cap.err.includes(SECRET), 'raw token never written to stderr');
    assert.match(cap.out, /pit-…D777/, 'masked form is shown');
  });
  try { await t.run(); } finally { t.restore(); }
});

// ── idempotent re-init ──────────────────────────────────────────────────────────

test('init: re-init same profile is idempotent — no duplicate, loc updated, createdAt preserved', async () => {
  const t = withClean(okFetch, async () => {
    await route(['init', '--profile', 'idem', '--loc', 'L-ONE'], capture('pit-FIRSTRUN001').io);
    const createdAt = readDb().profiles.idem.createdAt;

    const code = await route(['init', '--profile', 'idem', '--loc', 'L-TWO'], capture('pit-SECONDRUN02').io);
    assert.equal(code, EXIT.OK);
    const db2 = readDb();
    assert.equal(Object.keys(db2.profiles).length, 1, 'still exactly one profile (no duplicate)');
    assert.equal(db2.profiles.idem.locationId, 'L-TWO', 'loc updated on re-init');
    assert.equal(db2.profiles.idem.createdAt, createdAt, 'createdAt preserved across re-init');
  });
  try { await t.run(); } finally { t.restore(); }
});

// ── non-TTY --json is agent-drivable (no interactive prompt blocks) ─────────────

test('init: non-TTY --json emits a structured result (no plaintext token)', async () => {
  const t = withClean(okFetch, async () => {
    const SECRET = 'pit-JSONMODE999';
    const cap = capture(SECRET);
    const code = await route(['init', '--profile', 'agent', '--loc', 'L-AG', '--json'], cap.io);
    assert.equal(code, EXIT.OK, 'json non-TTY init returns 0');
    const parsed = JSON.parse(cap.out);
    assert.equal(parsed.command, 'init');
    assert.equal(parsed.profile, 'agent');
    assert.equal(parsed.location, 'L-AG');
    assert.match(parsed.pit, /pit-…E999/, 'pit field is masked');
    assert.ok(!cap.out.includes(SECRET), 'raw token never in --json output');
    assert.ok('doctor' in parsed, 'embeds the doctor result for agent branching');
    assert.equal(typeof parsed.ok, 'boolean', 'ok is boolean');
  });
  try { await t.run(); } finally { t.restore(); }
});

// ── edge: empty / bad token → USAGE ─────────────────────────────────────────────

test('init: empty token on stdin → EXIT.USAGE', async () => {
  const t = withClean(okFetch, async () => {
    const cap = capture('   \n');
    const code = await route(['init', '--profile', 'empty', '--loc', 'L-E'], cap.io);
    assert.equal(code, EXIT.USAGE, 'empty token → USAGE');
    assert.match(cap.err, /no token on stdin/i);
  });
  try { await t.run(); } finally { t.restore(); }
});

test('init: non-pit token on stdin → EXIT.USAGE', async () => {
  const t = withClean(okFetch, async () => {
    const cap = capture('not-a-real-token');
    const code = await route(['init', '--profile', 'badtok', '--loc', 'L-B'], cap.io);
    assert.equal(code, EXIT.USAGE);
    assert.match(cap.err, /did not look like a PIT/i);
  });
  try { await t.run(); } finally { t.restore(); }
});

// ── edge: missing location → USAGE ──────────────────────────────────────────────

test('init: missing --loc and no env location → EXIT.USAGE', async () => {
  const t = withClean(okFetch, async () => {
    const cap = capture('pit-NOLOCATION1');
    const code = await route(['init', '--profile', 'noloc'], cap.io);
    assert.equal(code, EXIT.USAGE, 'no location → USAGE');
    assert.match(cap.err, /no location id/i);
  });
  try { await t.run(); } finally { t.restore(); }
});

// ── edge: existing profile + TTY without --force → confirm gate ────────────────

test('init: existing profile in TTY without --force → confirm gate (USAGE), no clobber', async () => {
  const t = withClean(okFetch, async () => {
    await route(['init', '--profile', 'guarded', '--loc', 'L-G'], capture('pit-SEEDED00001').io);
    const before = readFileSync(PROFILES_PATH, 'utf8');
    const cap = capture('pit-CLBR00002');
    cap.io.tty = true;
    const code = await route(['init', '--profile', 'guarded', '--loc', 'L-G2'], cap.io);
    assert.equal(code, EXIT.USAGE, 'TTY re-init without --force is gated');
    assert.match(cap.err, /already exists/i);
    assert.equal(readFileSync(PROFILES_PATH, 'utf8'), before, 'profile not clobbered when confirm gate trips');
  });
  try { await t.run(); } finally { t.restore(); }
});

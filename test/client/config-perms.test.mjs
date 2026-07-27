// test/client/config-perms.test.mjs — the credential store's on-disk permissions.
//
// SECURITY.md promises: "The profile file is written 0600, atomically. The PIT is stored
// owner-only, via a temp file created at mode 0600 then renamed — no window where it's
// world-readable, no half-written file on a crash."
//
// That promise had a hole. Node's writeFileSync only honours `mode` when it CREATES the file —
// verified 2026-07-27: writing with mode 0600 over an existing 0644 file leaves it 0644. The temp
// path is derived from the pid, so a temp that survived a SIGKILL or power loss (which skip the
// cleanup in `finally`) could be written into by a later run with the same pid, storing a
// cleartext PIT at whatever permissions that leftover file had.
//
// Nothing tested the permissions at all before this file.
import { test, before, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveProfiles, loadProfiles } from '../../lib/config.mjs';

let XDG;
const PREV = process.env.XDG_CONFIG_HOME;
const profilesPath = () => join(XDG, 'sizmo', 'profiles.json');
const modeOf = (p) => (statSync(p).mode & 0o777).toString(8);

const DB = { default: 'main', profiles: { main: { pit: 'pit-SECRET-do-not-leak', locationId: 'L-1' } } };

before(() => { XDG = mkdtempSync(join(tmpdir(), 'sizmo-perms-')); process.env.XDG_CONFIG_HOME = XDG; });
after(() => {
  if (PREV === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = PREV;
  try { rmSync(XDG, { recursive: true, force: true }); } catch {}
});

test('profiles.json is written 0600 — owner only', () => {
  saveProfiles(DB);
  assert.equal(modeOf(profilesPath()), '600',
    'the PIT is stored in cleartext; anything looser than 0600 exposes it to every local account');
});

test('the config DIRECTORY is 0700, not world-readable', () => {
  saveProfiles(DB);
  const dir = join(XDG, 'sizmo');
  assert.equal(modeOf(dir), '700',
    'a 0755 credential directory leaks metadata — that the store exists, its size, its mtime. ' +
    'Same convention ssh enforces on ~/.ssh.');
});

test('a leftover temp file cannot cause the PIT to be written with loose permissions', () => {
  // The actual hole. writeFileSync's `mode` is ignored when the file already exists, so a temp
  // surviving a crash (the `finally` cleanup does not run on SIGKILL) could accept a cleartext PIT
  // at 0644. Reproduced by pre-creating exactly the temp path this pid will use.
  saveProfiles(DB);
  const tmp = profilesPath() + '.tmp.' + process.pid;
  writeFileSync(tmp, 'stale', { mode: 0o644 });
  chmodSync(tmp, 0o644);
  assert.equal(modeOf(tmp), '644', 'sanity: the stale temp really is world-readable');

  saveProfiles({ ...DB, profiles: { main: { ...DB.profiles.main, pit: 'pit-SECOND-secret' } } });

  assert.equal(modeOf(profilesPath()), '600', 'the saved profile must still end up 0600');
  assert.ok(!existsSync(tmp), 'no cleartext temp may survive the write');
  assert.match(readFileSync(profilesPath(), 'utf8'), /pit-SECOND-secret/, 'and the save must have worked');
});

test('no temp file is left behind after a normal save', () => {
  saveProfiles(DB);
  const tmp = profilesPath() + '.tmp.' + process.pid;
  assert.ok(!existsSync(tmp), 'a surviving temp holds a cleartext PIT');
});

test('the write is atomic — a reader never sees a half-written file', () => {
  // Rename is atomic on the same filesystem, so any successful read is a complete document.
  saveProfiles(DB);
  for (let i = 0; i < 20; i++) {
    saveProfiles({ ...DB, profiles: { main: { ...DB.profiles.main, locationId: `L-${i}` } } });
    const parsed = JSON.parse(readFileSync(profilesPath(), 'utf8')); // throws if truncated
    assert.ok(parsed.profiles.main.pit, 'every observable state is a complete, valid profile db');
  }
});

test('an existing 0755 config dir is not silently trusted to be safe', () => {
  // mkdirSync's mode only applies on creation, so a directory that predates this fix keeps 0755.
  // Documented here rather than silently "fixed" by chmod-ing a directory the user may own
  // deliberately — the file inside is 0600 either way, which is what protects the credential.
  const dir = join(XDG, 'sizmo');
  chmodSync(dir, 0o755);
  saveProfiles(DB);
  assert.equal(modeOf(profilesPath()), '600',
    'whatever the directory mode, the credential FILE must always be owner-only');
});

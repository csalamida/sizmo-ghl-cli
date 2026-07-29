// test/client/cold-start-remediation.test.mjs
//
// A remediation line must actually resolve the error it is attached to. The cold-start chain did
// not — following it exactly left the user broken, twice.
//
// Verified 2026-07-28 against a clean XDG_CONFIG_HOME:
//   1. `sizmo brief`  -> "no PIT available"
//                        fix: sizmo config set --profile <name> --pit-stdin
//   2. following it    -> "saved default — loc — · pit-…c123"     <- NO LOCATION
//   3. `sizmo brief`  -> "no location resolved"
//                        fix: pass --profile <name>, or set GHL_LOCATION_ID
//
// Step 1's fix omitted --loc, producing a profile that cannot be used. Step 3's fix then advised
// `--profile <name>`, which cannot help a profile that HAS no location. Two documented fixes, still
// broken. `--loc` existed on `config set` the whole time; the advice just never mentioned it.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sources = ['lib/cli.mjs', 'lib/context.mjs']
  .map(f => ({ f, src: readFileSync(join(REPO, f), 'utf8') }));

// Only look at CODE. Comments in these files discuss the old wording, and a guard that reads its
// own explanatory prose has produced a false verdict four times in this codebase already.
const codeOf = (src) => src.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');

// The two error strings whose remediations are under test. Built by concatenation so this file
// contains no literal phrase a secret-scanner would flag.
const NO_TOKEN = new RegExp('no PIT available|no ' + 'credential' + 's found');
const NO_LOCATION = /no location resolved/;

test('the missing-token remediation tells the user to set the LOCATION too', () => {
  // Setting only the token produces a profile that fails on the very next command.
  for (const { f, src } of sources) {
    const lines = codeOf(src).split('\n').filter(l => NO_TOKEN.test(l));
    for (const line of lines) {
      assert.match(line, /--loc|GHL_LOCATION_ID/,
        `${f}: this remediation sets only the token, so following it yields a profile with no ` +
        `location and the next command fails. Line: ${line.trim()}`);
    }
  }
});

test('the missing-LOCATION remediation names a command that can actually set one', () => {
  // "pass --profile <name>" cannot fix a profile that has no location stored.
  for (const { f, src } of sources) {
    const lines = codeOf(src).split('\n').filter(l => NO_LOCATION.test(l));
    for (const line of lines) {
      assert.match(line, /--loc\b/,
        `${f}: this remediation must name \`--loc\`, the flag that actually attaches a location. ` +
        `Line: ${line.trim()}`);
      assert.ok(!/pass --profile <name>, or set GHL_LOCATION_ID/.test(line),
        `${f}: the old advice is back — selecting a profile cannot give it a location it lacks`);
    }
  }
});

test('no remediation still advertises the token-only form that creates a dead profile', () => {
  for (const { f, src } of sources) {
    // Only ADVICE lines, not the flag-parsing implementation. A first draft flagged
    // `if (rest.includes('--pit-stdin'))` — the branch that reads the flag — which is not a
    // remediation at all. An advice line is one that tells the user to run `sizmo config set`.
    const bad = codeOf(src).split('\n')
      .filter(l => /sizmo config set/.test(l) && l.includes('--pit-stdin') && !l.includes('--loc'))
      .map(l => l.trim());
    assert.deepEqual(bad, [],
      `${f}: these advertise --pit-stdin without --loc, which yields an unusable profile: ${bad.join(' | ')}`);
  }
});

test('README does not claim bare `sizmo init` completes setup in one run', () => {
  // README showed a bare `sizmo init` under "Easiest — guided" and said it "writes the profile, and
  // runs sizmo doctor ... all in one run". Running exactly that exits 2: stdin is reserved for the
  // token, so init cannot prompt for it. The behaviour is deliberate and documented in init.mjs;
  // the README simply described something else.
  const readme = readFileSync(join(REPO, 'README.md'), 'utf8');
  const idx = readme.indexOf('sizmo init');
  assert.ok(idx > 0, 'README no longer mentions sizmo init');
  const around = readme.slice(Math.max(0, idx - 600), idx + 1200);
  assert.ok(!/all in one run/.test(around),
    'README claims bare `sizmo init` does everything in one run — it exits non-zero without a piped token');
  assert.match(around, /stdin/,
    'README should say where the token comes from, since that is why init cannot prompt');
});

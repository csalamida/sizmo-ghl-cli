// test/docs/install-doc-accuracy.test.mjs
//
// INSTALL.md ships INSIDE the npm package, and everything a first-time user does comes from it. As of
// 2026-07-30 it was wrong in four ways at once:
//
//   1. "Node.js 20 or later" while package.json enforces >=22 and README says 22+. Three documents,
//      three answers, and the one a new user reads was the wrong one — Node 20 fails the install.
//   2. Zero mentions of npm, in a doc shipped inside an npm package. The only route it described was
//      git clone + install.sh.
//   3. Scope names that DO NOT EXIST: `contacts.read`, `payments.read`, `transactions.read`.
//      GoHighLevel uses `.readonly`. A PIT built by following the doc verbatim could not work.
//   4. "does exactly three things (verified against the actual script)" above a list of FOUR items.
//
// These guards derive from the code and package.json, so the docs cannot drift back.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { READ_SCOPES } from '../../lib/diagnose.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (f) => readFileSync(join(REPO, f), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('every doc states the SAME Node version package.json enforces', () => {
  const required = pkg.engines.node.replace(/[^\d]/g, '');    // ">=22" -> "22"
  for (const f of ['INSTALL.md', 'README.md']) {
    const doc = read(f);
    const claims = [...doc.matchAll(/Node\.js\s*\**(\d+)/g)].map(m => m[1]);
    assert.ok(claims.length, `${f} never states a Node version`);
    for (const c of claims) {
      assert.equal(c, required,
        `${f} says Node ${c} but package.json enforces ${pkg.engines.node}. A user on Node ${c} ` +
        `follows the doc and the install fails.`);
    }
  }
});

test('INSTALL.md documents the npm install path', () => {
  const doc = read('INSTALL.md');
  assert.match(doc, /npm install -g sizmo/,
    'INSTALL.md ships inside the npm package and never mentions installing from npm');
  assert.match(doc, /npx sizmo/, 'the no-install route should be discoverable too');
});

test('INSTALL.md names only scopes that actually exist', () => {
  // The failure mode: a PIT granted `contacts.read` has no useful permission at all, and the user
  // has no way to know the doc invented the name.
  const doc = read('INSTALL.md');
  const bad = [...doc.matchAll(/`([a-z/]+\.read)`/g)].map(m => m[1]);
  assert.deepEqual(bad, [],
    `INSTALL.md names scope(s) that do not exist: ${bad.join(', ')}. GoHighLevel uses '.readonly'.`);
  // And the scopes it does name must be real ones from the code's own list.
  for (const m of doc.matchAll(/`?([a-z][a-z/]*\.readonly)`?/g)) {
    assert.ok(READ_SCOPES.includes(m[1]),
      `INSTALL.md names '${m[1]}', which is not in lib/diagnose.mjs's READ_SCOPES`);
  }
});

test('INSTALL.md lists the read scopes sizmo actually probes', () => {
  // Derived, not retyped: adding a scope to READ_SCOPES must not leave the install doc behind.
  const doc = read('INSTALL.md');
  const missing = READ_SCOPES.filter(sc => !doc.includes(sc));
  assert.deepEqual(missing, [],
    `INSTALL.md omits scope(s) sizmo probes: ${missing.join(', ')} — a user granting only what the ` +
    `doc lists gets a partially-blind install and a doctor report full of surprises`);
});

test('INSTALL.md points at sizmo init rather than only manual setup', () => {
  assert.match(read('INSTALL.md'), /sizmo init/,
    'the onboarding verb is absent from the onboarding document');
});

test('no doc claims a count that disagrees with the list under it', () => {
  // "does exactly three things (verified against the actual script)" over four numbered items. The
  // parenthetical made it worse: it asserted verification that plainly had not happened.
  const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
  for (const f of ['INSTALL.md', 'README.md']) {
    const lines = read(f).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/does (?:exactly )?(\w+) things/i);
      if (!m) continue;
      const claimed = WORDS[m[1].toLowerCase()] ?? Number(m[1]);
      if (!Number.isFinite(claimed)) continue;
      // Count the numbered items that follow, skipping blanks and fences.
      let actual = 0;
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s*\d+\.\s/.test(lines[j])) { actual++; continue; }
        if (/^\s*$/.test(lines[j]) || /^```/.test(lines[j])) continue;
        if (actual) break;
      }
      assert.equal(actual, claimed,
        `${f}:${i + 1} claims ${claimed} items and ${actual} follow: "${lines[i].trim()}"`);
    }
  }
});

test('sizmo --help lists the actual commands', () => {
  // It used to print "commands: see sizmo schema" and no names at all, so discovering that `brief`
  // exists meant running a command that emits a large JSON document. `init` was absent entirely.
  // CODE only. The first draft matched the whole file and flagged the COMMENT that describes the old
  // behaviour — the fifth time in this codebase that prose inside a guarded file has defeated a guard
  // reading it. The rule is now mechanical: strip comments before matching, every time.
  const src = read('lib/cli.mjs').split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  assert.match(src, /function commandLines/,
    'help must build its command list from the registry, not from a typed string');
  assert.ok(!/commands: see\s+sizmo schema/.test(src),
    'help still delegates the command list to `sizmo schema` instead of printing it');
  assert.match(src, /sizmo init/, 'the setup verb must appear in help');
});

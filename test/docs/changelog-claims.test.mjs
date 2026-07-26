// test/docs/changelog-claims.test.mjs
// Offline structural guards on CHANGELOG.md.
//
// WHY: audited 2026-07-27 against the real `npm view sizmo versions` list and found 8 headings
// for versions that were never published (2.4.1–2.4.5, 1.0.1, 1.2.0, plus the in-dev 2.4.9), so
// `npm install sizmo@2.4.3` fails on a version the changelog describes in detail. Nothing was
// missing in the other direction — every published version was documented.
//
// The npm cross-check needs the network, so it belongs in the audit loop, not here. What IS
// checkable offline is the failure that produced the mess: shipping a version bump without a
// matching entry, or duplicating/misordering headings. Those fail the build now.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
const CHANGELOG = readFileSync(join(REPO, 'CHANGELOG.md'), 'utf8');

const headings = [...CHANGELOG.matchAll(/^## \[(\d+\.\d+\.\d+)\]([^\n]*)$/gm)]
  .map(m => ({ version: m[1], rest: m[2] }));
const versions = headings.map(h => h.version);

const cmp = (a, b) => {
  const [aM, aN, aP] = a.split('.').map(Number);
  const [bM, bN, bP] = b.split('.').map(Number);
  return bM - aM || bN - aN || bP - aP; // descending
};

test('CHANGELOG documents the current package.json version', () => {
  assert.ok(versions.includes(pkg.version),
    `package.json is ${pkg.version} but CHANGELOG.md has no "## [${pkg.version}]" heading. ` +
    `Bumping the version without an entry is how this file drifted out of sync with npm.`);
});

test('CHANGELOG has no duplicate version headings', () => {
  const dupes = versions.filter((v, i) => versions.indexOf(v) !== i);
  assert.deepEqual([...new Set(dupes)], [],
    `Duplicate version headings: ${[...new Set(dupes)].join(', ')}. Two entries for one version ` +
    `means a reader cannot tell which changes actually shipped in it.`);
});

test('CHANGELOG versions are in descending order', () => {
  const sorted = [...versions].sort(cmp);
  assert.deepEqual(versions, sorted,
    'Version headings are out of order — newest must be first, per Keep a Changelog.');
});

test('CHANGELOG explains that some headings are not installable', () => {
  // The accuracy note added 2026-07-27. Without it, a reader has no way to know that a documented
  // version may not exist on npm, and will hit an install failure with no explanation.
  assert.ok(/not every heading below is installable/i.test(CHANGELOG),
    'CHANGELOG.md must keep the note explaining that some documented versions were never ' +
    'published — 8 of them currently are not installable.');
});

test('every version marked "not published" says where its changes actually shipped', () => {
  // A bare "(not published)" would tell a user their version is missing without telling them
  // which release to install instead — worse than silence.
  const offenders = headings
    .filter(h => /\(not published/i.test(h.rest))
    .filter(h => !/shipped in \d+\.\d+\.\d+/i.test(h.rest))
    .map(h => h.version);
  assert.deepEqual(offenders, [],
    `These headings are marked unpublished but do not name the release that carries their ` +
    `changes: ${offenders.join(', ')}. Tell the reader what to install instead.`);
});

test('a version marked "not published" is never the current package.json version', () => {
  // Catches the release-day mistake: publishing while the heading still says it was not published.
  const current = headings.find(h => h.version === pkg.version);
  if (!current) return; // covered by the first test
  assert.ok(!/\(not published/i.test(current.rest),
    `CHANGELOG marks ${pkg.version} as "not published", but it is the current package.json ` +
    `version. If you are about to publish it, update the heading in the same commit.`);
});

// test/docs/blocked-is-not-zero.test.mjs
// "It never fabricates a number" is sizmo's loudest promise — README states it in the opening
// paragraph and repeats it for the --json envelope. The failure mode it guards against is
// specific: a data source that was BLOCKED (401/403) returning 0 instead of unknown, so a
// consumer cannot tell "nothing owed" from "not allowed to look".
//
// Audited 2026-07-27. It was false in receivables, which returned totalOwed:0 while holding the
// HTTP status proving the invoices were never read — a consumer summing across locations silently
// under-counted real money owed. Fixed there (null + a `blocked` marker + a render that says
// UNKNOWN), and pinned by test/commands/receivables.test.mjs.
//
// This file guards the CLASS rather than the one instance: the remaining offenders are listed
// explicitly so no NEW lane can quietly join them, and so the outstanding work stays visible in
// code instead of evaporating into a commit message.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CMD_DIR = join(REPO, 'commands');

// Lanes still returning hardcoded zeros on a blocked branch, as of 2026-07-27. Each one is a
// place where "blocked" and "genuinely empty" are indistinguishable in the payload.
//
// This list may only ever SHRINK. Adding to it means shipping a new fabricated zero — fix the
// command instead. Removing one means it now reports unknown, so drop it here in the same commit.
const KNOWN_FABRICATES_ZERO = new Set([
  'booked-not-paid', // carries a `caveat` string, but calendars/settled/billedUnpaidTotal are 0
  'noshow',
  'pipeline',        // totalValue: 0 — money, should be next
  'reconcile',
  'segment',
  'triage',
]);

// Commands proven to report unknown rather than zero. Regression-protected: if one of these
// starts returning a hardcoded 0 next to a "can't see" warning again, this fails.
const MUST_REPORT_UNKNOWN = ['receivables'];

function sourceOf(cmd) {
  return readFileSync(join(CMD_DIR, `${cmd}.mjs`), 'utf8');
}

// A blocked branch = a "can't see …" degraded warning followed closely by a return of an object
// literal. If that literal assigns any bare `: 0`, it is asserting a measured zero it never saw.
function blockedBranchesWithZeros(src) {
  const hits = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/warn\(`can't see/.test(lines[i])) continue;
    const window = lines.slice(i, i + 6).join('\n');
    if (/return\s*\{/.test(window) && /:\s*0\b/.test(window)) hits.push(i + 1);
  }
  return hits;
}

test('receivables reports UNKNOWN, not zero, when blocked', () => {
  for (const cmd of MUST_REPORT_UNKNOWN) {
    const src = sourceOf(cmd);
    assert.deepEqual(blockedBranchesWithZeros(src), [],
      `${cmd}.mjs asserts a zero on a blocked branch again. A denied read must return null with a ` +
      `\`blocked\` marker — README promises a blocked source is reported as unknown, never as zero.`);
    assert.ok(/blocked:/.test(src),
      `${cmd}.mjs must carry a \`blocked\` marker so the reason travels with the unknown.`);
  }
});

test('no NEW command starts fabricating zeros on a blocked branch', () => {
  const commands = readdirSync(CMD_DIR).filter(f => f.endsWith('.mjs')).map(f => f.replace('.mjs', ''));
  const offenders = commands
    .filter(cmd => blockedBranchesWithZeros(sourceOf(cmd)).length > 0)
    .filter(cmd => !KNOWN_FABRICATES_ZERO.has(cmd))
    .sort();
  assert.deepEqual(offenders, [],
    `These commands return a hardcoded 0 from a blocked branch, and are not on the known list: ` +
    `${offenders.join(', ')}. A blocked source must report null (unknown) with a \`blocked\` ` +
    `marker, not a zero a consumer will treat as a real measurement.`);
});

test('the known-offenders list only shrinks — entries that are fixed must be removed', () => {
  // Prevents the list from rotting into a permanent excuse: once a command is fixed, leaving it
  // here would silently re-permit the bug later.
  const stale = [...KNOWN_FABRICATES_ZERO]
    .filter(cmd => blockedBranchesWithZeros(sourceOf(cmd)).length === 0)
    .sort();
  assert.deepEqual(stale, [],
    `These are listed as fabricating zeros but no longer do: ${stale.join(', ')}. ` +
    `Remove them from KNOWN_FABRICATES_ZERO — the list must only shrink.`);
});

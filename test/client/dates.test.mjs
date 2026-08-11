// test/client/dates.test.mjs
//
// lib/dates.mjs collects time helpers that were copy-pasted across nine commands. The copies had
// already diverged before extraction:
//     ymd()           2 identical copies                invoice.mjs, reconcile.mjs
//     parseAgeDays()  2 copies — focus's declared a `nowMs` parameter its body never used
//     ago()           4 copies, TWO DIFFERENT BEHAVIOURS, one file defining it twice
//     short date      2 identical copies                snapshot.mjs, booked-not-paid.mjs
//     long date       3 identical copies, all inside brief.mjs
//
// The two `ago` behaviours are the part worth guarding. They are NOT an accident to be tidied away:
// coarse never emits minutes (a deal is not meaningfully "stuck for 20m"), fine does (how long a
// person has waited on a reply is exactly a minutes question). Unifying them would silently change
// what noshow, pipeline and triage print. These tests exist so that unification fails loudly.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  ymd, agoCoarse, agoFine, parseAgeDays, fmtShortDate, fmtDateTime, fmtLongDate,
} from '../../lib/dates.mjs';

const NOW = Date.parse('2026-08-11T12:00:00Z');
const MIN = 60000, H = 3600000, D = 86400000;

test('agoCoarse never emits minutes — sub-hour floors to 1h', () => {
  assert.equal(agoCoarse(NOW, NOW - 3 * D), '3d');
  assert.equal(agoCoarse(NOW, NOW - 5 * H), '5h');
  assert.equal(agoCoarse(NOW, NOW - 20 * MIN), '1h', 'coarse must round sub-hour UP to 1h, not to 0h');
  assert.equal(agoCoarse(NOW, NOW - 30000), '1h', 'even 30 seconds reads as 1h — never "0h"');
  assert.ok(!/m$/.test(agoCoarse(NOW, NOW - 20 * MIN)), 'coarse must never produce a minutes label');
});

test('agoFine DOES fall through to minutes', () => {
  assert.equal(agoFine(NOW, NOW - 3 * D), '3d');
  assert.equal(agoFine(NOW, NOW - 5 * H), '5h');
  assert.equal(agoFine(NOW, NOW - 20 * MIN), '20m', 'fine must keep minute resolution');
  assert.equal(agoFine(NOW, NOW - 30000), '1m', 'sub-minute floors to 1m, never "0m"');
});

test('the two behaviours genuinely differ — this is deliberate, not drift', () => {
  // If someone "simplifies" these into one function, this fails. That is the point: unifying them
  // changes what noshow/pipeline print (they would gain minutes) or what triage prints (it would
  // lose them). Either is a silent output change to a shipped report.
  const t = NOW - 20 * MIN;
  assert.notEqual(agoCoarse(NOW, t), agoFine(NOW, t),
    'agoCoarse and agoFine must not collapse into the same function');
  assert.equal(agoCoarse(NOW, t), '1h');
  assert.equal(agoFine(NOW, t), '20m');
});

test('parseAgeDays inverts the ago labels, rounding partial units UP', () => {
  assert.equal(parseAgeDays('3d'), 3);
  assert.equal(parseAgeDays('5h'), 1, 'part of a day counts as a day for staleness ranking');
  assert.equal(parseAgeDays('20m'), 1);
  assert.equal(parseAgeDays(42), 42, 'a number passes through untouched');
});

test('an unparseable age is 0, never NaN', () => {
  // NaN would poison a sort silently — every comparison against it is false, so the item lands in an
  // arbitrary position rather than an obviously-wrong one. 0 ranks it as fresh, which is visible.
  for (const bad of ['', null, undefined, 'garbage', '3 days', 'd', '-2d']) {
    const v = parseAgeDays(bad);
    assert.ok(Number.isFinite(v), `parseAgeDays(${JSON.stringify(bad)}) returned ${v} — must never be NaN`);
    assert.equal(v, 0);
  }
});

test('ymd is UTC and wire-shaped', () => {
  assert.equal(ymd(NOW), '2026-08-11');
  assert.match(ymd(NOW), /^\d{4}-\d{2}-\d{2}$/, 'the GHL date params expect exactly YYYY-MM-DD');
});

test('the display formats respect the timezone they are given', () => {
  // The whole reason the envelope now carries a timezone: the same instant is a different clock
  // time, and sometimes a different DAY, depending on the zone.
  assert.equal(fmtShortDate(NOW, 'Asia/Manila'), 'Aug 11');
  assert.equal(fmtLongDate(NOW, 'Asia/Manila'), 'Tuesday, Aug 11');
  const manila = fmtDateTime(NOW, 'Asia/Manila');
  const ny = fmtDateTime(NOW, 'America/New_York');
  assert.notEqual(manila, ny, 'a formatter that ignores its tz argument renders the wrong local time');
  assert.match(manila, /8:00 PM/);
  assert.match(ny, /8:00 AM/);
});

test('no command re-implements these locally any more', async () => {
  // The extraction is only worth anything if the copies are gone. A local redefinition would shadow
  // the import and drift again.
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const CMDS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'commands');
  const offenders = [];
  for (const f of readdirSync(CMDS).filter(f => f.endsWith('.mjs'))) {
    // CODE only — these patterns appear in comments explaining the extraction.
    const code = readFileSync(join(CMDS, f), 'utf8').split('\n')
      .map(l => l.replace(/\/\/.*$/, '')).join('\n');
    if (/const ymd = \(ms\) =>/.test(code)) offenders.push(`${f}: local ymd`);
    if (/^function parseAgeDays/m.test(code)) offenders.push(`${f}: local parseAgeDays`);
    if (/toLocaleDateString\(|toLocaleString\('en-US', \{ timeZone/.test(code)) offenders.push(`${f}: local date formatter`);
  }
  assert.deepEqual(offenders, [], `these still define their own copy: ${offenders.join(' | ')}`);
});

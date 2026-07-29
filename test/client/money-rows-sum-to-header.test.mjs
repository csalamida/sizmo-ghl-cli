// test/client/money-rows-sum-to-header.test.mjs
//
// fmtMoney used an unconditional `maximumFractionDigits: 0`, so every row of a table was rounded on
// its own while the header total was formatted from the true sum. Measured 2026-07-30 on four
// receivables rows of ₱100.50:
//     rows rendered    ₱101  ₱101  ₱101  ₱101   -> a reader adds 404
//     header rendered  ₱402                     -> correct, and ₱2 away from its own rows
// Worst case, 40 rows of ₱0.50: every row shows ₱1 (summing to 40) under a ₱20 header. A 100%
// discrepancy on an accounts-receivable report — and the header, the one number that was right,
// looked like the mistake.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fmtMoney } from '../../lib/money.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// What a reader does with a rendered column: read the digits off each row and add them up.
const readBack = (s) => Number(String(s).replace(/[^0-9.-]/g, ''));

test('a column of rendered rows adds up to the rendered header', () => {
  const cases = [
    [[100.50, 100.50, 100.50, 100.50], 'the original report'],
    [Array.from({ length: 40 }, () => 0.5), '40 rows of ₱0.50 — the 100%-error case'],
    [[0.01, 0.01, 0.01], 'cent amounts'],
    [[1234.99, 0.01], 'a total that lands exactly on a whole number'],
    [[7.25, 3.10, 19.99, 250], 'a mixed column'],
    [[1000, 2000, 3000], 'whole amounts — must stay decimal-free'],
  ];
  for (const [rows, label] of cases) {
    const trueTotal = rows.reduce((a, b) => a + b, 0);
    const readerSum = rows.map(r => readBack(fmtMoney(r, 'PHP'))).reduce((a, b) => a + b, 0);
    const header = readBack(fmtMoney(trueTotal, 'PHP'));
    assert.ok(Math.abs(readerSum - header) < 0.005,
      `${label}: the rows render as [${rows.map(r => fmtMoney(r, 'PHP')).join(', ')}] which a reader ` +
      `adds to ${readerSum}, but the header renders as ${fmtMoney(trueTotal, 'PHP')}. A money report ` +
      `must never disagree with the sum of its own rows.`);
  }
});

test('whole amounts render with no decimals — the inverse guard', () => {
  // The over-correction: forcing two decimals everywhere would turn every clean figure into
  // "₱30,000.00" and make the common case noisier to read.
  assert.equal(fmtMoney(30000, 'AUD'), 'A$30,000');
  assert.equal(fmtMoney(0, 'PHP'), '₱0');
  assert.equal(fmtMoney(1234, 'USD'), '$1,234');
  assert.equal(fmtMoney(402, 'PHP'), '₱402', 'a fractional column summing to a whole number');
});

test('fractional amounts render with exactly two decimals, not one and not three', () => {
  assert.equal(fmtMoney(100.5, 'PHP'), '₱100.50', 'a trailing zero must be kept or the column misaligns');
  assert.equal(fmtMoney(100.05, 'PHP'), '₱100.05');
  assert.equal(fmtMoney(0.01, 'PHP'), '₱0.01');
  assert.equal(fmtMoney(1234.567, 'PHP'), '₱1,234.57', 'sub-cent precision rounds to the cent');
});

test('unknown and non-finite amounts are still not numbers', () => {
  // The precision change must not weaken the UNKNOWN contract: a missing figure is never ₱0.
  for (const v of [null, undefined, NaN, Infinity, 'abc']) {
    assert.equal(fmtMoney(v, 'PHP'), '—', `${String(v)} rendered as a number`);
  }
  assert.equal(fmtMoney(1234.5), '1,234.50', 'no currency means no symbol, never an assumed ₱');
});

test('no command formats money without going through lib/money.mjs', () => {
  // Three surfaces bypassed it: invoice draft twice (with two DIFFERENT roundings, so its confirm
  // preview and its success line disagreed on the same invoice), and brief twice (a private copy of
  // the formatter plus a third inline one for its itemized rows). A bypass is how a confirm preview
  // ends up showing an amount other than the one that gets created.
  const offenders = [];
  for (const f of readdirSync(join(REPO, 'commands')).filter(f => f.endsWith('.mjs'))) {
    const lines = readFileSync(join(REPO, 'commands', f), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].replace(/\/\/.*$/, '');                 // CODE only
      if (!l.includes('toLocaleString')) continue;
      // Date rendering legitimately uses toLocaleString; money rendering must not.
      if (/new Date\(|timeZone:/.test(l)) continue;
      offenders.push(`${f}:${i + 1}`);
    }
  }
  assert.deepEqual(offenders, [],
    `These format a number with toLocaleString directly instead of lib/money.mjs's fmtMoney: ` +
    `${offenders.join(', ')}. Every copy rounds on its own, so a header and its rows — or a confirm ` +
    `preview and the record it creates — can print different figures for the same amount.`);
});

test("invoice draft's preview and its success line render the same total", () => {
  // Asserted on source: both must call the shared formatter with the same arguments. Running the
  // real command to compare them would mean creating an invoice.
  const src = readFileSync(join(REPO, 'commands', 'invoice.mjs'), 'utf8')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');   // CODE only
  const calls = [...src.matchAll(/fmtMoney\(\s*total\s*,\s*currency\s*\)/g)];
  assert.ok(calls.length >= 2,
    `expected the confirm preview AND the created-invoice line to both render via ` +
    `fmtMoney(total, currency); found ${calls.length} such call(s)`);
  assert.ok(!/total\.toLocaleString/.test(src),
    'invoice still formats a total itself — that is how the preview and the success line diverged');
});

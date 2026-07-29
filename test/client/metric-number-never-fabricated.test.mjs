// test/client/metric-number-never-fabricated.test.mjs
//
// snapshotFromMetrics feeds the delta engine, which prints movements on money surfaces. It used to
// read a metric's rendered string by deleting every character it did not recognise and calling
// Number() on what was left:
//     value.replace(/[^0-9.-]/g, '')  ->  Number(...)
//
// Measured 2026-07-30 against the real function:
//     '—'                      -> 0            <- this is fmtMoney's OWN unknown marker
//     ''                       -> 0            <- Number('') === 0
//     'n/a'                    -> 0
//     '₱1,234 (3) + $500 (2)'  -> 123435002    <- multi-currency, digits concatenated
//
// The fabricated zero is the serious half. It is stored as the new baseline and then reported as a
// real movement: with a ₱5,000 baseline, a Collected metric the tool could not read produced
//     { now: 0, prev: 5000, change: -5000 }
// which reads as "you lost ₱5,000 since your last run". That is a fabricated number on a money
// surface, and it violates this codebase's standing rule that an unreadable source is UNKNOWN and
// never zero.
import { test } from 'node:test';
import assert from 'node:assert';
import { parseMetricNumber, snapshotFromMetrics, diff } from '../../lib/memory.mjs';
import { fmtMoney, SYM } from '../../lib/money.mjs';

test('an unreadable metric is null, never zero', () => {
  // Each of these produced 0 before the fix.
  for (const value of ['—', '', '  ', 'n/a', 'unknown', '-', '—%', 'BLOCKED']) {
    assert.strictEqual(parseMetricNumber(value), null,
      `${JSON.stringify(value)} parsed as a number — an unreadable value must be UNKNOWN, not zero`);
  }
});

test("fmtMoney's own unknown marker round-trips as unknown", () => {
  // The exact string money.mjs emits for a non-finite amount. If these two ever disagree, a
  // blocked money metric becomes a fabricated zero again.
  const marker = fmtMoney(null);
  assert.equal(marker, '—', 'money.mjs changed its unknown marker; this test pins the pair');
  assert.strictEqual(parseMetricNumber(marker), null,
    `fmtMoney emits ${JSON.stringify(marker)} for unknown but the parser reads it as a number`);
});

test('a multi-currency total is unknown, not the digits mashed together', () => {
  // snapshot.mjs renders multiple currencies as "₱1,234 (3) + $500 (2)". There is no single number
  // to report, so the honest answer is null — inventing ₱123,435,002 is not a rounding error.
  const value = '₱1,234 (3) + $500 (2)';
  assert.strictEqual(parseMetricNumber(value), null,
    `multi-currency value parsed as ${parseMetricNumber(value)}`);
});

test('a real number still parses — the inverse guard', () => {
  // Refusing everything would also "fix" the bug while destroying the feature. Every form the
  // tool actually renders must survive, including genuine zeros.
  const cases = [
    ['42', 42], [42, 42], [0, 0],
    ['₱1,234', 1234], ['$500', 500], ['A$30,000', 30000], ['HK$12', 12],
    ['AED 900', 900], ['XYZ 1,234', 1234],       // unknown-code fallback from money.mjs
    ['85%', 85], ['0%', 0], ['₱0', 0],           // a genuine zero must stay zero
    ['₱1,234.56', 1234.56], ['-₱100', -100], ['₱-100', -100],
  ];
  for (const [input, want] of cases) {
    assert.strictEqual(parseMetricNumber(input), want,
      `${JSON.stringify(input)} should parse to ${want}, got ${parseMetricNumber(input)}`);
  }
});

test('every currency symbol money.mjs can emit is parseable', () => {
  // Derived from money.mjs's table rather than listed by hand, so adding a currency there cannot
  // silently create a metric the delta engine reads as unknown.
  for (const code of Object.keys(SYM)) {
    const rendered = fmtMoney(1234, code);
    assert.strictEqual(parseMetricNumber(rendered), 1234,
      `fmtMoney(1234, '${code}') renders ${JSON.stringify(rendered)}, which the parser cannot read`);
  }
});

test('only the shapes fmtMoney actually emits are accepted', () => {
  // The parser's contract is narrow on purpose: it accepts what money.mjs renders, not everything
  // JavaScript's Number() will swallow. Relaxing the final check from a full-string match to a
  // leading-digit test (`/^-?\d/`) survived every other test in this file — Number() rejects the
  // multi-currency string on its own — so these are the cases that pin the difference.
  //
  // Number('0x10') is 16 and Number('1e5') is 100000. A metric string that looks like either is
  // not something this tool produced, so guessing at it is exactly the behaviour being fixed.
  for (const value of ['0x10', '1e5', '12.', '.5.', '1,2,3.4.5', '1 000']) {
    assert.strictEqual(parseMetricNumber(value), null,
      `${JSON.stringify(value)} was accepted — the parser must take only the shapes fmtMoney emits`);
  }
});

test('a blocked money metric reports no movement, not a loss', () => {
  // The end-to-end consequence. Before the fix this printed change: -5000.
  const prev = { recordedAt: 1, snapshot: { collected: 5000 }, actions: [] };
  const curr = snapshotFromMetrics([{ label: 'Collected', value: fmtMoney(null) }]);
  const d = diff(prev, curr, [], 2);
  assert.strictEqual(d.metrics.collected.now, null,
    'an unreadable Collected became a number');
  assert.strictEqual(d.metrics.collected.change, null,
    `reported change ${d.metrics.collected.change} against a value it could not read — the tool ` +
    `must say "unknown", never invent a movement on a money surface`);
});

test('a genuine drop to zero IS still reported — the inverse guard', () => {
  // The over-correction to guard against: if "unknown" swallowed real zeros, an account that
  // actually collected nothing this period would report no movement and hide a real problem.
  const prev = { recordedAt: 1, snapshot: { collected: 5000 }, actions: [] };
  const curr = snapshotFromMetrics([{ label: 'Collected', value: fmtMoney(0, 'PHP') }]);
  const d = diff(prev, curr, [], 2);
  assert.strictEqual(d.metrics.collected.now, 0, 'a real ₱0 was misread as unknown');
  assert.strictEqual(d.metrics.collected.change, -5000,
    'a genuine drop from ₱5,000 to ₱0 must still be reported as -5000');
});

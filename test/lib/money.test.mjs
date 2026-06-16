// test/lib/money.test.mjs — the canonical money formatter. Locks the symbol set + the
// honesty rules (non-finite → '—', unknown currency → no assumed symbol).
import { test } from 'node:test';
import assert from 'node:assert';
import { SYM, symbolFor, fmtMoney } from '../../lib/money.mjs';

test('SYM covers the full union (incl. AUD/CAD that used to drift)', () => {
  for (const c of ['PHP', 'USD', 'EUR', 'GBP', 'AUD', 'CAD']) {
    assert.ok(SYM[c], `${c} has a symbol`);
  }
  assert.equal(SYM.AUD, 'A$');
  assert.equal(SYM.CAD, 'C$');
});

test('symbolFor: known → symbol, unknown → neutral "CODE ", empty → ""', () => {
  assert.equal(symbolFor('PHP'), '₱');
  assert.equal(symbolFor('usd'), '$', 'case-insensitive');
  assert.equal(symbolFor('ZZZ'), 'ZZZ ', 'unknown code → neutral prefix, never ₱');
  assert.equal(symbolFor(''), '');
  assert.equal(symbolFor(null), '');
  assert.equal(symbolFor(undefined), '');
});

test('fmtMoney: finite amount → symbol + grouped digits', () => {
  assert.equal(fmtMoney(30000, 'PHP'), '₱30,000');
  assert.equal(fmtMoney(30000, 'AUD'), 'A$30,000', 'AUD no longer drifts to "AUD "');
  assert.equal(fmtMoney(0, 'USD'), '$0', 'a real zero shows, never hidden');
});

test('fmtMoney: non-finite → "—" (never a fabricated 0)', () => {
  assert.equal(fmtMoney(null, 'PHP'), '—');
  assert.equal(fmtMoney(undefined, 'PHP'), '—');
  assert.equal(fmtMoney(NaN, 'PHP'), '—');
  assert.equal(fmtMoney('abc', 'PHP'), '—');
});

test('fmtMoney: missing currency → number with NO symbol (never assumes ₱)', () => {
  assert.equal(fmtMoney(1000), '1,000');
  assert.equal(fmtMoney(1000, ''), '1,000');
  assert.doesNotMatch(fmtMoney(1000, null), /₱/);
});

test('fmtMoney: unknown currency code → neutral prefix on the amount', () => {
  assert.equal(fmtMoney(500, 'ZZZ'), 'ZZZ 500');
});

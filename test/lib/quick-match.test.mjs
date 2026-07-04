// test/lib/quick-match.test.mjs — the local fast-path must NEVER guess. Every match is
// read-only and exact; anything even slightly ambiguous returns null (falls through to the LLM).
import { test } from 'node:test';
import assert from 'node:assert';
import { quickMatch } from '../../lib/quick-match.mjs';

test('quickMatch: bare read commands match exactly, case/whitespace-insensitive', () => {
  for (const cmd of ['brief', 'doctor', 'snapshot', 'triage', 'pipeline', 'receivables', 'reconcile', 'noshow', 'focus', 'crm']) {
    const r = quickMatch(cmd);
    assert.ok(r, `expected a match for "${cmd}"`);
    assert.equal(r.command, cmd);
    assert.equal(r.isWrite, false);
    assert.equal(r.confidence, 1);
  }
  const r = quickMatch('  Brief  ');
  assert.equal(r.command, 'brief');
});

test('quickMatch: noshow/booked-not-paid aliases resolve to canonical command', () => {
  assert.equal(quickMatch('no show').command, 'noshow');
  assert.equal(quickMatch('no-show').command, 'noshow');
  assert.equal(quickMatch('noshows').command, 'noshow');
  assert.equal(quickMatch('booked not paid').command, 'booked-not-paid');
  assert.equal(quickMatch('booked but not paid').command, 'booked-not-paid');
});

test('quickMatch: list [entity] resolves via alias map, singular or plural', () => {
  const r1 = quickMatch('list forms');
  assert.deepEqual(r1.args, ['forms']);
  const r2 = quickMatch('list form');
  assert.deepEqual(r2.args, ['forms']);
  const r3 = quickMatch('list business');
  assert.deepEqual(r3.args, ['businesses']);
  const r4 = quickMatch('list');
  assert.equal(r4.command, 'list');
  assert.deepEqual(r4.args, []);
});

test('quickMatch: forms/surveys/transactions/business list bare commands', () => {
  assert.equal(quickMatch('forms').command, 'forms');
  assert.equal(quickMatch('surveys').command, 'surveys');
  assert.equal(quickMatch('transactions').command, 'transactions');
  const biz = quickMatch('business list');
  assert.equal(biz.command, 'business');
  assert.deepEqual(biz.args, ['list']);
});

test('quickMatch: never guesses on free text, write commands, or unknown entities', () => {
  assert.equal(quickMatch('tag Ana as VIP'), null);
  assert.equal(quickMatch('who hasn\'t replied in 3 days'), null);
  assert.equal(quickMatch('list nonsense-entity'), null);
  assert.equal(quickMatch('send Marco a message'), null);
  assert.equal(quickMatch(''), null);
  assert.equal(quickMatch(null), null);
  assert.equal(quickMatch(undefined), null);
});

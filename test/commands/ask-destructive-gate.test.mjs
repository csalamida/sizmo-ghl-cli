// test/commands/ask-destructive-gate.test.mjs
//
// SKILL.md and AGENTS.md advertised `sizmo ask "delete Marco's stalled deal" --confirm` as a
// one-liner, while the same documents stated the --confirm gate "is the human in the loop". Both
// could not be true: on that path the human approved a SENTENCE and never saw which record the AI
// picked.
//
// Decision 2026-07-30: preview DESTRUCTIVE plans only. A delete or cancel resolved from a sentence
// always previews and requires a second bare `sizmo ask --confirm`. Non-destructive one-liners
// (tag, note, book) keep firing in one shot, because approving "tag Ana as follow-up" without seeing
// the resolved id is a fair trade and approving a deletion is not.
//
// The two legs are genuinely different code paths and both are covered here:
//   leg 1  bare `sizmo ask --confirm` replaying a plan the human already previewed  -> fires
//   leg 2  `sizmo ask "sentence" --confirm` with no prior preview                   -> gated
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXIT } from '../../lib/errors.mjs';
import { makeFakeCtx } from '../_helpers.mjs';

function ctxFor({ json = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ask-gate-'));
  const h = makeFakeCtx({ json, confirmed: true });
  h.ctx._askMemoryDir = dir;
  const fired = [];
  for (const m of ['post', 'put', 'delete']) {
    h.ctx.http[m] = async (path) => { fired.push(`${m.toUpperCase()} ${path}`); return { code: 200, ok: true, txt: '{}', j: {} }; };
  }
  return { ...h, dir, fired };
}

const step = (command, subcommand, parsed, describe) =>
  ({ command, subcommand, parsed, isWrite: true, executable: true, describe });

// ── leg 1: a plan the human already previewed ────────────────────────────────

test('leg 1: a previewed DELETE still fires on a bare --confirm', async () => {
  // The gate must not double-gate. By this point the exact target has been shown, which is the whole
  // condition the decision rests on. Asserted as "reached execution", not "succeeded": `opp delete`
  // fetches the record first and that fetch has no fixture here, so it exits API. What matters is
  // that it did NOT divert to a preview (exit 5).
  const { run } = await import('../../commands/ask.mjs');
  const { savePendingPlan } = await import('../../lib/ask-memory.mjs');
  const h = ctxFor();
  savePendingPlan(h.ctx.cfg.loc, [
    step('opp', 'delete', { _: ['delete', 'opp_1'] }, 'Delete opportunity Website Package'),
  ], Date.now(), h.dir);
  const code = await run({ _: [] }, h.ctx);
  h.ctx.out.flush();
  assert.notEqual(code, EXIT.CONFIRM,
    'a delete the human already previewed was gated a second time — that is a dead end, not a safeguard');
});

test('leg 1: a previewed non-destructive plan fires and reports it', async () => {
  const { run } = await import('../../commands/ask.mjs');
  const { savePendingPlan } = await import('../../lib/ask-memory.mjs');
  const h = ctxFor({ json: true });
  savePendingPlan(h.ctx.cfg.loc, [
    step('tag', null, { _: ['ct_1'], add: 'VIP' }, 'Tag Ana: +VIP'),
  ], Date.now(), h.dir);
  const code = await run({ _: [] }, h.ctx);
  h.ctx.out.flush();
  assert.equal(code, EXIT.OK);
  assert.ok(h.fired.some(f => f.startsWith('POST')), 'the tag never reached the API');
  assert.equal(JSON.parse(h.getPrinted()).data.executed, true);
});

// ── the predicate itself ─────────────────────────────────────────────────────
// Exported behaviour is what the gate keys on, so it is worth pinning directly rather than only
// through the two legs.

test('destructive verbs are recognised from the subcommand', async () => {
  const src = await import('node:fs').then(fs => fs.readFileSync(
    join(import.meta.dirname, '..', '..', 'commands', 'ask.mjs'), 'utf8'));
  // Keyed on the VERB, not on command+verb pairs, so a destructive subcommand added to any command
  // later is caught by default instead of needing to be remembered.
  assert.match(src, /DESTRUCTIVE_SUBCOMMANDS = new Set\(\[[^\]]*'delete'[^\]]*\]\)/,
    'delete must be treated as destructive');
  assert.match(src, /DESTRUCTIVE_SUBCOMMANDS = new Set\(\[[^\]]*'cancel'[^\]]*\]\)/,
    'cancel destroys a booking and must be treated as destructive');
  // The fallback matters: concretize builds `parsed: { _: ['delete', id] }`, so even a step that
  // arrives without a `subcommand` field is still caught.
  assert.match(src, /parsed\?\._\?\.\[0\]/,
    'the predicate must also read the verb out of parsed._[0], or a step missing `subcommand` slips past');
});

test('a concretized step carries its subcommand', async () => {
  // It used to be dropped, which is why nothing downstream could tell a delete from a create — and
  // why the execution record shipped in 2.5.0 always reported subcommand: null.
  const src = await import('node:fs').then(fs => fs.readFileSync(
    join(import.meta.dirname, '..', '..', 'commands', 'ask.mjs'), 'utf8'));
  assert.match(src, /concrete\.push\(\{ command: step\.command, subcommand: step\.subcommand/,
    'the concretized step must keep the verb, or the gate is blind');
});

// ── leg 2: the gate, asserted at the decision point ──────────────────────────
// Reaching leg 2 for real needs a live LLM resolution, which this suite deliberately never does. The
// gate's condition is therefore pinned on the source, which is exactly where a regression would land.

test('leg 2: the one-shot fire is conditional on nothing destructive', async () => {
  const src = await import('node:fs').then(fs => fs.readFileSync(
    join(import.meta.dirname, '..', '..', 'commands', 'ask.mjs'), 'utf8'));
  const code = src.split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');   // CODE only
  assert.match(code, /const destructive = result\.concrete\.filter\(isDestructive\)/,
    'the destructive set must be computed before the fire decision');
  assert.match(code, /if \(ctx\.confirmed && !destructive\.length\) \{/,
    'a sentence carrying --confirm must only fire when nothing in the plan destroys anything');
  assert.ok(!/if \(ctx\.confirmed\) \{\s*\n\s*return runWithReport/.test(code),
    'the unconditional one-shot fire is back — a sentence can delete a record nobody saw');
});

test('leg 2: a blocked one-shot is machine-readable, not just prose', async () => {
  // An agent that passed --confirm and got exit 5 must be able to tell a REFUSAL from a stale plan.
  const src = await import('node:fs').then(fs => fs.readFileSync(
    join(import.meta.dirname, '..', '..', 'commands', 'ask.mjs'), 'utf8'));
  assert.match(src, /blockedOneShot/, 'the refusal must appear in the payload');
  assert.match(src, /destructive_requires_preview/, 'the reason must be a stable machine string');
  assert.match(src, /destructiveSteps/, 'the payload must name WHICH steps were destructive');
});

test('leg 2: the human is told why, and that nothing happened yet', async () => {
  const src = await import('node:fs').then(fs => fs.readFileSync(
    join(import.meta.dirname, '..', '..', 'commands', 'ask.mjs'), 'utf8'));
  assert.match(src, /approving the/, 'the message must explain that a sentence is not the record');
  assert.match(src, /Nothing has been changed yet/,
    'after a refused --confirm the user must be told plainly that no change landed');
});

// ── the docs must not advertise what the gate now refuses ────────────────────

test('no doc still advertises a one-shot delete via ask', async () => {
  const fs = await import('node:fs');
  const REPO = join(import.meta.dirname, '..', '..');
  for (const doc of ['SKILL.md', 'AGENTS.md', 'README.md']) {
    let text;
    try { text = fs.readFileSync(join(REPO, doc), 'utf8'); } catch { continue; }
    const bad = text.split('\n').filter(l =>
      /sizmo ask\s+"[^"]*\b(delete|cancel)\b[^"]*"\s+--confirm/.test(l));
    assert.deepEqual(bad, [],
      `${doc} still shows a destructive one-liner that the tool now refuses: ${bad.join(' | ')}. ` +
      `A documented example that exits 5 teaches the reader the tool is broken.`);
  }
});

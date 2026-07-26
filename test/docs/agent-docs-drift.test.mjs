// test/docs/agent-docs-drift.test.mjs
// SKILL.md and AGENTS.md are the two files an AI agent loads AS ITS ENTIRE KNOWLEDGE of this CLI
// (Claude Code reads SKILL.md, Codex/Cursor read AGENTS.md). A command missing from them does not
// exist as far as the agent is concerned; a flag that appears in them but not in source is worse
// than missing, because the agent will confidently emit a command that fails.
//
// WHY THIS EXISTS: doc drift is the single most recurring bug class in this repo. Three of the six
// daily-loop PRs (#2, #3, #6) were spent hand-patching AGENTS.md, and 2.4.8's release notes record
// SKILL.md teaching flag syntax that never existed plus an `invoice void` command that was never
// built. Audited again 2026-07-27: `ack` was absent from BOTH files, and SKILL.md was missing seven
// commands outright (ack, booked-not-paid, crm, focus, noshow, receivables, reconcile) — including
// three core money surfaces. Hand-fixing it a fourth time treats the symptom.
//
// So the rule is now mechanical: ship a command, document it in both files, or the build fails.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILL = readFileSync(join(REPO, 'SKILL.md'), 'utf8');
const AGENTS = readFileSync(join(REPO, 'AGENTS.md'), 'utf8');

const commandNames = readdirSync(join(REPO, 'commands'))
  .filter(f => f.endsWith('.mjs'))
  .map(f => f.replace('.mjs', ''))
  .sort();

// `init` is setup, not an operational command an agent drives; it is covered in INSTALL.md.
// Keep this list tiny and justified — it is the escape hatch that could quietly gut this test.
const NOT_AGENT_FACING = new Set(['init']);
const expected = commandNames.filter(c => !NOT_AGENT_FACING.has(c));

// Match the command as a word, so `sizmo ack` is found whether it appears in a bullet, a fenced
// example, or a table cell. Word-boundary rather than the literal string "sizmo <name>" because
// the docs legitimately use several formats.
const mentions = (doc, cmd) => new RegExp(`\\b${cmd.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`).test(doc);

test('every command is documented in SKILL.md (Claude Code’s briefing)', () => {
  const missing = expected.filter(c => !mentions(SKILL, c));
  assert.deepEqual(missing, [],
    `Commands absent from SKILL.md: ${missing.join(', ')}. Claude Code loads this file as its ` +
    `complete command reference — anything not in it is invisible to the agent. Add it, or add ` +
    `the command to NOT_AGENT_FACING with a reason.`);
});

test('every command is documented in AGENTS.md (Codex/Cursor’s briefing)', () => {
  const missing = expected.filter(c => !mentions(AGENTS, c));
  assert.deepEqual(missing, [],
    `Commands absent from AGENTS.md: ${missing.join(', ')}. Same contract as SKILL.md, different ` +
    `audience — both must stay complete.`);
});

test('the two agent docs cover the same command set', () => {
  // They serve different tools but must not disagree about what the CLI can do — a command in one
  // and not the other means an agent's capability depends on which editor the user happens to run.
  const onlySkill = expected.filter(c => mentions(SKILL, c) && !mentions(AGENTS, c));
  const onlyAgents = expected.filter(c => mentions(AGENTS, c) && !mentions(SKILL, c));
  assert.deepEqual({ onlySkill, onlyAgents }, { onlySkill: [], onlyAgents: [] },
    'SKILL.md and AGENTS.md disagree about which commands exist.');
});

// ── flags documented must actually exist ──────────────────────────────────────

// Collect every real flag. Two sources, and BOTH are required: commands declare most flags in
// meta.flags, but the `config set` / auth family (--pit-stdin, --ai-key, --ai-provider, --loc) is
// parsed directly in lib/cli.mjs and appears in no command's meta. A first draft of this test read
// only commands/*.mjs and reported those four as fabricated — they are real, and "fixing" the docs
// to satisfy that would have deleted correct, security-relevant instructions.
// Flags lib/cli.mjs applies to EVERY command — valid anywhere, so they are never "wrong for this
// command". Kept separate from realFlags so the per-command check below can tell the difference
// between "global, fine here" and "real, but belongs to a different command".
const GLOBALS = new Set([
  '--json', '--ndjson', '--fields', '--concise', '--fresh', '--no-cache',
  '--profile', '--confirm', '--dry-run', '--no-update-check', '--all', '--help', '--version',
]);
const realFlags = new Set(GLOBALS);
const flagSources = [
  ...commandNames.map(n => join(REPO, 'commands', `${n}.mjs`)),
  join(REPO, 'lib', 'cli.mjs'),
];
for (const file of flagSources) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/name:\s*'(--[a-z0-9-]+)'/gi)) realFlags.add(m[1]);
  // cli.mjs parses these positionally rather than declaring them: flag('--x') / includes('--x')
  for (const m of src.matchAll(/(?:flag|includes)\(\s*'(--[a-z0-9-]+)'/gi)) realFlags.add(m[1]);
}

// PER-COMMAND flag map. A global "does this flag exist anywhere" check is too weak to be useful:
// it passes `sizmo ack --days 7` because --days is real on reconcile/triage/booked-not-paid, even
// though ack's actual flag is --for. That exact mistake was made while writing these docs on
// 2026-07-27 and a global check did not catch it — so the check is scoped per command.
const flagsFor = new Map();
for (const name of commandNames) {
  const src = readFileSync(join(REPO, 'commands', `${name}.mjs`), 'utf8');
  flagsFor.set(name, new Set([...src.matchAll(/name:\s*'(--[a-z0-9-]+)'/gi)].map(m => m[1])));
}

for (const [label, doc] of [['SKILL.md', SKILL], ['AGENTS.md', AGENTS]]) {
  test(`${label}: every flag in a shell example is valid FOR THAT COMMAND`, () => {
    // Only inspect fenced shell examples — prose can discuss a flag loosely, but a
    // copy-pasteable example that fails is a direct agent failure.
    const fences = [...doc.matchAll(/```(?:sh|bash)?\n([\s\S]*?)```/g)].map(m => m[1]).join('\n');
    const problems = [];

    for (const rawLine of fences.split('\n')) {
      const line = rawLine.replace(/#.*$/, '').trim(); // strip trailing comments
      const m = /^sizmo\s+([a-z0-9-]+)/i.exec(line);
      if (!m) continue;
      const cmd = m[1].toLowerCase();
      // `config`, `init` and friends are parsed in lib/cli.mjs, not commands/ — fall back to the
      // repo-wide set for those rather than reporting every auth example as bogus.
      const known = flagsFor.get(cmd);
      const used = [...line.matchAll(/\s(--[a-z0-9-]+)/gi)]
        .map(f => f[1].toLowerCase())
        .filter(f => /^--[a-z0-9]/.test(f)); // `---` is a markdown rule, not a flag

      for (const flag of used) {
        if (realFlags.has(flag) && !known) continue;         // cli.mjs-parsed command
        if (!realFlags.has(flag)) { problems.push(`${cmd}: ${flag} (exists nowhere)`); continue; }
        if (known && !known.has(flag) && !GLOBALS.has(flag)) {
          problems.push(`${cmd}: ${flag} (real flag, but not on \`sizmo ${cmd}\`)`);
        }
      }
    }

    assert.deepEqual([...new Set(problems)].sort(), [],
      `${label} shows flags that will fail as written:\n  ${[...new Set(problems)].sort().join('\n  ')}\n` +
      `This is the 2.4.8 failure repeating — an agent emits these confidently and the command ` +
      `fails. Check commands/<cmd>.mjs meta.flags before documenting syntax.`);
  });
}

// ── specific past regressions, pinned ─────────────────────────────────────────

test('neither agent doc resurrects the non-existent `invoice void` command', () => {
  // Documented for real in SKILL.md until 2.4.8. It has never existed.
  for (const [label, doc] of [['SKILL.md', SKILL], ['AGENTS.md', AGENTS]]) {
    assert.ok(!/invoice\s+void/i.test(doc),
      `${label} documents "invoice void", which has never been implemented.`);
  }
});

test('agent docs do not teach `tag add` / `note add` subcommands (both are flat)', () => {
  // Another real 2.4.8 fabrication: these commands take no subcommand.
  for (const [label, doc] of [['SKILL.md', SKILL], ['AGENTS.md', AGENTS]]) {
    assert.ok(!/sizmo\s+tag\s+add\b/i.test(doc), `${label} teaches "sizmo tag add" — tag is flat.`);
    assert.ok(!/sizmo\s+note\s+add\b/i.test(doc), `${label} teaches "sizmo note add" — note is flat.`);
  }
});

test('ack is documented in both docs as local-only state', () => {
  // ack was missing from both files entirely until 2026-07-27. It is the reason an item can
  // silently vanish from focus/brief, so an agent that does not know it exists will misdiagnose
  // a snoozed contact as missing CRM data.
  for (const [label, doc] of [['SKILL.md', SKILL], ['AGENTS.md', AGENTS]]) {
    assert.ok(/sizmo ack/.test(doc), `${label} must document sizmo ack`);
    assert.ok(/--list/.test(doc) && /--clear/.test(doc),
      `${label} must document ack --list and --clear so a hidden item can be found and restored`);
    assert.ok(/hidden, not deleted|hidden not deleted/i.test(doc),
      `${label} must state that acked items are hidden rather than deleted — that is the honesty ` +
      `contract in commands/ack.mjs, and an agent needs it to explain a missing contact.`);
  }
});

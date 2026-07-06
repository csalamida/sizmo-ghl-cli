// scripts/daily-loop/config.mjs — lane rotation + prompts for the recurring engineering loop.
//
// 4 lanes, one per weekday (Mon–Thu). Fri/Sat/Sun: no run — nothing to review over the weekend.
// Every lane's prompt is intentionally narrow and bounded, never "go improve the CLI" — an
// unattended agent given loose scope is how you get scope creep or wandering into the wrong file.
//
// SAFETY MODEL (read before editing a lane prompt):
//   - The agent's job ends at "make changes + write findings.md in the worktree." It NEVER runs
//     git commit/push, gh pr create, or npm publish itself — run.mjs (plain deterministic Node,
//     not the agent) does that, only after the agent's process has exited. This is the real
//     guarantee, not a suggestion in the prompt.
//   - DEFAULT-DENY, not default-allow-except-a-blocklist. The agent runs with an explicit
//     --allowedTools ALLOWLIST (SAFETY_ALLOWED_TOOLS below) and --permission-mode default (no
//     TTY present to approve anything ad hoc, so anything not on the list is refused, not
//     hung-waiting). File read/edit/write is unrestricted (that's how every lane actually does
//     its work) — the narrow part is which Bash commands can run. Reachable `sizmo` subcommands
//     are exactly the reversible, test-safe ones (every read command, plus contact/tag/note/
//     field/value/calendar/business/opp create+move+update). `sizmo invoice send`, `sizmo send`,
//     `sizmo appointment book`, `git push`, `git commit`, `gh pr create`, `gh release`, and
//     `npm publish` are simply NOT on the list — blocked because they were never granted, not
//     because a denylist entry happened to catch the right wording. (An earlier draft of this
//     used bypassPermissions + a hand-written denylist; the permission classifier correctly
//     flagged that as weaker than what was promised, since it relies entirely on the denylist
//     wording being complete. This allowlist is the fix.)
//   - Every run notifies Discord — success, failure, timeout, or "nothing found." Silence must
//     never be the only signal that something went wrong.

export const REPO_SLUG = 'csalamida/sizmo-ghl-cli';

// Read commands — always safe, never mutate anything.
const SAFE_READ_CMDS = [
  'brief', 'snapshot', 'triage', 'pipeline', 'noshow', 'receivables', 'reconcile',
  'booked-not-paid', 'focus', 'segment', 'crm', 'list', 'sync', 'export', 'diff',
  'doctor', 'forms', 'surveys', 'transactions', 'schema', 'auth', 'api',
];
// Write commands — reversible, test-entity-only per the safety preamble below.
// invoice / send / appointment are deliberately absent — not blocked by a rule, just never granted.
const SAFE_WRITE_CMDS = ['contact', 'tag', 'note', 'field', 'value', 'calendar', 'business', 'opp'];

export const SAFETY_ALLOWED_TOOLS = [
  'Read', 'Grep', 'Glob', 'Edit', 'Write',
  ...SAFE_READ_CMDS.map(c => `Bash(node bin/sizmo.mjs ${c}*)`),
  ...SAFE_WRITE_CMDS.map(c => `Bash(node bin/sizmo.mjs ${c} *)`),
  'Bash(node --test*)', 'Bash(npm test*)', 'Bash(npm run test*)',
  'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)',
  'Bash(node -e *)', // ad hoc verification snippets (raw http.mjs calls) — same PIT scope as sizmo itself, no new capability
].join(' ');

const SAFETY_PREAMBLE = `
You are running UNATTENDED, on a schedule, with nobody watching in real time. That changes what's
safe to do compared to a supervised session:
- You may test read commands and the following writes ONLY, always against a test entity you
  create yourself, always named with a "SIZMO-VERIFY-" or "DAILY-LOOP-" prefix so it's identifiable
  and safe to leave behind: contact create/upsert/delete, tag, note, field/value/calendar/business
  create+delete, opp create/move/update.
- You must NEVER run \`sizmo invoice send\`, \`sizmo send\`, or \`sizmo appointment book\` — these
  reach a real payment request, a real message, or a real calendar. They are hard-blocked at the
  runtime level regardless, but do not attempt them.
- You must NEVER run \`git push\`, \`gh pr create\`, \`gh release\`, or \`npm publish\` yourself.
  Make your changes, then write a file named \`findings.md\` in the repo root summarizing exactly
  what you found/changed and why, with evidence for every claim (a command you ran + its real
  output) — not a bare assertion. A separate, non-agent process handles publishing your work for
  human review. If you find nothing this run, write findings.md saying so explicitly — never skip
  writing it.
- Stay inside this repo. Do not fetch external URLs, do not modify anything outside the repo root.
`.trim();

export const LANES = [
  {
    key: 'correctness',
    dayOfWeek: 1, // Monday
    title: 'Correctness — live-fire verification sweep',
    prompt: `${SAFETY_PREAMBLE}

Today's lane: CORRECTNESS. Pick 3-5 commands you have the least confidence in (check CHANGELOG.md
for what was recently touched, or what's never been live-fire tested before) and verify them
against the real GoHighLevel account the same way the 2026-07-05/06 sweep did: run the real
command, then independently verify the result via a SEPARATE method (a raw \`sizmo api\` read-back,
or a different command), never trusting sizmo's own success message alone. Fix anything broken,
with a regression test. Clean up every test entity you create except opportunities (no delete
command exists for those — leave them clearly named).`,
  },
  {
    key: 'feature-development',
    dayOfWeek: 2, // Tuesday
    title: 'Feature development — capability gaps surfaced by real use',
    prompt: `${SAFETY_PREAMBLE}

Today's lane: FEATURE DEVELOPMENT. Look for a capability gap surfaced by actually USING the CLI,
not a speculative feature. Known example not yet built: \`sizmo calendar create\` has no
--team-member flag, so a round_robin calendar can't be created at all (GHL rejects it with "No
team member found"). Find one gap like that — grep CHANGELOG.md and README.md "Honest limitations"
for hints — and either build it (small, scoped, tested) or write up exactly what's missing and why
it matters if it's too large for one run.`,
  },
  {
    key: 'distribution-dx',
    dayOfWeek: 3, // Wednesday
    title: 'Distribution / DX — the actual adoption bottleneck',
    prompt: `${SAFETY_PREAMBLE}

Today's lane: DISTRIBUTION / DX. This CLI has real npm downloads but almost no GitHub engagement
(stars/issues) — discovery, not the product, is the bottleneck. Work on ONE concrete thing:
an AGENTS.md file for Codex/Cursor parity with SKILL.md, a demo asciinema/GIF for the README, or a
README section that's gone stale vs. what the CLI actually does now. Do not touch anything that
requires publishing (no npm/GitHub release) — docs and repo content only.`,
  },
  {
    key: 'docs-hygiene',
    dayOfWeek: 4, // Thursday
    title: 'Docs / test hygiene',
    prompt: `${SAFETY_PREAMBLE}

Today's lane: DOCS / TEST HYGIENE. Find one real gap: a doc that contradicts the current code
(grep for stale version numbers, removed flags, renamed commands), or a code path with zero test
coverage (check what "sizmo api --no-loc" looked like before it had a regression test — that
pattern). Fix it. Small and correct beats broad and shallow here.`,
  },
];

export function laneForDate(date) {
  const dow = date.getDay(); // 0=Sun..6=Sat
  return LANES.find(l => l.dayOfWeek === dow) ?? null;
}

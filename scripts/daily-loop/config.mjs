// scripts/daily-loop/config.mjs — lane rotation + prompts for the recurring engineering loop.
//
// 7 lanes, one per day. Was Mon–Thu only ("nothing to review over the weekend"), but PRs open as
// drafts and simply queue, so idle days were pure lost throughput — 3 of every 7 days produced
// nothing. Weekend lanes are the ones that benefit most from nobody waiting on them: coverage
// backlog, induced failure paths, and claim verification.
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
const SAFE_WRITE_CMDS = ['contact', 'tag', 'note', 'field', 'value', 'calendar', 'business', 'opp', 'link'];

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
  and safe to leave behind: contact create/upsert/delete, tag, note, field/value/calendar/business/
  link create+delete, opp create/move/update/delete.
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
with a regression test. Clean up every test entity you create, including opportunities — \`sizmo
opp delete <oppId>\` exists, use it.`,
  },
  {
    key: 'feature-development',
    dayOfWeek: 2, // Tuesday
    // Opus: the only lane whose job is to SEARCH for something nobody has named yet. Every other
    // lane is enumeration (diff A against B), which sonnet does well and cheaply. Evidence this
    // lane specifically needs the upgrade: the 07-21 run couldn't find its own gap and built the
    // example from its prompt instead.
    model: 'opus',
    title: 'Feature development — capability gaps surfaced by real use',
    prompt: `${SAFETY_PREAMBLE}

Today's lane: FEATURE DEVELOPMENT. Look for a capability gap surfaced by actually USING the CLI,
not a speculative feature.

Do NOT treat any example in this prompt as your assignment — find a gap yourself. (A prior run
named \`calendar create --team-member\` here as an illustration and the agent simply built that
instead of looking; it shipped in v2.4.9 and is DONE. Illustrations are the shape to look for,
never the task.)

The shape: a command that cannot express something GHL's API supports, so a real workflow is
impossible through the CLI — not merely inconvenient. Find one by reading source rather than docs:
compare a command's flag list in \`commands/*.mjs\` against the request body the GHL endpoint
actually accepts, and look for fields with no flag. \`sizmo schema\` and \`sizmo api\` let you
check the real endpoint shape. Cross-check CHANGELOG.md and README.md "Honest limitations" only to
confirm it isn't already known/shipped.

Build it (small, scoped, tested), or if too large for one run, write up exactly what's missing,
what it blocks, and the endpoint evidence.`,
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
  {
    key: 'test-coverage',
    dayOfWeek: 5, // Friday
    title: 'Test coverage — the named untested backlog',
    prompt: `${SAFETY_PREAMBLE}

Today's lane: TEST COVERAGE. There is a known, concrete backlog — the 2026-07-16 run enumerated
every command against its test file and found these still at zero coverage: \`commands/surveys.mjs\`,
\`commands/transactions.mjs\`, \`commands/business.mjs\`. Re-run that enumeration yourself first
(list \`commands/*.mjs\`, list \`test/commands/*.test.mjs\`, subtract) — the backlog may have moved.

Pick the ONE remaining untested command with the highest branch count and write real tests for it,
following \`test/commands/forms.test.mjs\` as the pattern (in-process \`makeFakeCtx\`, no new mocking
library, one test per distinct branch including every HTTP error status the command handles).
Run the full suite and report the real before/after counts. If everything is covered, say so
explicitly in findings.md and instead deepen the weakest existing test file — but only after
showing the enumeration that proves coverage is complete.`,
  },
  {
    key: 'failure-paths',
    dayOfWeek: 6, // Saturday
    title: 'Failure paths — what happens when things go wrong',
    prompt: `${SAFETY_PREAMBLE}

Today's lane: FAILURE PATHS. Every other lane exercises the happy path. This one asks what a real
user sees when something breaks, which is where a CLI earns or loses trust.

Pick ONE area and go deep: bad/missing arguments, an expired or wrong-scope PIT, a network failure
mid-command, a malformed GHL response, or an entity id that doesn't exist. Actually induce the
failure (a deliberately bad id, a nonsense flag, \`sizmo api\` against a wrong path) and read what
the user gets. Judge it against three things: is the exit code right, does the message say what to
DO next rather than just what broke, and does it leak anything it shouldn't (tokens, raw stack
traces, internal paths). Fix the worst one you find, with a regression test.

Do not invent failures the code cannot actually produce — induce it for real or don't report it.`,
  },
  {
    key: 'claim-verification',
    dayOfWeek: 0, // Sunday
    title: 'Claim verification — does the repo tell the truth about itself',
    prompt: `${SAFETY_PREAMBLE}

Today's lane: CLAIM VERIFICATION. This repo makes explicit promises about itself in README.md,
SECURITY.md, SKILL.md, AGENTS.md and CHANGELOG.md — zero runtime dependencies, the PIT never
appears in argv, money never moves, writes are confirm-gated, no telemetry beyond the npm update
check. This has been a repeated real failure class here: SKILL.md once documented flag syntax that
never existed and an \`invoice void\` command that was never built.

Pick 3-5 specific, falsifiable claims and verify each one against actual code — the grep or command
that proves it, with its real output pasted in findings.md. A claim you cannot prove from source is
a finding, whether the fix is correcting the code or correcting the doc. Say which one you chose
and why.

Prefer claims where being wrong would matter to a stranger deciding whether to trust this tool with
a live CRM token. Do NOT rewrite docs wholesale — this lane is verification, and each change must
trace to a specific claim you disproved.`,
  },
];

export function laneForDate(date) {
  const dow = date.getDay(); // 0=Sun..6=Sat
  return LANES.find(l => l.dayOfWeek === dow) ?? null;
}

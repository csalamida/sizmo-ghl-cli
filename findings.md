# findings — 2026-10-28 — distribution/dx: llms.txt drift + permanent guard

## Lane

Distribution/DX. The brief: npm downloads exist, GitHub engagement doesn't — discovery is the
bottleneck, not the product. `llms.txt` is the file built specifically for AI-driven discovery
(the `/llms.txt` convention answer engines and LLM tools read to learn a CLI's surface) — exactly
the audience this lane is about. It had drifted and nothing was checking it.

## What was wrong

`SKILL.md`, `AGENTS.md` and `README.md` are mechanically guarded against drift by
`test/docs/agent-docs-drift.test.mjs` (command coverage + per-command flag validity, cross-checked
against each other). `llms.txt` was never wired into that test at all, and it had drifted:

Commands completely absent from `llms.txt` before this change (real word-boundary search):

```
$ grep -n "\b(ack|apply|calls|void)\b" llms.txt
65:Uses local model cache (0 API calls except `sizmo list values` which is always live).
```

(The one hit is `calls` inside the word "local" — a false positive, not the `calls` command.
Zero real matches for `ack`, `apply`, `calls`, or `void`.)

- `sizmo ack` — exists in `commands/ack.mjs`, documented in SKILL.md and AGENTS.md since 2026-07-27. Missing from llms.txt entirely.
- `sizmo apply` — shipped in 3.3.0 (2026-08-11), the newest command in the CLI. Fully documented in README/AGENTS/SKILL. Missing from llms.txt entirely.
- `sizmo calls` — exists in `commands/calls.mjs` (Voice AI call reporting). Missing from llms.txt entirely.
- `sizmo invoice void` — a subcommand of `invoice`, documented everywhere else since 2026-09-06. Missing from llms.txt (only `draft`/`send` were shown).

Verified against source before fixing:

```
$ ls commands/ | grep -E "^(ack|apply|calls)\.mjs$"
ack.mjs
apply.mjs
calls.mjs

$ grep -n "SUBCOMMANDS" commands/invoice.mjs
26:const SUBCOMMANDS = ['list', 'draft', 'send', 'void'];
```

## What was fixed

1. **`llms.txt`** — added `sizmo calls`, `sizmo ack` (+ `--list`) to the Read Commands section,
   `sizmo invoice void` and `sizmo apply` to the Write Commands section. Descriptions pulled from
   each command's own `meta.summary` in source, not invented.

2. **`test/docs/agent-docs-drift.test.mjs`** — wired `llms.txt` into the same mechanical guard
   README already has, so this can't drift silently again:
   - `llms.txt documents every command` (same word-boundary coverage check as SKILL/AGENTS/README)
   - `llms.txt: every flag in a shell example is valid FOR THAT COMMAND` (same per-command flag
     validity check — catches a documented flag that doesn't exist, or exists on a different
     command)
   - extended the final cross-surface test from "all three doc surfaces agree" to "all four,"
     adding `llms.txt` to the comparison set

## Proof

Full suite green before touching anything (baseline):

```
$ node --test --test-concurrency=1 2>&1 | tail -8
# tests 1263
# pass 1263
# fail 0
```

New test correctly RED against the old (unfixed) `llms.txt` — confirmed the guard isn't vacuous by
temporarily swapping in the pre-fix content and re-running:

```
not ok 12 - llms.txt documents every command
  error: "Commands absent from llms.txt: ack, apply. ..."
not ok 15 - all four doc surfaces agree on which commands exist
```

Full suite green after the fix + restoring the corrected `llms.txt`:

```
$ node --test --test-concurrency=1 2>&1 | tail -8
# tests 1265
# pass 1265
# fail 0
```

(1265 = 1263 original + 2 new llms.txt-specific tests.)

## Diff scope

```
$ git diff --stat
 llms.txt                            |  7 ++++++
 test/docs/agent-docs-drift.test.mjs | 47 +++++++++++++++++++++++++++++++++++--
 2 files changed, 52 insertions(+), 2 deletions(-)
```

Only these two files changed. No version bump, no publish, no release artifacts touched.

## Note on this file

`findings.md` in the repo root was stale leftover content from a 2026-08-05 run (committed in an
earlier daily-loop PR, `dcbfc31`). This overwrites it with today's run. If the publishing process
expects findings.md to be diffed/reviewed per-run rather than carried in git history, consider not
committing this file going forward — otherwise each day's findings overwrites the last with no
trace unless someone checks `git log -- findings.md`.

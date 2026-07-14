# Daily Loop — Distribution / DX
**Date:** 2026-07-15
**Branch:** daily-loop/2026-07-14-distribution-dx
**Lane:** DISTRIBUTION / DX

---

## What was done

Created `AGENTS.md` and updated `README.md`'s agent-onboarding section.

---

## Problem identified

The README told Codex/Cursor users to "paste SKILL.md into the agent's context". That's a manual
step — and it's wrong now. Codex automatically checks `AGENTS.md` at the repo root (standard
convention since mid-2025). No `AGENTS.md` existed, so Codex users got zero automatic context.
Cursor users had no standard path either.

---

## Change 1: Created `AGENTS.md`

**File:** `AGENTS.md` (new, 165 lines)

Content mirrors `SKILL.md` but:
- No Claude Code frontmatter (`---\nname/description\n---`)
- Broader read-command table (added `triage`, `receivables`, `noshow`, `booked-not-paid`, `focus`,
  `snapshot`, `crm`, `forms`, `surveys`, `transactions` — all present in the CLI, missing from
  SKILL.md's read-command list)
- Same write commands, same safety rules, same exit codes, same JSON envelope docs
- Explicit "Calling Pattern for Agents" section with multi-step pattern (resolve IDs first, then
  write) — makes it easier for a Codex/Cursor agent to chain commands without hallucinating IDs

**Evidence:**
```
$ ls AGENTS.md
AGENTS.md

$ wc -l AGENTS.md
165 AGENTS.md
```

No code changed. No commands ran against GHL. Docs-only.

---

## Change 2: Updated README `## Driving sizmo with an AI agent` section

**File:** `README.md` (lines ~416-420)

**Before (exact text removed):**
```
**Codex, Cursor, or any other coding agent:** `SKILL.md` is plain markdown — no Claude-specific
format. Paste it into the agent's context (system prompt, project instructions file, or just tell
it to read `SKILL.md` in this repo) and it works the same way: the agent knows every command,
every flag, the confirm-gate pattern, how to read the JSON envelope, and when to stop and ask
you before firing a write.

Either way, your agent will know every command, every flag, the confirm-gate pattern, how to read
the JSON envelope, and when to stop and ask the human before firing a write. No extra prompting
required.

If you update sizmo (new commands, changed flags), pull the repo and re-copy `SKILL.md` — the
skill tracks the CLI version.
```

**After (exact text added):**
```
**Codex, Cursor, or any other coding agent:** `AGENTS.md` in this repo is the same command
reference without Claude-specific frontmatter. Codex picks it up automatically from the repo
root; Cursor users can point their project instructions at it. No manual briefing needed.

If you cloned the repo, it's already there. If you're running via `npx sizmo`, copy it once:

    curl -fsSL https://raw.githubusercontent.com/csalamida/sizmo-ghl-cli/main/AGENTS.md > AGENTS.md

Either way, your agent will know every command, every flag, the confirm-gate pattern, how to
read the JSON envelope, and when to stop and ask the human before firing a write. No extra
prompting required.

If you update sizmo (new commands, changed flags), pull the repo — `AGENTS.md` and `SKILL.md`
both track the CLI version.
```

**Why:** The old text required a manual paste step and pointed at the wrong file for non-Claude
agents. The new text matches actual Codex/Cursor auto-load behavior.

---

## Files changed

| File | Change |
|------|--------|
| `AGENTS.md` | Created (new, 165 lines) |
| `README.md` | ~lines 416-429: Codex/Cursor onboarding instructions updated |

No code changes. No test changes. No package.json changes. No GHL API calls made this run.

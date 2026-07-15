# Daily Loop — Distribution / DX
**Date:** 2026-07-15
**Branch:** daily-loop/2026-07-15-distribution-dx
**Lane:** DISTRIBUTION / DX

---

## Prior run context (2026-07-14)

Yesterday's loop created `AGENTS.md` (245 lines) and updated the README agent-onboarding section
to point Codex/Cursor at `AGENTS.md` instead of requiring a manual paste of `SKILL.md`.

---

## Today's gap identified

`AGENTS.md` existed but had three concrete gaps vs the full README — all agent-DX-critical.

Cross-referenced `AGENTS.md` against `README.md` and the CLI source (`bin/sizmo.mjs`,
`lib/cli.mjs`, `lib/confirm.mjs`, `commands/reconcile.mjs`).

| Missing from AGENTS.md | In source | In README |
|------------------------|-----------|-----------|
| `sizmo reconcile` read command | `commands/reconcile.mjs` ✓ | README table row ✓ |
| `--dry-run` flag on writes | `lib/confirm.mjs:ctx.dryRun` ✓ | "How writes work" section ✓ |
| `--ndjson` streaming flag | `bin/sizmo.mjs:argv.includes('--ndjson')` ✓ | `--ndjson` section ✓ |
| `--fields a,b,c` projection flag | `lib/cli.mjs:--fields` ✓ | `--fields` section ✓ |
| `--fresh` / `--no-cache` | `lib/cli.mjs:--fresh/--no-cache` ✓ | global flags table ✓ |

`--ndjson` and `--fields` are labeled in the README as specifically designed for agent token
efficiency ("80-90% smaller payload"). Not being in `AGENTS.md` meant Codex/Cursor agents reading
only that file had no way to discover them — they'd over-fetch on every call.

---

## Evidence: flags confirmed in source

```
$ grep "dry-run\|dry_run" lib/confirm.mjs
// --dry-run → show but never execute, exit 0
ctx.out.data({ status: 'dry_run', command, changes, confirmCommand: rerunCommand });

$ grep "ndjson" bin/sizmo.mjs
if (!noUpdateFlag && !argv.includes('--json') && !argv.includes('--ndjson') ...

$ grep "dry-run\|ndjson\|fields\|fresh" lib/cli.mjs
// pull global --profile + --json + --fresh/--no-cache + --concise + --fields + --confirm + --dry-run

$ head -3 commands/reconcile.mjs
// commands/reconcile.mjs — Collected by source + status breakdown + flags.
export const meta = { name: 'reconcile', summary: 'Money reconciliation — collected by source...' }
```

---

## Changes made to AGENTS.md

**File:** `AGENTS.md`
**Before:** 245 lines
**After:** 283 lines (+38 lines)

### Change 1: `sizmo reconcile` added to Read Commands (line 70)

```
- `sizmo reconcile` — money reconciliation: collected by source, flags, recurring (`--days N`, `--top N`)
```

### Change 2: `--dry-run` note added to Write Commands preamble (lines 82-84)

```
Every write prints a preview and exits `5` (confirmation-required) without `--confirm`. Nothing fires
silently — safe to call without `--confirm` to preview first. Use `--dry-run` to print the change
description without executing and exit `0` (useful in scripts that only need to inspect the plan).
```

### Change 3: New "Global Flags" section added (lines 203-236)

Full flag table covering `--profile`, `--json`, `--ndjson`, `--fields`, `--concise`, `--fresh`,
`--no-cache`, `--dry-run`, `--confirm` — with two prose paragraphs explaining `--ndjson` streaming
and `--fields` token-lean behavior, plus runnable examples:

```sh
sizmo receivables --ndjson --fields name,due
# {"_meta":true,"command":"receivables","degraded":false,"warnings":[],"count":2,...}
# {"name":"Acme Co","due":5000}

sizmo receivables --json --fields name,due
sizmo triage --ndjson --fields name,lastReply
```

---

## Files changed

| File | Change |
|------|--------|
| `AGENTS.md` | +38 lines: `reconcile` in read cmds, `--dry-run` note in writes, new Global Flags section |

No code changes. No test changes. No package.json changes. No GHL API calls made this run.

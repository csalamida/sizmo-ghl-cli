# findings — 2026-07-22 — distribution/dx

## What was done

Brought `AGENTS.md` to parity with `SKILL.md` and the actual CLI source. Five targeted gaps fixed; no structural rewrites.

---

## Gaps found + evidence

### 1. `calendar create` missing `--team-member` flag

Source: `commands/calendar.mjs:15`
```
{ name: '--team-member', type: 'string', desc: 'comma-separated user IDs to assign (create) — required for round_robin/collective types' }
```
`calendar.mjs:40` enforces this: if `args.type` matches `round.robin|collective` and `teamMemberIds.length === 0`, the command aborts.

**Fix:** Added `[--team-member uid1,uid2]` to the `calendar create` line in AGENTS.md with a comment noting it is required for round_robin/collective types.

---

### 2. `sizmo business list` missing from AGENTS.md

Source: `commands/business.mjs:2,24,27`
```js
// sizmo business list  → list companies (from model cache)
const sub = parsed._?.[0] ?? 'list';
case 'list':   return listBusinesses(ctx);
```
Default subcommand is `list`. AGENTS.md had `business create` and `business delete` but not `list`.

**Fix:** Added `sizmo business list` as a read command (no `--confirm`) in the B2B block.

---

### 3. `send cancel` missing `email` channel

README (`README.md:166`):
```
sizmo send cancel <messageId> --channel sms|email
```
AGENTS.md showed only `--channel sms`.

**Fix:** Updated to `--channel sms|email`.

---

### 4. `send` email subject wording inconsistency

README: "email subject auto-generated from the message's first line — no separate `--subject` flag"
AGENTS.md: "# subject from first line"

**Fix:** Changed comment to "# subject auto-generated from first line".

---

### 5. `--no-update-check` missing from Global Flags

README (`README.md:256`):
```
--no-update-check    skip the once-a-day "newer version available" check for this run
```
Present in README, absent from AGENTS.md Global Flags section.

**Fix:** Added to AGENTS.md Global Flags block.

---

### 6. `ask` section — two examples + behavior details missing

SKILL.md and `commands/ask.mjs` document behavior that AGENTS.md was missing:

- Line 53 of ask.mjs: `// opp delete added 2026-07-08 — resolves via the same oppQuery`
- Lines 692-694: `if (confidence < 0.7) { ctx.out.line('Low confidence...') }`
- Line 18: `// Pronoun follow-ups ("her", ...) are resolved via a local-only placeholder`

Missing from AGENTS.md:
- `sizmo ask "delete Marco's stalled deal" --confirm` example
- `sizmo ask "create a trigger link for the black friday promo..."` example
- "Fires directly" vs "Resolve-and-print only" distinction
- Confidence threshold note (< 70% → asks to rephrase)
- Pronoun resolution detail (local cache, AI never sees real name)
- `docs/how-to/ask.md` reference

**Fix:** Added two examples, expanded `ask` section with the distinction table, confidence + pronoun notes, and docs reference.

---

## Files changed

- `AGENTS.md` — 5 gap areas fixed, ~25 lines added/modified. No structural rewrites. No new sections invented.

## Files NOT changed

- `SKILL.md` — no changes needed (it was the reference source)
- `README.md` — accurate as-is; no stale content actionable without a publish step
- All source files — read-only for evidence gathering

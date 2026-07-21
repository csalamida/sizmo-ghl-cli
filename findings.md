# findings — 2026-07-21 — feature-development

## Gap found

`sizmo calendar create --type round_robin` (and `--type collective`) fails at the GHL API with
"No team member found" (HTTP 422). The command had no flag to pass team members, so there was
no way to create these calendar types through the CLI. This was the known example called out
in the daily-loop prompt: "GHL rejects it with 'No team member found'".

Root cause: `commands/calendar.mjs` `createCalendar()` built the POST body with only
`locationId`, `name`, `calendarType`, and `slotDuration` — no `teamMembers` field, and no
flag in `meta.flags` to accept user IDs.

## What was built

Added `--team-member <userId,...>` flag to `sizmo calendar create`. Bumped to 2.4.9.

### Usage

```sh
# Find user IDs first
sizmo list users

# Create a round-robin calendar (--team-member required for this type)
sizmo calendar create --name "Sales RR" --type round_robin --team-member uid1,uid2

# Preview (no --confirm) shows team members in changes list:
#   Create calendar "Sales RR"
#     type: round_robin
#     team members: uid1, uid2
# Rerun with --confirm to execute.

sizmo calendar create --name "Sales RR" --type round_robin --team-member uid1,uid2 --confirm

# event / class_booking — flag optional, silently omitted if absent (no behavior change)
sizmo calendar create --name "Webinar" --type class_booking --confirm
```

GHL POST body receives: `teamMembers: [{ userId: "uid1" }, { userId: "uid2" }]`

### Early validation (new)

If `--type round_robin` or `--type collective` is passed without `--team-member`, USAGE error
is thrown immediately — no API call made:

```
calendar type "round_robin" requires at least one team member
  fix: sizmo list users  # find user ids, then add: --team-member uid1,uid2
```

### 422 hint (new)

If a request reaches GHL and comes back "No team member found" in the body, the API error
now carries a remediation hint pointing to `sizmo list users` and `--team-member`.

## Files changed

| File | Change |
|------|--------|
| `commands/calendar.mjs` | Added `--team-member` to meta.flags; parse, validate, and include in body |
| `test/commands/calendar.test.mjs` | 6 new tests (15 total, was 9) |
| `README.md` | Updated calendar create table row to show `--team-member` flag |
| `SKILL.md` | Updated cheatsheet with `--team-member` and requirement comment |
| `lib/cli.mjs` | Added round-robin example to COMMAND_EXAMPLES |
| `CHANGELOG.md` | Added [2.4.9] entry |
| `package.json` | Bumped version 2.4.8 → 2.4.9 |

## Evidence

Calendar tests (15 total, 6 new):

```
$ node --test test/commands/calendar.test.mjs 2>&1 | tail -8
1..15
# tests 15
# suites 0
# pass 15
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 42.970542
```

Full suite (606 total, no regressions from prior 600):

```
$ node --test --test-concurrency=1 2>&1 | tail -8
1..606
# tests 606
# suites 0
# pass 606
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3614.029167
```

No GHL API calls made this run. No test entities created.

# sizmo — Agent Reference

**Unofficial GoHighLevel CLI.** Zero dependencies. MIT. `npx sizmo` or `node bin/sizmo.mjs`.

This file is picked up automatically by Codex, Cursor, and other coding agents that check `AGENTS.md`
at the repo root. It is the complete command reference, safety rules, and confirm-gate pattern —
no extra prompting required.

Every command: `--json` (stable envelope) · `--profile <name>` (multi-client) · `--loc <id>` (override).

---

## Look Up IDs Before Running a Command

```bash
# Core CRM entities
sizmo list                     # grouped overview: all entity types + counts
sizmo list calendars           # Name | Calendar ID | Staff | Type
sizmo list pipelines           # Name | Pipeline ID, then Stage Name | Stage ID
sizmo list tags                # all tag names (used by name, not ID)
sizmo list fields              # Name | Field ID | Type | Model
sizmo list values              # Name | Value ID | current value  (live fetch)
sizmo list users               # Name | Email | User ID

# Content, commerce, B2B
sizmo list forms               # Name | Form ID
sizmo list surveys             # Name | Survey ID
sizmo list products            # Name | Product ID | Type
sizmo list links               # Name | Trigger Link ID
sizmo list businesses          # Name | Business ID | Website
sizmo list objects             # Label | Object Key | Field count
```

All pull from local model cache (0 API calls except `values` which is always live).
Run `sizmo sync` to refresh if data looks stale.

---

## The Core Loop (location-as-file)

```bash
sizmo export --out location.json          # snapshot: pipelines, calendars, fields, values, tags, users
sizmo diff location.json                  # compare snapshot vs live — see what changed
sizmo diff before.json after.json         # compare two snapshots
```

Diff output is plain English — no IDs, no JSON arrows:
```
Pipelines
  + Renewals
  ~ Sales  —  stages updated

Tags
  − cold-lead
```

---

## Read Commands (no confirmation, no risk)

- `sizmo brief` — morning screen: revenue at risk, unreplied threads, open opps. Start here.
- `sizmo pipeline` — pipeline health + stuck deals sweep (closest thing to "list open opportunities")
- `sizmo triage` — unreplied conversations by age
- `sizmo receivables` — overdue invoices + outstanding amounts
- `sizmo noshow` — no-shows from the last 30 days
- `sizmo booked-not-paid` — booked appointments with no associated invoice/payment
- `sizmo focus` — today's appointments + follow-up tasks
- `sizmo snapshot` — full brief as a single printable snapshot
- `sizmo segment --tag X` — find contacts by tag, phone, created-days, etc.
- `sizmo reconcile` — money reconciliation: collected by source, flags, recurring (`--days N`, `--top N`)
- `sizmo crm` — model overview: entity counts + cache age
- `sizmo export` — full location dump to JSON (deterministic, key-sorted, byte-identical re-exports)
- `sizmo diff <file> [file2]` — what changed between saved state and live, or two saved states
- `sizmo forms` / `sizmo surveys` — list + recent submissions
- `sizmo transactions` — last 25 payment transactions (`--top N`, `--type subscription`)

---

## Write Commands (all require `--confirm`)

Every write prints a preview and exits `5` (confirmation-required) without `--confirm`. Nothing fires
silently — safe to call without `--confirm` to preview first. Use `--dry-run` to print the change
description without executing and exit `0` (useful in scripts that only need to inspect the plan).

Every flag name below is verified against the actual source. If a flag ever looks wrong,
`sizmo help <command>` is the ground truth.

```bash
# Contacts
sizmo contact create --email a@b.co --name "Ana Cruz" --confirm
sizmo contact upsert --email a@b.co --name "Ana Cruz" --confirm   # de-dupes on email/phone; merges
                                                                    # tags with existing ones, never replaces
sizmo contact delete <id> --confirm

# Opportunities
sizmo opp create --name "Deal" --pipeline "Sales Pipeline" --stage "New Lead" --contact <id> --confirm
sizmo opp move <id> --stage "Won" --confirm
sizmo opp update <id> --value 5000 --status won --confirm
sizmo opp delete <id> --confirm

# Tags / Notes — flat commands, no subcommand
sizmo tag <contactId> --add vip --confirm
sizmo tag <contactId> --remove cold-lead --confirm
sizmo note <contactId> --text "Called, interested" --confirm

# Calendar / Appointments
sizmo calendar create --name "Discovery Calls" [--type --slot-min --team-member uid1,uid2] --confirm
# --team-member <comma-separated userIds> is required for round_robin / collective types
# (run `sizmo list users` first to find user IDs)
sizmo calendar delete <id> --confirm
sizmo appointment book --calendar "Discovery Calls" --contact <id> --start 2026-07-15T14:00:00Z --confirm
sizmo appointment cancel <apptId> --confirm
sizmo appointment note <apptId> --text "Confirmed reschedule" --confirm

# Custom Fields / Values — create + delete only, no update
sizmo field create --name "Coach Goal" [--type TEXT --model contact] --confirm
sizmo field delete <fieldId> --confirm
sizmo value create --name "Booking Link" --value "https://..." --confirm
sizmo value delete <valueId> --confirm

# Trigger Links — create + delete only, no update
sizmo link create --name "Black Friday Promo" --redirect-to "https://..." --confirm
sizmo link delete <linkId> --confirm

# Messaging — one flat command with --channel, not separate "send email"/"send sms"
sizmo send <contactId> --channel email --message "Hi there" --confirm   # subject auto-generated from first line
sizmo send <contactId> --channel sms --message "Hi there" --confirm
sizmo send cancel <messageId> --channel sms|email --confirm             # stop a scheduled message

# B2B companies
sizmo business list                                                      # list companies (from cache, no confirm)
sizmo business create --name "Acme" --website "https://..." --confirm
sizmo business delete <id> --confirm

# Invoices — draft/send only, there is no void/charge command
sizmo invoice draft --contact <id> --item "Session:5000" [--currency PHP --due 2026-08-01] --confirm
sizmo invoice send <invoiceId> --confirm
```

---

## Auth / Setup

```bash
sizmo init                                    # first-time guided wizard
sizmo config set --profile client1 --loc <locationId> --pit-stdin   # paste PIT — never argv
sizmo auth status                             # PIT age, source, active profile
sizmo doctor                                  # full health check + scope gaps
```

PIT lives at `~/.config/sizmo/profiles.json` (mode 0600). Never in argv, never committed.

---

## Safety Rules — Read Before Calling Any Write

1. **Confirm gate.** Every write previews + exits `5` without `--confirm`. Call without it to inspect
   first; add `--confirm` only when the preview is correct.
2. **No card-charging command exists.** GoHighLevel has no public endpoint for it.
   `invoice draft` creates a document; `invoice send` delivers a pay-link the customer acts on.
3. **Scope-is-the-gate.** Missing scope → clear error + the exact GHL settings path to fix it.
4. **`degraded: true` in JSON ≠ zero.** A data source was blocked. Read `warnings[]`. Never treat
   blocked as "no results."
5. **Deletion is single-target.** Every `delete` fetches + names the resource in the confirm preview,
   then deletes that one record by id. No `--all`, no wildcard.
6. **PIT never in argv.** Always pipe via stdin (`--pit-stdin`) or env var (`--pit-env VAR`).

---

## JSON Envelope

Every command supports `--json`. Shape is stable across minor/patch versions:

```json
{
  "schemaVersion": 1,
  "command": "brief",
  "location": "LOC_ID",
  "data": { ... },
  "degraded": false,
  "warnings": [],
  "cacheAgeMs": 0
}
```

`degraded: true` means at least one source was blocked. A blocked source is not zero — treat as unknown.

`init`, `auth`, and `config` are setup verbs — their `--json` output is purpose-specific, not the
`data`/`degraded`/`warnings` envelope. See `API-STABILITY.md` for the full contract.

---

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | OK |
| 1 | API error |
| 2 | Usage error (bad flag / unknown command) |
| 3 | Auth error / no location resolved |
| 4 | Not found (unknown pipeline/stage/calendar name) |
| 5 | Confirmation required — rerun with `--confirm` to execute |

---

## Global Flags (work with every command)

```
--profile <name>     use a named credential profile (or set SIZMO_PROFILE env var)
--json               machine-readable output — stable JSON envelope (see JSON Envelope section)
--ndjson             streaming machine output: one meta line + one JSON object per list item
--fields a,b,c       (with --json / --ndjson) keep only these keys per list item — trims payload
--concise            leaner payload — currently trims brief only
--fresh              bypass 60-second read cache — re-fetches live data
--no-cache           alias for --fresh
--no-update-check    skip the once-a-day "newer version available" check for this run
--dry-run            (write commands) print the change description without executing, exit 0
--confirm            (write commands) execute the previewed change
```

**`--ndjson` for streaming/agents.** Instead of one JSON array, emits a leading meta line (with
`command`, `location`, `degraded`, `warnings`, `count`) then one JSON object per list item —
process rows line-by-line without buffering. The `degraded` signal rides the meta line, never lost.

```sh
sizmo receivables --ndjson --fields name,due
# {"_meta":true,"command":"receivables","degraded":false,"warnings":[],"count":2,...}
# {"name":"Acme Co","due":5000}
# {"name":"Beta LLC","due":3000}
```

**`--fields` for token-lean payloads.** Projects each list item to only the named keys — often an
80-90% smaller payload. Works with `receivables`, `segment`, `triage`, `noshow`, `focus`, `crm`,
`brief`, and `pipeline`.

```sh
sizmo receivables --json --fields name,due    # just the two fields, full envelope
sizmo triage --ndjson --fields name,lastReply # stream, one object per contact, two keys
```

---

## Calling Pattern for Agents

Call one command per question. Use `--json` for structured output. Check the `degraded` flag before
trusting numbers. Never fire a write without the human triggering the `--confirm` step — that gate
is the human in the loop.

```bash
sizmo brief --json --profile acme           # structured morning readout
sizmo diff snapshot.json --json             # machine-readable diff result
sizmo pipeline --json                       # open opportunities + stuck deals
sizmo contact upsert --email x --json       # preview (exits 5) — add --confirm to fire
```

Multi-step pattern: run reads first to resolve names → IDs, then write with resolved IDs:
```bash
sizmo list pipelines --json                 # find pipeline + stage IDs
sizmo list calendars --json                 # find calendar ID by name
sizmo opp create --pipeline "Sales Pipeline" --stage "New Lead" --contact <id> --confirm
```

---

## Natural Language Interface (optional — requires AI key)

```bash
sizmo ask "brief"                                   # bare command name — no AI call at all
sizmo ask "who hasn't replied in 3 days"            # runs triage, shows real output
sizmo ask "tag Ana Cruz as follow-up"               # preview → exit 5
sizmo ask --confirm                                 # fires the previewed plan (no re-asking)
sizmo ask "tag Ana as follow-up and book her Friday at 2pm" --confirm  # two steps, one confirm
sizmo ask "delete Marco's stalled deal" --confirm   # opp delete — resolves by contact name
sizmo ask "create a trigger link for the black friday promo pointing to https://..." --confirm
```

Setup:
```bash
sizmo config set --profile <name> --ai-key "sk-ant-..." --ai-provider anthropic
sizmo config set --profile <name> --ai-key "sk-..." --ai-provider openai
```

`sizmo ask` resolves names live. A bare `--confirm` replays the cached plan exactly — it can't fire
something different from the preview. Confidence < 70% → asks to rephrase rather than guessing.
Pronoun follow-ups ("her", "that deal") resolve from a local cache; the AI only ever sees a
placeholder token, never the real name. Providers: `anthropic` (claude-haiku-4-5-20251001) · `openai` (gpt-4o-mini).

**Fires directly:** `tag`, `note`, `send`, `contact` (create/upsert/delete), `opp` (create/move/delete),
`value create`, `field` (create/delete), `calendar` (create/delete), `business` (create/delete), `link create`.

**Resolve-and-print only** (money + scheduling stay a deliberate manual step): `opp update`,
`appointment` (book/cancel/note), `send cancel`, `link delete`, `invoice` (draft/send).

Full walkthrough: `docs/how-to/ask.md`.

---

Built by Sizmo / CJ Salamida. Unofficial — not affiliated with HighLevel.
Repo: github.com/csalamida/sizmo-ghl-cli

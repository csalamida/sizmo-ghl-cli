---
name: sizmo-cli
description: Drive the sizmo GoHighLevel CLI — export location state, diff what changed, run the morning brief, and make confirm-gated writes. Use when working with any GHL location via the terminal or as an agent tool.
---

# sizmo CLI

Unofficial GoHighLevel CLI. Zero dependencies. MIT. `npx sizmo` or `node bin/sizmo.mjs`.

Every command: `--json` (stable envelope) · `--profile <name>` (multi-client) · `--loc <id>` (override).

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

## Read Commands (no confirmation, no risk)

- `sizmo brief` — morning screen: revenue at risk, unreplied threads, open opps. Start here.
- `sizmo pipeline` — pipeline health + stuck deals sweep (closest thing to "list open opportunities")
- `sizmo export` — full location dump to JSON (deterministic, key-sorted, byte-identical re-exports)
- `sizmo diff <file> [file2]` — what changed between saved state and live (or two saved states)
- `sizmo segment --tag X` — find contacts by criteria (tag, phone, created-days, etc.)

## Write Commands (all need `--confirm`)

Every flag name below is verified against the actual source, not assumed — a prior version of this
file had several fabricated ones (`tag add`, `--stage-id`, `send email <id> --subject`) that never
matched the real CLI. If a flag here ever looks wrong, `sizmo help <command>` is the ground truth.

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
# --team-member <comma-separated userIds> is REQUIRED for round_robin and collective types
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
sizmo send <contactId> --channel email --message "Hi there" --confirm   # subject auto-generated
sizmo send <contactId> --channel sms --message "Hi there" --confirm    # from the message's first line
sizmo send cancel <messageId> --channel sms --confirm                  # stop a scheduled message

# Invoices — draft/send only, there is no void/charge command
sizmo invoice draft --contact <id> --item "Session:5000" [--currency PHP --due 2026-08-01] --confirm
sizmo invoice send <invoiceId> --confirm
```

## Forms, Surveys, Transactions, B2B

```bash
# Forms & Surveys (read-only, submissions feed)
sizmo forms                            # list all forms
sizmo forms <formId>                   # recent submissions for this form (--top N)
sizmo surveys                          # list all surveys
sizmo surveys <surveyId>               # recent submissions (--top N)

# Transaction history (read-only — money never moves)
sizmo transactions                     # last 25 payment transactions
sizmo transactions --top 50 --type subscription  # filter by entityType
sizmo transactions --json              # machine-readable envelope

# B2B companies (confirm-gated writes)
sizmo business list                    # list companies (from cache)
sizmo business create --name "Acme" --website "https://..." --confirm
sizmo business delete <id> --confirm
```

## Auth

```bash
sizmo init                                    # first-time setup wizard
sizmo config set --profile client1 --loc <locationId> --pit-stdin   # paste PIT — never argv
sizmo auth status                             # PIT age, source, active profile
sizmo doctor                                  # full health check + scope gaps
```

PIT lives at `~/.config/sizmo/profiles.json` (mode 0600). Never in argv, never in env passed from outside, never committed.

## Safety Model

- **No card-charging command exists** — GoHighLevel exposes no public endpoint for it. `invoice draft`
  creates a document, `invoice send` delivers a pay-link the customer acts on; both confirm-gated.
- **Scope-is-the-gate (since 2.0)** — sizmo exposes only what your PIT's scopes + the public API
  allow; a missing scope → clear error + exact GHL settings path to fix it.
- **`degraded:true`** in JSON envelope ≠ zero — a source was blocked. Read `warnings[]`. Never treat blocked as "0".
- **Deletion is single-target, never bulk** — every `delete` fetches the resource first, names it in
  the confirm preview, then deletes that one record by id. No `--all`, no wildcard.
- **Exit codes:** `0` ok · `1` API error · `2` usage · `3` auth/no-location · `4` not found · `5` needs `--confirm`

## Natural Language Interface (optional — requires AI key)

```bash
sizmo ask "brief"                                   # bare command name — no AI call at all
sizmo ask "who hasn't replied in 3 days"            # runs triage, shows real output
sizmo ask "tag Ana Cruz as follow-up"                # preview → exit 5
sizmo ask --confirm                                  # fires the previewed plan (no re-asking the AI)
sizmo ask "tag Ana as follow-up and book her Friday at 2pm" --confirm  # two steps, one confirm
sizmo ask "delete Marco's stalled deal" --confirm    # opp delete — resolves by contact name
sizmo ask "create a trigger link for the black friday promo pointing to https://…" --confirm
```

Setup:
```bash
sizmo config set --profile <name> --ai-key "sk-ant-..." --ai-provider anthropic
sizmo config set --profile <name> --ai-key "sk-..." --ai-provider openai
```

Flow: intent → (bare command names skip the AI entirely) → LLM resolves one or more steps →
reads run immediately; writes preview + cache the resolved plan → a bare `--confirm` replays that
exact plan (never re-asks the AI, so it can't fire something different from the preview).
Confidence < 70% → asks to rephrase. Contact/opportunity names → auto-search → resolves to ID.
Pronoun follow-ups ("her") resolve from a local cache — the AI only ever sees a placeholder token.
Providers: `anthropic` (default, claude-haiku-4-5-20251001) · `openai` (gpt-4o-mini).

**Fires directly:** tag, note, send, contact (create/upsert/delete), opp (create/move/**delete**),
value (create), field (create/delete), calendar (create/delete), business (create/delete),
link (create). **Resolve-and-print only** (needs a bare id, or is money/scheduling that stays a
deliberate manual step): `opp update`, `appointment book/cancel/note`, `send cancel`, `link delete`,
`invoice draft/send`. Full walkthrough with examples: `docs/how-to/ask.md`.

## As an Agent Tool

Call one command per question. Use `--json` for structured output. Check `degraded` flag before trusting numbers. Never fire a write without the human at the keyboard triggering the `--confirm` step — that gate is the human in the loop.

```bash
sizmo brief --json --profile acme          # structured morning readout
sizmo diff snapshot.json --json            # machine-readable diff result
sizmo contact upsert --email x --json      # preview (exits 5) → add --confirm to fire
```

---
Built by Sizmo / CJ Salamida. Unofficial — not affiliated with HighLevel.
Repo: github.com/csalamida/sizmo-ghl-cli

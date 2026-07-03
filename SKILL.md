---
name: sizmo-cli
description: Drive the sizmo GoHighLevel CLI — export location state, diff what changed, run the morning brief, and make confirm-gated writes. Use when working with any GHL location via the terminal or as an agent tool.
---

# sizmo CLI — v2.2.0

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
- `sizmo export` — full location dump to JSON (deterministic, key-sorted, byte-identical re-exports)
- `sizmo diff <file> [file2]` — what changed between saved state and live (or two saved states)
- `sizmo contact search --email X` — find a contact
- `sizmo opp list` — open opportunities by pipeline

## Write Commands (all need `--confirm`)

```bash
# Contacts
sizmo contact create --email a@b.co --name "Ana Cruz" --confirm
sizmo contact upsert --email a@b.co --name "Ana Cruz" --confirm   # de-dupes on email/phone
sizmo contact delete <id> --confirm

# Opportunities
sizmo opp create --pipeline-id X --name "Deal" --confirm
sizmo opp move <id> --stage-id Y --confirm

# Tags / Notes
sizmo tag add <contactId> vip --confirm
sizmo note add <contactId> "Called, interested" --confirm

# Calendar
sizmo calendar create --name "Discovery Calls" --confirm
sizmo calendar delete <id> --confirm

# Custom Fields / Values
sizmo field create --name "Coach Goal" --type TEXT --confirm
sizmo value create --name "Booking Link" --value "https://..." --confirm
sizmo value update <id> --value "https://new..." --confirm

# Messaging
sizmo send email <contactId> --subject "Hi" --body "..." --confirm
sizmo send sms <contactId> --body "..." --confirm

# Invoices
sizmo invoice draft <contactId> --title "Session" --amount 5000 --confirm
sizmo invoice send <id> --confirm
# void = permanently locked out by design
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

PIT lives at `~/.config/ghl-auth/`. Never in argv, never in env passed from outside, never committed.

## Safety Model

- **Money never moves** — no charge/collect/refund endpoint in the CLI
- **Scope-is-the-gate** — missing PIT scope → clear error + exact GHL settings path to fix it
- **`degraded:true`** in JSON envelope ≠ zero — a source was blocked. Read `warnings[]`. Never treat blocked as "0".
- **Exit codes:** `0` ok · `1` API error · `2` usage · `3` auth/no-location · `4` not found · `5` needs `--confirm`

## Natural Language Interface (optional — requires AI key)

```bash
sizmo ask "who hasn't replied in 3 days"
sizmo ask "tag Ana Cruz as follow-up"
sizmo ask "move Website Package deal to Proposal Sent"
sizmo ask "show me stuck deals older than 2 weeks"
sizmo ask "send Marco a check-in SMS"           # shows preview → exit 5
sizmo ask "send Marco a check-in SMS" --confirm  # fires (never auto)
```

Setup:
```bash
sizmo config set --profile <name> --ai-key "sk-ant-..." --ai-provider anthropic
sizmo config set --profile <name> --ai-key "sk-..." --ai-provider openai
```

Flow: intent → LLM resolves → shows exact command → writes still need `--confirm`.
Reads execute immediately. Confidence < 70% → asks to rephrase. Contact names → auto-search → resolves to ID.
Providers: `anthropic` (default, claude-haiku-4-5-20251001) · `openai` (gpt-4o-mini).

## As an Agent Tool

Call one command per question. Use `--json` for structured output. Check `degraded` flag before trusting numbers. Never fire a write without CJ triggering the `--confirm` step — that gate is the human in the loop.

```bash
sizmo brief --json --profile acme          # structured morning readout
sizmo diff snapshot.json --json            # machine-readable diff result
sizmo contact upsert --email x --json      # preview (exits 5) → add --confirm to fire
```

---
Built by Sizmo / CJ Salamida. Unofficial — not affiliated with HighLevel.
Repo: github.com/csalamida07-cyber/sizmo-ghl-cli

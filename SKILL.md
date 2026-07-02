---
name: sizmo-cli
description: Drive the sizmo GoHighLevel CLI — export location state, diff what changed, run the morning brief, and make confirm-gated writes. Use when working with any GHL location via the terminal or as an agent tool.
---

# sizmo CLI — v2.2.0

Unofficial GoHighLevel CLI. Zero dependencies. MIT. `npx sizmo` or `node bin/sizmo.mjs`.

Every command: `--json` (stable envelope) · `--profile <name>` (multi-client) · `--loc <id>` (override).

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

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

# Find a contact when you only have a name, email, or phone — prints the id every write needs
sizmo contact find "Ana Cruz"            # fuzzy name match; returns top 10
sizmo contact find ana@example.com       # exact email lookup
sizmo contact find "ana" --limit 25      # up to 25 results
```

All pull from local model cache (0 API calls except `values` which is always live).
Run `sizmo sync` to refresh if data looks stale.

## The Core Loop (location-as-file)

```bash
sizmo export --out location.json          # snapshot: pipelines, calendars, fields, values, tags, users
sizmo diff location.json                  # compare snapshot vs live — see what changed
sizmo diff before.json after.json         # compare two snapshots
sizmo apply location.json                 # create what the file describes and this location lacks (additive; 3 of 6 groups)
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

- `sizmo brief` — morning screen: revenue at risk, unreplied threads, open opps. Start here. (`--format md|slack` to paste into Slack, email, or Notion)
- `sizmo focus` — one ranked to-do queue by money at stake (`--format md|slack`)
- `sizmo triage` — unreplied conversation sweep (who is waiting on a human)
- `sizmo pipeline` — pipeline health + stuck deals sweep (closest thing to "list open opportunities") (`--format md|slack`)
- `sizmo snapshot` — point-in-time state summary
- `sizmo export` — full location dump to JSON (deterministic, key-sorted, byte-identical re-exports)
- `sizmo apply <file>` — **confirm-gated, additive only.** Creates custom values, custom fields and calendars the file has and this location does not. Matches on NAME (not id), so it is idempotent across locations. It can never create pipelines, location tags or users — GoHighLevel has no API operation for those — and it says so in the preview rather than doing three sixths of the job silently. Never deletes, renames or updates.
- `sizmo diff <file> [file2]` — what changed between saved state and live (or two saved states)
- `sizmo segment --tag X` — find contacts by criteria (tag, phone, created-days, etc.)
- `sizmo crm` — query the local CRM model — counts, lists, staleness

Money surfaces (all read-only — money never moves from the CLI):

- `sizmo receivables` — A/R: who owes, how much, how old (`--format md|slack`)
- `sizmo booked-not-paid` — sessions with no invoice or payment (the money leak)
- `sizmo reconcile` — money reconciliation: collected by source, flags, recurring (`--format md|slack`)
- `sizmo noshow` — no-show recovery: who to re-book
- `sizmo contact find "<query>"` — find a contact by name/email/phone; prints the id every write needs (`--limit N`, default 10)
- `sizmo invoice list` — all invoices; `--status draft|sent|paid|void` to narrow; `--top N`
- `sizmo appointment list` — upcoming appointments (next 14 days default); `--days N` to look further ahead; `--top N`

Local queue state (never touches GoHighLevel — state lives in `~/.config/sizmo/memory/`):

- `sizmo ack <contactId>` — snooze a contact so they stop surfacing in `focus`/`brief`
- `sizmo ack --list` — every active snooze with its expiry (expired ones marked)
- `sizmo ack --clear <contactId>` — un-snooze; the item returns to the queue immediately
- Acked items are **hidden, not deleted**, and their count is always signalled in the
  `focus`/`brief` footer. Pass `--show-acked` to reveal them. If a contact you expect is
  missing from a queue, check here before concluding the data is wrong.

## Write Commands (all need `--confirm`)

Every flag name below is verified against the actual source, not assumed — a prior version of this
file had several fabricated ones (`tag add`, `--stage-id`, `send email <id> --subject`) that never
matched the real CLI. If a flag here ever looks wrong, `sizmo help <command>` is the ground truth.

```bash
# Contacts
sizmo contact create --email a@b.co --name "Ana Cruz" --confirm
sizmo contact upsert --email a@b.co --name "Ana Cruz" --confirm   # de-dupes on email/phone; merges
sizmo contact update <contactId> --email new@x.com --confirm    # edit a contact you have the ID for
#   update ≠ upsert: upsert MATCHES on email/phone; update targets a known id (every read gives you ids).
#   --tag is REFUSED on update — that endpoint overwrites the whole tag list. Use `sizmo tag` instead.
#   --no-dnd clears do-not-disturb; --company is not accepted (update endpoint has no companyName).
# provenance + ownership + compliance — create AND upsert both accept these:
#   --source "webinar-jul"     where the lead came from (without it every sizmo-created
#                              contact is indistinguishable from a manual entry)
#   --assigned-user <userId>   who owns it — `sizmo list users` for ids
#   --company "Acme"           --timezone Asia/Manila     --country PH
#   --dnd                      mark do-not-disturb. Use when importing an opted-out list —
#                              without it those contacts remain messageable.
                                                                    # tags with existing ones, never replaces
sizmo contact delete <id> --confirm

# Opportunities
sizmo opp create --name "Deal" --pipeline "Sales Pipeline" --stage "New Lead" --contact <id> --confirm
# --status open|won|lost|abandoned (default: open). Use won/lost when BACKFILLING historical
#   deals — otherwise every imported deal lands OPEN and inflates `sizmo pipeline` totals.
# --assigned-user <userId>  give the deal an owner (`sizmo list users` for ids)
sizmo opp move <id> --stage "Won" --confirm
sizmo opp update <id> --value 5000 --status won --confirm
# opp update also takes --name (rename) and --assigned-user <userId> (REASSIGN a deal —
#   previously only settable at creation, so handing a deal over meant using the GHL UI).
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
sizmo appointment update <apptId> --start 2026-08-02T14:00:00Z --end ...Z --confirm   # RESCHEDULE
sizmo appointment update <apptId> --status noshow --confirm     # mark the outcome after the call
#   --status: confirmed | showed | noshow | cancelled | invalid (no-show/no_show also accepted)
#   Rescheduling NOTIFIES the contact — --no-notify suppresses it.
#   `sizmo noshow` only REPORTS no-shows; this is how you record one.
# optional: --end (ISO, omit = calendar slot duration) · --title · --assigned-user <userId> · --address "Zoom"
# booking FIRES the location's automations (confirmation SMS/email, workflows) by default.
# --no-notify suppresses them — use it for backfills/migrations so contacts are not messaged.
sizmo appointment book --calendar "Discovery Calls" --contact <id> --start 2026-07-15T14:00:00Z \
  --end 2026-07-15T15:00:00Z --title "Strategy Call" --assigned-user <userId> --no-notify --confirm
sizmo appointment cancel <apptId> --confirm
sizmo appointment note <apptId> --text "Confirmed reschedule" --confirm

# Custom Fields — create, UPDATE and delete:
sizmo field update <fieldId> --name "Lead Source" --confirm
sizmo field update <fieldId> --placeholder "e.g. Google" --confirm   # keeps the existing name
#   --type CANNOT be changed on update and is refused — the endpoint takes no dataType,
#   because values already stored against the field would no longer match it.
#   Prefer update over delete+create: delete DISCARDS every value stored on every contact.
# Custom Values — create, UPDATE and delete:
sizmo value update <valueId> --value "https://new.link" --confirm   # keeps the existing name
sizmo value update <valueId> --name "New Name" --confirm            # keeps the existing value
#   Prefer update over delete+create: the id stays the same, so anything referencing it
#   keeps resolving. delete+create mints a new id and breaks those references.
sizmo field create --name "Coach Goal" [--type TEXT --model contact] --confirm
# --placeholder "..."  --position N
# FILE_UPLOAD: --accept ".pdf,.docx"  --multiple-files  --max-files N
# TEXTBOX_LIST: --textbox-option "Small,Medium,Large"  (REQUIRED for this type)
# SINGLE_OPTIONS / MULTIPLE_OPTIONS / RADIO / CHECKBOX are REFUSED — this endpoint takes no
#   choice list, so sizmo would create an empty unusable field. Make those in the GHL UI.
sizmo field delete <fieldId> --confirm
sizmo value create --name "Booking Link" --value "https://..." --confirm
sizmo value delete <valueId> --confirm

# Trigger Links — create + delete only, no update
sizmo link create --name "Black Friday Promo" --redirect-to "https://..." --confirm
sizmo link delete <linkId> --confirm

# Messaging — one flat command with --channel, not separate "send email"/"send sms"
sizmo send <contactId> --channel email --message "Hi there" --confirm   # subject auto-generated
sizmo send <contactId> --channel email --message "Hi" --subject "Q3 Invoice" --confirm
sizmo send <contactId> --channel sms --message "Reminder" --schedule 2026-08-01T09:00:00Z --confirm
# --schedule takes ISO 8601 and must be in the FUTURE. A scheduled send fires later with
#   nobody watching — call it back with `sizmo send cancel <messageId> --channel sms|email`.
# email bodies are HTML-escaped, so &, < and > in your text reach the recipient intact
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
sizmo business update <id> --city "Cebu" --confirm     # partial edit; only what you pass changes
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
sizmo ask "delete Marco's stalled deal"            # previews the exact deal, then:
sizmo ask --confirm                                 # ...fires it. Deletes NEVER go in one step.
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
value (create), field (create/delete), calendar (create/delete), business (create/update/delete),
link (create). **Resolve-and-print only** (needs a bare id, or is money/scheduling that stays a
deliberate manual step): `opp update`, `appointment book/cancel/note`, `send cancel`, `link delete`,
`invoice draft/send`. Full walkthrough with examples: `docs/how-to/ask.md`.

## As an Agent Tool

Call one command per question. Use `--json` for structured output. Check `degraded` flag before trusting numbers. Never fire a write without the human at the keyboard triggering the `--confirm` step — that gate is the human in the loop. A sentence typed WITH `--confirm` fires in one call for non-destructive writes (tag, note, book) — you are approving the sentence, not a preview. Anything DESTRUCTIVE (delete, cancel) refuses that shortcut: it previews the exact record and exits 5, so a second bare `sizmo ask --confirm` is required.

```bash
sizmo brief --json --profile acme          # structured morning readout
sizmo diff snapshot.json --json            # machine-readable diff result
sizmo contact upsert --email x --json      # preview (exits 5) → add --confirm to fire
```

---
Built by Sizmo / CJ Salamida. Unofficial — not affiliated with HighLevel.
Repo: github.com/csalamida/sizmo-ghl-cli

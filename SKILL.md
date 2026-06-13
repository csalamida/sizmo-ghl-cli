---
name: sizmo
description: Use to read a GoHighLevel location's state — leads, bookings, who's waiting, pipeline, A/R, money-leaks — via the read-only CLI. Never writes; money is always human-triggered.
---

# Driving the GoHighLevel Read-Only CLI

Read-only GoHighLevel ops. Every command takes `--json` (stable envelope: `{schemaVersion,command,location,data,degraded,warnings}`) and `--profile <name>` for multi-client. Run `sizmo schema` for the machine-readable command tree before composing.

## Recipes (the jobs)
- `sizmo brief` — the morning screen: numbers + prioritized "needs you today". Start here.
- `sizmo snapshot [days]` — 6-metric card (leads/bookings/show-rate/collected/reply-rate/pipeline).
- `sizmo triage --top N` — who's waiting on a reply, longest first.
- `sizmo pipeline --stuck-days N` — value by stage + stuck-deal sweep.
- `sizmo noshow --days N` — no-shows to re-book.
- `sizmo receivables` — who owes, how old, how much.
- `sizmo reconcile --days N` — money collected by source + flags.
- `sizmo booked-not-paid --days N` — sessions with no invoice/payment (the money leak).
- `sizmo segment --tag X --no-phone` — find contacts by criteria.

## Auth
`sizmo config set --profile <client> --loc <id> --pit-stdin` (paste PIT to stdin — never argv). `sizmo auth status` shows source + PIT age (rotate at 90d). `sizmo auth check` probes scopes.

## Gotchas
- READ-ONLY. The CLI never writes to GoHighLevel. To act (send, invoice, tag), the specialist agents draft; the human approves; money is always human-triggered.
- `degraded:true` in the envelope ≠ zero — a source was blocked (scope/auth). Read `warnings`. Never treat a blocked read as "0".
- Exit codes: 0 ok · 1 API · 2 usage · 3 auth/no-location · 4 not found. Branch on these.
- No location resolved → exit 3. Pass `--profile` or set `GHL_LOCATION_ID`; there is no default location.

---
Built by Sizmo — productized GHL systems for coaches & consultants. Unofficial; not affiliated with HighLevel.

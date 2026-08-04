# GHL Agent Fleet — project-local

Nine GoHighLevel specialist subagents, scoped to this repo (installed 2026-08-04). Each is a
standalone expert for one domain, not an automation builder:

| Agent | Domain |
|---|---|
| `ghl-contacts` | find, clean, segment leads and clients |
| `ghl-conversations` | triage messages, draft and send replies |
| `ghl-opportunities` | deals, stages, pipeline value |
| `ghl-calendars` | appointments, availability, no-shows |
| `ghl-invoices` | invoices and estimates |
| `ghl-payments` | orders, subscriptions, reconciliation |
| `ghl-objects` | custom objects and associations |
| `ghl-analytics` | leads, bookings, revenue, rates |
| `ghl-workflow` | authors native workflows (Firebase API — the only path that can) |

Canonical design: `claude-os/GHL-FLEET-DESIGN.md`. Level ladder is L1 SEE (read-only) → L4
unattended; the L4 track is deliberately paused. Money is never automatic at any level.

## Two dependencies, both real

**1. They are not functional right now.** Every agent declares `mcp__leadconnector-mcp__*` tools,
and that MCP server reports `! Needs authentication`. Verified 2026-08-04:

```
leadconnector-mcp        /mcp/v2            ! needs auth   <- what these agents declare
leadconnector-aqai       /mcp/v2            ! needs auth
leadconnector-anthropic  /mcp/anthropic/v2  ✔ connected
```

Re-authorizing needs an interactive session (`/mcp` or `claude mcp`). The connected server,
`leadconnector-anthropic`, is the newer multi-sub-account endpoint — but `list_locations` on it
returns `{"items":[]}`, so no sub-accounts are granted to it yet either. Multi-sub-account is
explicitly **out of scope for now** (owner decision, 2026-08-04).

**2. Eight of the nine read a protocol doc by absolute path:**

```
/Users/cjay1107/Desktop/clawd-local/Clawd Projects/claude-os/obsidian/reference/ghl-fleet-protocol.md
```

That doc is authoritative for confirm-tiers, the facade loop, partial-failure handling, handoffs and
the scope ceiling. It deliberately stays in claude-os: ten-plus vault files reference it (MEMORY.md,
_INDEX.md, six instincts, the timeline), so copying it here would create a second copy that drifts
from the first. The cost is that the path is machine-specific — a clone of this repo on another
machine will not resolve it. These files are not published to npm (`npm pack` contains zero
`.claude` entries), so the exposure is the GitHub repo only.

## Open decision: MCP or the CLI they now live inside

These agents reach GoHighLevel through MCP. They now sit inside a tested GHL CLI that reaches it
through a Private Integration Token — no MCP auth, 1153 passing tests, confirm gates, typed exit
codes and a stable JSON envelope already built.

Repointing them at `sizmo` commands instead of MCP calls would remove the auth blocker entirely and
let them inherit safety work that already exists. It is a rewrite of nine files, not a config change,
and it has not been decided. Until it is, these agents remain MCP-bound and blocked on dependency 1.

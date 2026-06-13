# brief — morning brief

## What it answers

"What needs my attention today?" Combines snapshot numbers, triage threads, no-shows, stuck deals, and unpaid invoices into a single ranked morning card. The NEEDS YOU TODAY section is ordered by money at stake — highest-value items first, unknown-value items below.

Start here every morning before opening GoHighLevel.

## Command

```sh
sizmo brief
sizmo brief --days 14          # widen the snapshot window to 14 days
sizmo brief --json             # machine-readable envelope
sizmo brief --profile myclient # target a specific credential profile
```

Flags (verified from `meta` in `commands/brief.mjs`):

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--days` | int | 7 | Snapshot window in days |

Global flags `--json`, `--profile`, `--fresh` also apply.

## How it works

`brief` fans out five sub-collects in parallel on the same HTTP client and rate-limit pool:

1. `snapshot` — 6 headline metrics
2. `triage` — unanswered conversation threads (lookback: 30d, cap: 100)
3. `noshow` — no-shows to re-book (lookback: 30d, cap: 100)
4. `pipeline` — stuck deals (threshold: 7d, cap: 100)
5. `receivables` — outstanding invoices (cap: 100)

Each sub-collect is wrapped in a fault-tolerant `safe()` — if one source is blocked (e.g. missing scope), it emits `degraded: true` in the envelope and shows a warning instead of crashing the brief.

NEEDS YOU TODAY is ranked by `rankActions` from `lib/prioritize.mjs` — the same ranker used by `focus`. Money-valued items (stuck deals, invoices) come first in descending dollar order; items with unknown value (waiting threads, no-shows) follow.

## Sample output shape (example — no live creds in this context)

```
╔════════════════════════════════════════════════════════════════╗
║  MORNING BRIEF — Monday, Jun 9                                 ║
║  loc LOC_XXXX  ·  read-only                                    ║
╚════════════════════════════════════════════════════════════════╝

  THE NUMBERS (last 7d)
  ────────────────────────────────────────────────────────────────
  New leads        12
  Bookings         8
  Show rate        75%
  Collected        ₱48,000
  Reply rate       83%
  Pipeline         ₱320,000

  NEEDS YOU TODAY
  ────────────────────────────────────────────────────────────────
  1. Juan dela Cruz — ₱25,000 invoice (21d overdue)  → sizmo receivables
  2. Maria Santos — stuck deal ₱18,000 (12d idle)    → sizmo pipeline
  3. (no-show) Carlo Reyes — 3d ago                  → sizmo noshow
  ...
```

*Sample shape only. Actual numbers depend on your GoHighLevel location data.*

## Notes

- `degraded: true` in the JSON envelope means at least one source was blocked. Check `warnings` for detail. Never treat a blocked source as zero.
- The `--days` flag affects only the snapshot window. Triage, noshow, pipeline, and receivables sub-collects use their own defaults (30d lookback for triage/noshow, 7d stuck threshold for pipeline).
- To drill into any item, run its recipe: `sizmo receivables`, `sizmo pipeline`, `sizmo triage`, etc.

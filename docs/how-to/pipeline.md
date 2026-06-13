# pipeline — pipeline health

## What it answers

"How much value is in each stage, and which deals are stuck?" Shows total opportunity value by pipeline stage plus a stuck-deal sweep listing deals that haven't moved in N days.

## Command

```sh
sizmo pipeline
sizmo pipeline --stuck-days 14     # flag deals idle for 14+ days
sizmo pipeline --top 20            # show top 20 stuck deals
sizmo pipeline --json
sizmo pipeline --profile myclient
```

Flags (verified from `meta` in `commands/pipeline.mjs`):

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--stuck-days` | int | 7 | Idle threshold in days |
| `--top` | int | 100 | Max stuck deals to show |

## How it works

Paginates all opportunities to completion before sorting. A deal is "stuck" when its last status change, stage change, or update timestamp is older than `--stuck-days`. The stuck sweep shows value, stage, and idle age per deal.

## Sample output shape (example — no live creds in this context)

```
  PIPELINE VALUE BY STAGE
  Discovery          ₱85,000   (4 deals)
  Proposal           ₱140,000  (3 deals)
  Closed Won         ₱32,000   (2 deals)

  STUCK DEALS (idle > 7d)
  1. Maria Santos      Proposal    ₱45,000    idle 12d
  2. Juan dela Cruz    Discovery   ₱22,000    idle 9d
```

*Sample shape only.*

## Notes

- GHL opportunity `monetaryValue` has no currency field — it inherits the pipeline configuration. The CLI renders the raw value; no currency conversion is performed.
- `--top N` caps the stuck-deal list. All opportunities are fetched before the cap is applied.
- A deal last touched via `lastStatusChangeAt`, `lastStageChangeAt`, `updatedAt`, `dateUpdated`, or `dateAdded` (in that priority order) — whichever is most recent.

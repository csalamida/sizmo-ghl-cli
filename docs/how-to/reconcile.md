# reconcile — money collected by source

## What it answers

"How much was collected, from which payment sources, and are there any flags?" Breaks down successful transactions by payment provider/source within a window. Also surfaces subscriptions and anomaly flags.

## Command

```sh
sizmo reconcile
sizmo reconcile --days 7       # last 7 days
sizmo reconcile --top 30       # show top 30 sources
sizmo reconcile --json
sizmo reconcile --profile myclient
```

Flags (verified from `meta` in `commands/reconcile.mjs`):

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--days` | int | 30 | Window in days |
| `--top` | int | 20 | Max source rows |

## How it works

Paginates both transactions and subscriptions to completion. Groups successful transactions by source (payment provider, entity source type, or charge snapshot provider — whichever is available). Per-currency totals are kept separate. Flags transactions that look anomalous (e.g. unusually large amounts, missing source attribution).

Successful statuses: `succeeded`, `success`, `paid`, `completed`, `captured`.

## Sample output shape (example — no live creds in this context)

```
  COLLECTED — last 30d

  SOURCE             PHP          COUNT
  stripe             ₱120,000     8
  manual             ₱45,000      3
  unknown            ₱8,000       1

  TOTAL: ₱173,000 (PHP)

  RECURRING SUBSCRIPTIONS: 4 active
```

*Sample shape only.*

## Notes

- The CLI never refunds, voids, or charges. Read-only.
- Per-currency totals are always separate — never cross-summed.
- Source attribution relies on GHL's `paymentProviderType`, `providerType`, `source`, or `entitySourceType` fields. Transactions without any of these show as `unknown`.
- `--days` window is applied to transaction date. Transactions outside the window are excluded.

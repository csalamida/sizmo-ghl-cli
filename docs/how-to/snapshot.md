# snapshot — 6-metric card

## What it answers

"How did the last N days look?" One-screen summary: new leads, bookings, show rate, collected revenue (per currency), conversation reply rate, and total pipeline value.

## Command

```sh
sizmo snapshot
sizmo snapshot --days 30       # 30-day window instead of 7
sizmo snapshot --json
sizmo snapshot --profile myclient
```

Flags (verified from `meta` in `commands/snapshot.mjs`):

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--days` | int | 7 | Window in days |

## Metrics

All six metrics are derived from live API reads. Each can appear as blocked (scope missing) in which case `degraded: true` is set and the value shows `⚠ can't see (reason)`.

| Metric | Source |
|--------|--------|
| New leads | Contacts created within window |
| Bookings | Calendar appointments created within window (all calendars) |
| Show rate | Attended / (Attended + No-show) within window |
| Collected | Sum of successful payment transactions within window, per currency |
| Reply rate | Conversations with an outbound message / total conversations with inbound activity |
| Pipeline | Sum of all open opportunity values across all pipelines |

## Sample output shape (example — no live creds in this context)

```
  New leads        12
  Bookings         8
  Show rate        75%
  Collected        ₱48,000
  Reply rate       83%
  Pipeline         ₱320,000
```

*Sample shape only. Actual values depend on your GoHighLevel location data.*

## Notes

- Revenue is tracked per currency — never cross-summed. If you have both PHP and USD transactions, each appears on its own line.
- Pipeline value uses GHL opportunity `monetaryValue`. GHL does not attach a currency field to individual opportunities — they inherit pipeline config. The CLI renders the value without conversion.
- Show rate requires `calendars.read` scope. If blocked, the metric shows degraded.

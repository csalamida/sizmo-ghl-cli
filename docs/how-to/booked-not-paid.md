# booked-not-paid — the money leak

## What it answers

"Who had a session but was never invoiced or never paid?" Cross-references calendar events (attended appointments) against invoices and payment transactions. Surfaces two buckets: contacts who were never invoiced, and contacts who were invoiced but never paid.

## Command

```sh
sizmo booked-not-paid
sizmo booked-not-paid --days 14    # last 14 days
sizmo booked-not-paid --top 20     # show up to 20 per bucket
sizmo booked-not-paid --json
sizmo booked-not-paid --profile myclient
```

Flags (verified from `meta` in `commands/booked-not-paid.mjs`):

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--days` | int | 30 | Session lookback window |
| `--top` | int | 15 | Max rows to show per bucket |

## How it works

1. Fetches all attended calendar events within the window (all calendars)
2. Fetches all invoices for contacts who had sessions
3. Paginates all payment transactions to completion (critical: the old single-page limit:100 missed paid contacts — this is fixed)
4. A contact is `neverBilled` if they have an attended session and no invoice at all
5. A contact is in `invoicedNotPaid` if they have an invoice in an unpaid status and no successful transaction

The transaction pagination is exhaustive to avoid false positives — a contact is only flagged as unpaid if ALL pages of their transactions confirm no successful payment.

**Known limitation:** Same calendar truncation issue as `noshow` — calendars returning >= 100 events may be silently truncated. `degraded: true` warning is emitted.

## Sample output shape (example — no live creds in this context)

```
  NEVER BILLED (had session, no invoice)
  1. Ana Lim           session 5d ago
  2. Bong Santos       session 8d ago

  INVOICED NOT PAID
  1. Juan dela Cruz    ₱25,000   invoice sent 21d ago
  2. Maria Santos      ₱12,000   invoice viewed 9d ago
```

*Sample shape only.*

## Notes

- The CLI never creates an invoice or charges a card. Use this list to identify the gap; action stays with you.
- `neverBilled` contacts show `estValue: 0` in JSON — the value is truly unknown until you decide what to charge.
- `--top N` caps each bucket independently. All events and transactions are fetched before the cap is applied.

# receivables — A/R who owes

## What it answers

"Who owes money, how much, and how old is the invoice?" Lists all outstanding invoices (status: sent, overdue, partially paid, payment processing, viewed, due) sorted by age descending.

## Command

```sh
sizmo receivables
sizmo receivables --top 30     # show up to 30 invoices
sizmo receivables --json
sizmo receivables --profile myclient
```

Flags (verified from `meta` in `commands/receivables.mjs`):

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--top` | int | 20 | Max rows to display |

## How it works

Paginates all invoices to completion (was previously offset-capped at 2000 — that bug is fixed). Filters to unpaid statuses. Per-currency totals are calculated separately — PHP, USD, EUR, GBP are never cross-summed.

Unpaid statuses: `sent`, `overdue`, `partially_paid`, `partially paid`, `payment_processing`, `viewed`, `due`.

## Sample output shape (example — no live creds in this context)

```
  A/R — outstanding invoices
  1. Juan dela Cruz     ₱25,000   21d   overdue
  2. Maria Santos       ₱18,000   14d   sent
  3. Carlo Reyes        ₱8,500    7d    viewed

  TOTAL: ₱51,500 (PHP)
```

*Sample shape only.*

## Notes

- The CLI never sends an invoice or charges a card. To follow up, use GoHighLevel's invoice tools or your approved agent workflow.
- Per-currency totals are always separated. If your location has both PHP and USD invoices, each currency totals independently.
- `--top N` caps the display list. All invoices are fetched before the cap is applied.

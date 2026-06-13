# focus — ranked to-do queue

## What it answers

"What's the single most important thing I should do right now, ordered by money?" Returns one unified list across all lanes — stuck deals, overdue invoices, never-billed sessions, unanswered threads, and no-shows — ranked by dollar value descending.

Use `focus` when you want the ranked queue without the brief's full morning card layout.

## Command

```sh
sizmo focus
sizmo focus --top 10           # show top 10 items
sizmo focus --stuck-days 14    # widen the stuck-deal threshold
sizmo focus --json
sizmo focus --profile myclient
```

Flags (verified from `meta` in `commands/focus.mjs`):

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--top` | int | 15 | Max items to display |
| `--stuck-days` | int | 7 | Idle threshold for stuck deals |

## How it works

Same five sub-collects as `brief`, same `rankActions` ranker from `lib/prioritize.mjs`. Output is a flat numbered list — no card headers, no sections. Designed to feed into automation or agent pipelines via `--json`.

## Sample output shape (example — no live creds in this context)

```
  1. Juan dela Cruz — invoice ₱25,000 (21d)      → sizmo receivables
  2. Maria Santos — stuck deal ₱18,000 (12d)     → sizmo pipeline
  3. (never billed) Carlo Reyes — session 5d ago → sizmo booked-not-paid
  4. Ana Reyes — waiting reply (8d)               → sizmo triage
  ...
```

*Sample shape only.*

## Notes

- Items with known monetary value (deals, invoices) rank above items with unknown value (threads, no-shows).
- `--stuck-days` affects how pipeline defines a "stuck" deal. A deal is stuck when it has had no stage change or status update in N days.
- Use `sizmo brief` if you want the morning card format with headline metrics. Use `focus` for a clean list.

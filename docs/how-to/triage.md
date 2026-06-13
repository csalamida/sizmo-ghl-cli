# triage — who's waiting on a reply

## What it answers

"Who has been waiting the longest for a response?" Surfaces conversation threads where the last message was inbound (from the contact) and no outbound reply has been sent, sorted by wait time descending.

## Command

```sh
sizmo triage
sizmo triage --top 20          # show top 20 threads
sizmo triage --days 14         # narrow lookback to 14 days
sizmo triage --json
sizmo triage --profile myclient
```

Flags (verified from `meta` in `commands/triage.mjs`):

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--top` | int | 10 | Max threads to show |
| `--days` | int | 30 | Lookback window |

## How it works

Paginates all conversations to completion (not capped at a single page) before applying `--top`, so the top N results are truly the longest-waiting — not just the first page. Each thread is examined for its last message direction. Threads where the last message was inbound and is older than the lookback threshold surface as waiting.

Channel labels: SMS, Email, Call, FB, IG, WhatsApp, GMB, Chat.

## Sample output shape (example — no live creds in this context)

```
  1. Maria Santos        SMS    waiting 8d    → reply or log
  2. Juan dela Cruz      Email  waiting 5d    → reply or log
  3. Carlo Reyes         WhatsApp waiting 3d  → reply or log
```

*Sample shape only.*

## Notes

- `--top N` caps the final sorted list, not the pagination. All pages are fetched before the cap is applied.
- The CLI never sends a reply. To act on a thread, use your GoHighLevel inbox or your approved agent workflow.
- `--days` filters the lookback window for which conversations are considered. Threads older than the window are excluded.

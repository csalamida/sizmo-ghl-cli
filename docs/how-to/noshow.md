# noshow — no-show recovery

## What it answers

"Who no-showed and hasn't been re-booked?" Lists contacts whose appointment status is `no-show` within the lookback window, so you can follow up and get them rescheduled.

## Command

```sh
sizmo noshow
sizmo noshow --days 14         # last 14 days
sizmo noshow --top 20          # show up to 20
sizmo noshow --json
sizmo noshow --profile myclient
```

Flags (verified from `meta` in `commands/noshow.mjs`):

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--days` | int | 30 | Lookback window |
| `--top` | int | 15 | Max results |

## How it works

Fetches all calendars for the location, then fetches events for each calendar within the window. Events with status `no-show` are collected, deduplicated by contact, and sorted by most recent occurrence.

**Known limitation:** GHL's `/calendars/events` endpoint does not support cursor-based pagination. If a calendar returns >= 100 events the result may be silently truncated. The CLI emits `degraded: true` with a warning when this threshold is hit. Full fix (date-window splitting) is tracked as a follow-up.

## Sample output shape (example — no live creds in this context)

```
  NO-SHOWS (last 30d)
  1. Carlo Reyes       3d ago    Calendar: Consultation
  2. Ana Lim           8d ago    Calendar: Strategy Call
  3. Bong Santos       12d ago   Calendar: Consultation
```

*Sample shape only.*

## Notes

- The CLI never sends a message or re-books the appointment. Use this list to identify who to contact; the action stays with you.
- If `degraded: true` appears in `--json` output, at least one calendar was truncated or blocked. The list is incomplete.
- Contacts may appear once per no-show event. If someone no-showed twice, they may appear twice.

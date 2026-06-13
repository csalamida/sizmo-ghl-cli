# sizmo

**Unofficial read-only GoHighLevel CLI for coaches and consultants.**

> Not affiliated with, endorsed by, or supported by HighLevel. This is an independent open-source tool.

`sizmo` reads your GoHighLevel location — leads, bookings, pipeline, A/R, money leaks — from the terminal. It never writes, never charges, never sends. Every outward action stays human-triggered.

## Install

Requires Node.js 20+.

**Option A — clone + install (puts `sizmo` on your PATH):**

```sh
git clone https://github.com/csalamida07-cyber/sizmo-ghl-cli
cd sizmo-ghl-cli
bash install.sh
```

`install.sh` symlinks `bin/sizmo.mjs` into `~/.local/bin/sizmo`. Add `~/.local/bin` to `$PATH` if not already present (the script will warn you if needed).

**Option B — run with no install, straight from GitHub:**

```sh
npx github:csalamida07-cyber/sizmo-ghl-cli brief
```

**Option C — clone + run directly:**

```sh
git clone https://github.com/csalamida07-cyber/sizmo-ghl-cli && cd sizmo-ghl-cli
node bin/sizmo.mjs brief
```

> `npx sizmo` (npm install) is coming once the package is published to npm.

Then configure a profile:

```sh
echo "pit-yourtoken..." | sizmo config set --profile myclient --loc YOUR_LOCATION_ID --pit-stdin
```

PIT = Private Integration Token. Find it under GoHighLevel Settings > Integrations > Private Integrations. Never pass it as a command-line argument — always pipe it via stdin.

Verify auth:

```sh
sizmo auth status
sizmo auth check
```

## Commands

Command list generated from `sizmo schema` (authoritative — pulled directly from the code):

| Command | Summary | Key flags |
|---------|---------|-----------|
| `sizmo brief` | Morning brief — numbers + NEEDS YOU TODAY | `--days N` (default 7) |
| `sizmo snapshot` | Monday card — 6 metrics, one screen | `--days N` (default 7) |
| `sizmo triage` | Who is waiting on a reply, longest first | `--top N` (default 10), `--days N` (default 30) |
| `sizmo pipeline` | Pipeline health — value by stage + stuck deal sweep | `--stuck-days N` (default 7), `--top N` (default 100) |
| `sizmo noshow` | No-show recovery — who to re-book | `--days N` (default 30), `--top N` (default 15) |
| `sizmo receivables` | A/R — who owes, how much, how old | `--top N` (default 20) |
| `sizmo reconcile` | Money reconciliation — collected by source, flags, recurring | `--days N` (default 30), `--top N` (default 20) |
| `sizmo booked-not-paid` | Sessions with no invoice or payment — the money leak | `--days N` (default 30), `--top N` (default 15) |
| `sizmo focus` | One ranked to-do queue by money at stake | `--top N` (default 15), `--stuck-days N` (default 7) |
| `sizmo segment` | Find contacts by criteria — tag, phone, age, etc. | `--tag X`, `--without-tag X`, `--no-tags`, `--created-days N`, `--has-phone`, `--no-phone`, `--top N` (default 20) |

### Utility commands

```sh
sizmo schema            # machine-readable command tree (JSON)
sizmo auth status       # show credential source, location, masked PIT, rotation age
sizmo auth check        # probe live API to verify PIT scopes
sizmo config list       # list all saved profiles
sizmo config use <name> # switch default profile
sizmo config set --profile <name> --loc <id> --pit-stdin
sizmo config rm <name>  # remove a profile
sizmo api /path         # raw GET escape hatch (--paginate --max-pages N)
```

### Global flags (work with every command)

```
--profile <name>   use a named credential profile
--json             machine-readable output (stable JSON envelope)
--fresh            bypass 60-second read cache — re-fetches live data
--no-cache         alias for --fresh
```

## JSON envelope

Every command supports `--json`. The envelope shape is stable:

```json
{
  "schemaVersion": 1,
  "command": "brief",
  "location": "LOC_ID",
  "data": { ... },
  "degraded": false,
  "warnings": [],
  "cacheAgeMs": 0
}
```

`degraded: true` means at least one data source was blocked (scope or auth). Read `warnings`. A blocked source is not zero — treat it as unknown.

## Read-only + safety promise

- **Never writes to GoHighLevel.** No contacts created, no messages sent, no invoices issued, no payments charged.
- **Money is always human-triggered.** The CLI reads; humans approve every action that has a dollar attached.
- **PIT never in argv.** Credentials are passed via stdin (`--pit-stdin`) or env var (`--pit-env VAR`). Never logged, never echoed raw.
- **60-second read cache.** Repeated calls within 60s return cached data. `cacheAgeMs` in the envelope tells you how old. Use `--fresh` to bypass.

## Honest limitations

- **Rate-limit cap: 5 concurrent requests.** The pool is capped at 5 to avoid hammering the GHL API.
- **Cache TTL: 60 seconds.** Stale data possible within that window. Use `--fresh` when you need live.
- **No-show / booked-not-paid calendar truncation.** GHL's `/calendars/events` endpoint has no pagination cursor. If a calendar returns >= 100 events the result may be silently truncated. A `degraded: true` warning is emitted in that case.
- **Pipeline currency.** GHL opportunity monetary values carry no currency field — they inherit pipeline config. The CLI renders them as-is; cross-currency totals are never summed.
- **No workflow writes.** This tool has no workflow-authoring capability. Workflow creation stays in GoHighLevel's UI.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | OK |
| 1 | API error |
| 2 | Usage error (bad flag / unknown command) |
| 3 | Auth error / no location resolved |
| 4 | Not found |

## Multi-client

```sh
sizmo config set --profile clientA --loc LOC_A --pit-stdin
sizmo config set --profile clientB --loc LOC_B --pit-stdin
sizmo brief --profile clientA
sizmo brief --profile clientB
```

See `docs/how-to/multi-client.md` for full workflow.

## License

MIT. See LICENSE.

---

Built by Sizmo — productized GHL systems for coaches & consultants. Unofficial; not affiliated with HighLevel.

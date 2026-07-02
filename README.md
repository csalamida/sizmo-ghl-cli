# sizmo

[![CI](https://github.com/csalamida/sizmo-ghl-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/csalamida/sizmo-ghl-cli/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/sizmo)](https://www.npmjs.com/package/sizmo)
[![zero deps](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)

**Unofficial GoHighLevel CLI — read your CRM and make confirm-gated, scope-gated changes from the terminal: only what your token allows.** Not affiliated with HighLevel.

> Not affiliated with, endorsed by, or supported by HighLevel. This is an independent open-source tool.

A full terminal interface to one GoHighLevel location — **read it, build it, bill it, safely tear it down.** Every write is **confirm-gated** (preview → `--confirm` → fire) and **scope-gated** (your PIT's scopes decide what's allowed). It never fabricates a number, and it can't pull money off a card — GoHighLevel exposes no such endpoint.

## What it does

| | Commands |
|---|---|
| **See** (read-only) | `brief` · `snapshot` · `triage` · `pipeline` · `receivables` · `reconcile` · `booked-not-paid` · `noshow` · `focus` · `segment` · `crm` |
| **Version** (read-only) | `export` (location → one diffable file) · `diff` (file vs live, or file vs file — *what changed?*) |
| **Act** | `tag` · `note` · `opp` (create/move/update) · `appointment` (book/cancel) · `send` (SMS/email) |
| **Build** | `contact create` · `contact upsert` (de-dupe) · `field create` · `value create` · `calendar create` |
| **Delete** (single-target, accident-proof) | `contact delete` · `field delete` · `value delete` · `calendar delete` |
| **Bill** (scope-gated) | `invoice draft` · `invoice send` (pay-link — *not* a card charge) |
| **Operate** | `init` · `doctor` · `open` · `completions` · `api` · multi-client profiles |

A human reads the pretty output; an agent consumes the stable `--json` / `--ndjson` underneath.

## Why sizmo

**sizmo is the CLI your AI agents drive GoHighLevel with — and the operator who supervises them.** Every command emits stable, token-lean JSON, so an agent calls **one command for one answer** instead of loading a whole MCP toolshelf to read a single field. A human gets the exact same data as a clean card.

Two things it does that nothing else in the ecosystem does:

- **Diff a location.** `sizmo export` turns a GoHighLevel location into one deterministic file; `sizmo diff` shows exactly what changed — or what a push *would* change. GHL snapshots are structurally incapable of this (the single loudest voted GHL fear is push-overwrite anxiety); a file is not. [See the 30-second demo →](examples/demo/)
- **Answer the Monday questions.** `sizmo brief` prints where money is leaking and who needs a reply today — and never invents a number to do it. A blocked data source is reported as *unknown*, never as zero.

Why not the tools you already have:

- **vs the GoHighLevel web UI** — the UI makes you click through six screens to assemble what `sizmo brief` prints in one. And it has no "money leaks" view — overdue receivables and booked-but-never-billed sessions are the numbers it won't surface for you.
- **vs the official GHL MCP server** — that's an OAuth-app install, multi-tenant, and read-leaning. `sizmo` is PIT-simple (paste one token, go), does confirm-gated *writes* too, and is **zero-dependency** — the whole tool is auditable in an afternoon (see [`SECURITY.md`](SECURITY.md)).
- **vs Zapier / Make** — those *automate tasks* on a trigger. `sizmo` *answers questions* for a human at a keyboard (and for the agent that human points at it). No per-task pricing, no data routed through a third party — it runs on your machine against your PIT.

It's also built to be piped: every command has a stable `--json` envelope ([`API-STABILITY.md`](API-STABILITY.md)), so a human reads the pretty output and their agent consumes the JSON underneath.

## Install

Requires Node.js 22+ (current Active LTS).

**Option A — npm (recommended):**

```sh
npx sizmo brief            # run with no install
# or install globally:
npm install -g sizmo
sizmo brief
```

**Option B — clone + install (puts `sizmo` on your PATH from source):**

```sh
git clone https://github.com/csalamida/sizmo-ghl-cli
cd sizmo-ghl-cli
bash install.sh
```

`install.sh` symlinks `bin/sizmo.mjs` into `~/.local/bin/sizmo`. Add `~/.local/bin` to `$PATH` if not already present (the script will warn you if needed).

**Option C — clone + run directly:**

```sh
git clone https://github.com/csalamida/sizmo-ghl-cli && cd sizmo-ghl-cli
node bin/sizmo.mjs brief
```

Then set up a profile. **Easiest — guided:**

```sh
sizmo init
```

`sizmo init` walks you through it: it prints the exact GoHighLevel path + the scope copy-block, takes your token from stdin (never argv), writes the profile, and runs `sizmo doctor` to confirm you're green — all in one run. Agent-drivable too: pipe the token in non-interactively.

```sh
echo "pit-yourtoken..." | sizmo init --profile myclient --loc YOUR_LOCATION_ID
```

**Manual alternative:**

```sh
echo "pit-yourtoken..." | sizmo config set --profile myclient --loc YOUR_LOCATION_ID --pit-stdin
```

PIT = Private Integration Token. Find it under GoHighLevel Settings > Integrations > Private Integrations. Never pass it as a command-line argument — always pipe it via stdin.

When creating the Private Integration, grant these scopes for the full `brief`:

```
contacts.readonly · conversations.readonly · opportunities.readonly
calendars.readonly · invoices.readonly · payments/transactions.readonly
```

For write commands (tag, note, opp, appointment, send), also add:

```
contacts.write · opportunities.write · calendars.write · conversations/message.write
```

Granting fewer is fine — missing scopes show as ⚠ in affected metrics rather than failing the whole command. Run `sizmo auth check` after setup to see a per-lane scope report.

**Auth: PIT vs MCP** — `sizmo` uses a Private Integration Token (PIT), not the GoHighLevel MCP server. See [`docs/how-to/auth-pit-vs-mcp.md`](docs/how-to/auth-pit-vs-mcp.md) for the comparison and when you'd want each.

Verify auth — or just run the one-shot health check:

```sh
sizmo doctor            # scopes + location + CRM model + version, one screen
sizmo auth status
sizmo auth check
```

`sizmo doctor` is the "is it me or the tool?" answer: it reports each scope (✓/⚠/✖ with the exact fix line for any blocked one), location reachability + latency, CRM-model freshness, and whether a newer `sizmo` is available — and it never reports green when a lane is blocked.

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
| `sizmo crm` | Query the local CRM model — counts, lists, staleness | `--all` (show all items) |
| `sizmo sync` | Refresh the local CRM model (pipelines, calendars, tags, fields, users, location) | `[entity]` (sync one) |
| `sizmo export` | Dump the location's structure to one deterministic, diffable file | `--out <file>` (else stdout) |
| `sizmo diff` | Compare an export against live, or two exports — what changed | `sizmo diff <file>` \| `sizmo diff <a> <b>` |

### Writes (confirm-gated)

These commands change data in GoHighLevel. Every write requires `--confirm`; without it the CLI prints the exact change + a rerun command and exits 5. Nothing fires silently. **The PIT scope is the gate** — a command only works if your token carries the scope; otherwise it fails with `AUTH` + the exact scope to add. sizmo cannot charge a card (GoHighLevel exposes no public endpoint for it); the money-side writes are draft/send an invoice.

| Command | Summary | Required flags | Scope needed |
|---------|---------|----------------|--------------|
| `sizmo tag <contactId> --add <tag>` | Add a tag to a contact | `--add` or `--remove` | `contacts.write` |
| `sizmo tag <contactId> --remove <tag>` | Remove a tag from a contact | `--add` or `--remove` | `contacts.write` |
| `sizmo note <contactId> --text "..."` | Add a note to a contact | `--text` | `contacts.write` |
| `sizmo opp create --name --pipeline --stage --contact` | Create a pipeline opportunity | `--name`, `--pipeline`, `--stage`, `--contact` | `opportunities.write` |
| `sizmo opp move <oppId> --stage <name>` | Move an opportunity to a stage | `--stage` | `opportunities.write` |
| `sizmo opp update <oppId> [--value --status]` | Update value or status of an opportunity | `--value` or `--status` | `opportunities.write` |
| `sizmo appointment book --calendar --contact --start` | Book an appointment | `--calendar`, `--contact`, `--start` | `calendars.write` |
| `sizmo appointment cancel <apptId>` | Cancel an appointment | apptId positional | `calendars.write` |
| `sizmo send <contactId> --channel sms\|email --message "..."` | Send an SMS or email | `--channel`, `--message` | `conversations/message.write` |

**Build / scaffold writes** — stand up a location from the terminal instead of clicking. The PIT scope is the gate: if your token carries the write scope, the command works; if not, it fails with `AUTH` + the exact scope to add.

| Command | Summary | Scope needed |
|---------|---------|--------------|
| `sizmo contact create [--email --phone --name --first --last --tag]` | Create a contact | `contacts.write` |
| `sizmo contact upsert --email\|--phone … [--name --tag]` | Create-or-update, de-duped on email/phone | `contacts.write` |
| `sizmo contact delete <contactId>` | Delete **one** contact by id | `contacts.write` |
| `sizmo field create --name "..." [--type TEXT --model contact]` | Create a custom field | `locations/customFields.write` |
| `sizmo field delete <fieldId>` | Delete **one** custom field by id | `locations/customFields.write` |
| `sizmo value create --name "..." --value "..."` | Create a custom value | `locations/customValues.write` |
| `sizmo value delete <valueId>` | Delete **one** custom value by id | `locations/customValues.write` |
| `sizmo calendar create --name "..." [--type --slot-min]` | Create a calendar | `calendars.write` |
| `sizmo calendar delete <calendarId>` | Delete **one** calendar by id | `calendars.write` |

**Deletion is single-target by design.** `delete` takes exactly **one id** — there is no `--all`, no
wildcard, no batch. Before it deletes, it **fetches the resource and shows you its name** in the
confirm preview (a wrong/nonexistent id → `NOTFOUND`, nothing touched), then deletes that one
resource by its id path. It is structurally incapable of the "I deleted one and it wiped them all"
accident.

**Money writes (scope-gated, since 2.0)** — only what the public API + your scope allow:

| Command | Summary | Scope needed |
|---------|---------|--------------|
| `sizmo invoice draft --contact <id> --item "Name:amount"` | Create a **draft** invoice (a document — not sent, no charge) | `invoices.write` |
| `sizmo invoice send <invoiceId>` | Send an invoice — delivers a **pay-link / text-to-pay** the customer acts on | `invoices.write` |

There is **no card-charging command** because GoHighLevel exposes no public endpoint for it. `draft`
creates a document; `send` requests payment. Both are confirm-gated. (Prior to 2.0 sizmo excluded all
money endpoints; 2.0 moved to "the PIT scope is the gate" — see `SECURITY.md` + `CHANGELOG.md`.)

**How writes work:**

```sh
# Step 1 — preview (no --confirm): prints change description + rerun command, exits 5
sizmo tag cid-001 --add VIP --json

# Step 2 — execute (with --confirm): fires the write, exits 0
sizmo tag cid-001 --add VIP --confirm

# --dry-run: shows change description without executing, exits 0
sizmo tag cid-001 --add VIP --dry-run
```

Pipeline/calendar names are resolved to IDs from the local CRM model. Run `sizmo sync` first if you've changed stages or calendars.

### Utility commands

```sh
sizmo init              # guided setup: scopes → token (stdin) → profile → doctor
sizmo doctor            # one-shot health: scopes, location, model, version
sizmo help <command>    # per-command help with runnable examples (also: sizmo <command> --help)
sizmo open <contactId>  # open a contact in the GoHighLevel web app (--opp · --url to just print)
sizmo completions zsh   # print a tab-completion script (bash too) — eval "$(sizmo completions zsh)"
sizmo schema            # machine-readable command tree (JSON)
sizmo auth status       # show credential source, location, masked PIT, rotation age
sizmo auth check        # probe live API to verify PIT scopes
sizmo config list       # list all saved profiles
sizmo config use <name> # switch default profile
sizmo config set --profile <name> --loc <id> --pit-stdin
sizmo config rm <name>  # remove a profile
sizmo api /path         # raw GET escape hatch (--paginate --max-pages N)
```

**Tab-completion** — add `eval "$(sizmo completions zsh)"` to your `~/.zshrc` (or `bash` → `~/.bashrc`)
and `sizmo <TAB>` completes commands; `sizmo brief --<TAB>` completes flags. Generated from the live
command tree, so it stays correct across upgrades.

**Act without retyping** — the people-focused recipes (`receivables`, `triage`, `noshow`,
`booked-not-paid`) print a ready-to-run `→ sizmo send …` / `→ sizmo open …` line under each row with
the real contact id. Copy, run. (Sends still require `--confirm`; sizmo can't charge a card — no public endpoint.)

### Global flags (work with every command)

```
--profile <name>     use a named credential profile (or set SIZMO_PROFILE)
--json               machine-readable output (stable JSON envelope)
--ndjson             machine-readable, streamed: one meta line + one JSON object per list item
--fields a,b,c       (with --json/--ndjson) keep only these keys on each list item — trims the payload
--concise            (with --json) leaner payload — currently trims `brief` only
--fresh              bypass 60-second read cache — re-fetches live data
--no-cache           alias for --fresh
--no-update-check    skip the once-a-day "newer version available" check for this run
```

**Profile via env.** `SIZMO_PROFILE=<name>` selects a saved profile without passing `--profile` on
every call (precedence: an explicit `--profile` flag > `SIZMO_PROFILE` > the saved default). Mirrors
`AWS_PROFILE` — handy for a per-client shell or a CI lane.

**Token-lean for agents.** `--fields` and `--concise` exist so an LLM driving sizmo pays for only
the data it needs. `sizmo receivables --json --fields name,due` returns just those two keys per row
instead of the full record — often an ~80–90% smaller payload. `--fields` projects the list in
`receivables`, `segment`, `triage`, `noshow`, `focus`, `crm`, `brief`, and `pipeline`;
`--concise` currently trims `brief` only. Both are read-from-the-shelf, pay-per-call ergonomics:
an agent that shells out to `sizmo … --json --fields …` carries one command, not a whole tool's
schema.

**`--ndjson` for streaming/agents.** Instead of one big JSON array, `--ndjson` emits a leading
**meta line** (carrying `command`, `location`, `degraded`, `warnings`, `count`, and every non-list
field under `data`) followed by **one JSON object per list item** — so an agent can process rows
line-by-line without buffering thousands of records, and the "this source was blocked / unknown"
signal is never dropped (it rides the meta line). A payload with no list (e.g. `doctor`) emits a
single envelope line. Combine with `--fields` to trim each row.

```sh
sizmo receivables --ndjson --fields name,due
# {"_meta":true,"schemaVersion":1,"command":"receivables","location":"L1","listKey":"list","count":2,"degraded":false,"warnings":[],"data":{...}}
# {"name":"Acme Co","due":5000}
# {"name":"Beta LLC","due":3000}
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

**Router verbs differ.** `init`, `auth`, and `config` are setup verbs, not data commands — their `--json` output is a purpose-specific object (e.g. `auth check` → `{ lanes, usable }`, `init` → `{ profile, location, ok, doctor }`), not the `data`/`degraded`/`warnings` envelope above. The data commands (brief, snapshot, doctor, …) all use the envelope.

Both contracts are frozen under semver — see [`API-STABILITY.md`](API-STABILITY.md) for exactly what you can depend on (exit codes, JSON shapes, `schemaVersion` policy, flag names) and what you can't (human output, stderr text, internal modules). The contract has held since 1.0 and is unchanged through 2.x — the 2.0 major bump was the money-policy guarantee, not the API.

## Staying up to date

`npx sizmo` always runs the latest published version. If you installed globally (`npm i -g sizmo`), the CLI checks npm **at most once a day** and prints a one-line nudge to stderr when a newer version exists:

```
⚠ sizmo 2.1.0 available (you have 2.0.0) — update: npm i -g sizmo@latest
```

`sizmo doctor` also shows a CLI VERSION line. The check is privacy-clean: a single GET of the public npm registry, cached 24h, never blocking, nothing sent about you. Turn it off with `--no-update-check` (per run) or the `NO_UPDATE_NOTIFIER` / `SIZMO_NO_UPDATE_CHECK` env vars. It never runs under `--json` or when output is piped.

## Your CRM model

`sizmo` caches the slow-changing structure of your CRM — pipelines + stages, calendars, tags, custom fields, users, and location — in a local file (`~/.config/sizmo/model/<locationId>.json`). Recipes read from this cache instead of re-fetching structure on every run.

**What it stores:** pipeline/stage names + IDs, calendar list, tag list, custom fields, user roster, and location info (timezone, currency, country). Structure only — no contacts, no conversations, no payments.

**Sync once, read fast.** The model is synced automatically on first use. After that, recipes use the cached copy. Run `sizmo sync` after you change your pipeline stages or add calendars:

```sh
sizmo sync                # full refresh (all 6 entities)
sizmo sync tags           # refresh one entity only
```

**Age is always shown.** `sizmo crm` shows how old each entity is. Stale entries (past TTL: 24h for pipelines/calendars/users/location; 12h for tags/fields) show a warning. The CLI never silently serves stale structure as current.

**Model never auto-syncs when stale.** It serves the cached data with a loud age banner. This avoids surprise network calls mid-recipe. Use `sizmo sync` or `--fresh` to force a refresh.

```sh
sizmo crm                 # overview: counts + age per entity
sizmo crm pipelines       # list pipelines + stages
sizmo crm calendars       # list calendars
sizmo crm tags [--all]    # list tags (truncated at 20 by default)
sizmo crm fields          # list custom fields
sizmo crm users           # list users
sizmo crm location        # timezone / currency / country
sizmo crm pipelines --json  # machine output with _meta.source/syncedAt/ageMs/stale
```

The JSON `_meta` block in every `crm` response lets agents branch on staleness without parsing prose:

```json
"_meta": { "source": "cache", "syncedAt": 1718000000000, "ageMs": 3600000, "stale": false, "offline": false }
```

**Scope requirements** for a full sync: `opportunities.readonly`, `calendars.readonly`, `locations/tags.readonly`, `locations/customFields.readonly`, `users.readonly`, `locations.readonly`. A 401/403 on one entity marks it blocked; the rest still store. `sizmo crm` shows `✖ needs <scope>` for blocked entities.

## Safety model

- **Reads are always free.** Read commands never change anything in GoHighLevel.
- **Writes require explicit `--confirm`.** Tag, note, opp, appointment, and send commands print the exact change + a rerun command and exit 5 (confirmation-required) without `--confirm`. Nothing fires silently — safe for agent use.
- **The PIT scope is the gate (since 2.0).** sizmo exposes only what your token's scopes + GoHighLevel's public API allow — a missing scope fails with `AUTH` + the fix. There is **no card-charging command** (no public endpoint exists); the money-side writes are draft/send an invoice, both confirm-gated. Reads never change anything.
- **`--dry-run` available on all writes.** Shows the change description without executing. Exits 0.
- **PIT never in argv.** Credentials are passed via stdin (`--pit-stdin`) or env var (`--pit-env VAR`). Never logged, never echoed raw.
- **60-second read cache.** Repeated calls within 60s return cached data. `cacheAgeMs` in the envelope tells you how old. Use `--fresh` to bypass.

Every claim above is verifiable — see [`SECURITY.md`](SECURITY.md) for the threat model, the self-audit recipes, and how to report a vulnerability. Zero runtime dependencies: what you read is what runs.

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
| 4 | Not found (unknown pipeline/stage/calendar name) |
| 5 | Confirmation required — rerun with `--confirm` to execute |

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

Built by [Sizmo](https://github.com/csalamida/sizmo-ghl-cli) — GHL CRM systems & automation. Unofficial; not affiliated with HighLevel.

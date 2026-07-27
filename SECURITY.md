# Security Policy

`sizmo` is an unofficial GoHighLevel CLI. It handles one sensitive thing — your **Private
Integration Token (PIT)** — and it talks to a live CRM. This document explains exactly what it
does with your credentials, and how to verify those claims yourself rather than take them on faith.

The whole tool has **zero runtime dependencies** — `package.json` has no `dependencies` field at
all, so there is no transitive tree to trust. Verify with `npm ls --omit=dev` (prints `(empty)`).
The attack surface is just the code in this repo; you can read all of `lib/` in an afternoon.

## Supported versions

Security fixes land on the **latest published minor** on npm. Run a current version:

```sh
npm install -g sizmo@latest   # or: npx sizmo@latest
sizmo doctor                  # shows your version + whether a newer one exists
```

## Reporting a vulnerability

**Do not open a public GitHub issue for a security bug.**

- **Preferred:** GitHub private vulnerability reporting — repo **Security → Report a vulnerability**.
- **Fallback:** email **studio@mg.sizmo.ai**.

Expect a first response within **72 hours**. Please include repro steps and the affected version.

## What sizmo touches (trust boundaries)

1. **Your PIT** — a GoHighLevel Private Integration Token you create and paste in.
2. **A local CRM model cache** — slow-changing structure (pipeline/stage names, calendars, tags,
   custom fields, users, location, plus forms/surveys/products/links/businesses/custom-objects —
   **names and ids only**) under `~/.config/sizmo/`. No contacts, conversations, or payments are
   cached.
3. **(Opt-in) an LLM provider — only if you configure `sizmo ask`.** Setting `--ai-key` turns on a
   third boundary: your typed request text, plus a structural CRM excerpt (pipeline/calendar/tag/
   form/survey/business **names and ids**) is sent to whichever provider you chose (Anthropic or
   OpenAI) to resolve a command. **Never sent:** your PIT, contact records, conversations, or money
   data — not even a contact you referred to by pronoun ("her", "that deal"): the LLM only ever
   sees the literal placeholder token `<recent-contact>`, and the real name/id is substituted
   back in locally, after the LLM has already responded. If you don't set an AI key, sizmo makes
   zero calls to any LLM, ever — `ask` fails with setup instructions instead.
4. **Two short-lived local files for `sizmo ask`** — a last-resolved-contact cache (name+id, 20
   min TTL, so a pronoun follow-up works) and a pending-write-plan cache (10 min TTL — the exact
   commands `sizmo ask` is about to run once you type `--confirm`, so `--confirm` fires *precisely*
   what you already previewed instead of re-asking the AI and risking it resolve differently the
   second time). Both live at `~/.config/sizmo/ask-memory/`, `0600`, atomic writes, never sent
   anywhere — same local-only category as the model cache. The pending-plan file can contain
   write content (a note's text, an SMS/email body, a tag name) for up to 10 minutes.

Everything else the tool stores stays on your machine.

## Security guarantees — and how to verify each yourself

| Guarantee | How to verify |
|-----------|---------------|
| **The PIT is read from stdin or env only — never argv.** There is no `--pit` flag, so your token never lands in shell history, `ps`, or process args. | `grep -rn "'--pit'" lib/ commands/` — you'll find only `--pit-stdin` / `--pit-env`. |
| **The profile file is written 0600, atomically.** The PIT is stored owner-only, via a temp file created at mode `0600` then renamed — no window where it's world-readable, no half-written file on a crash. | Read `lib/config.mjs` (`saveProfiles`); check perms: `ls -l ~/.config/sizmo/profiles.json`. |
| **The PIT scope is the gate — and there is no card-charging path.** sizmo exposes only what your token's scopes + GoHighLevel's *public* API allow; a missing scope fails with `AUTH` + the exact scope to add. Money-side, the public API offers create-**draft**-invoice, **send** an invoice (a pay-link the customer acts on), and recording a manual payment — there is **no public "charge a card" endpoint**, so sizmo cannot pull money off a card on its own. **Every write — operational *or* money — requires `--confirm`** (without it the CLI prints the change and exits 5). | `grep -rn "ctx.http.post\|ctx.http.put\|ctx.http.delete" commands/` — every write is scope-gated + confirm-gated; there is no charge/capture/refund call. |
| **No telemetry — sizmo never phones home about you.** Outbound traffic goes to exactly three places, and only the first two happen by default: (1) the GoHighLevel API, (2) a once-a-day npm-registry check for a newer version (a plain `GET` that sends nothing about you), and (3) **only if you configured `sizmo ask` with an AI key**, your chosen LLM provider. No analytics, no crash reporting, no usage beacon — there is no fourth destination. | Run the egress audit below; read `lib/update-notify.mjs` (registry) and `lib/llm.mjs` (the only LLM caller). Opt out of the update check with `--no-update-check` or `NO_UPDATE_NOTIFIER=1`; leave `--ai-key` unset and (3) never happens. |
| **Zero runtime dependencies.** No transitive supply chain to trust. | `npm ls --omit=dev` → prints `(empty)`. (Don't grep `package.json` for `"dependencies": {}` — the field is absent entirely, so a grep finds nothing and can't tell you whether that's correct.) |
| **`sizmo ask` never sends your PIT, contacts, conversations, or money data to the LLM provider.** Only your typed request text and CRM structure names/ids (pipelines, calendars, tags, forms, surveys, businesses) leave the machine — and only if you've set an `--ai-key`. Pronoun follow-ups resolve locally via a placeholder token, never a real name. | Read `lib/llm.mjs` (the only place an LLM is called), `buildCrmExcerpt()` and the `RECENT_CONTACT_TOKEN` handling in `commands/ask.mjs`. |
| **`sizmo ask`'s confirm leg never re-asks the AI.** The unconfirmed preview resolves every name to a real id once and caches that exact plan; a **bare** `sizmo ask --confirm` replays that cached plan verbatim — it cannot fire something different from what you previewed, and the plan is cleared *before* it runs, so a stray second `--confirm` cannot re-apply it. **One exception, by design:** typing a sentence *and* `--confirm` in the same command (`sizmo ask "tag Ana as follow-up" --confirm`) resolves and fires in that one call — there is no preview to replay, because you asked for both at once. It is not a drift risk (nothing was shown beforehand that could differ), and resolution still refuses rather than guesses whenever a name is ambiguous. `sizmo ask` also declines to auto-fire money (`invoice`) or scheduling (`appointment`) commands, and `opp update` — it only ever resolves and prints those for you to run yourself. | Read `savePendingPlan`/`loadPendingPlan` in `lib/ask-memory.mjs` and the `EXECUTABLE_WRITE_COMMANDS` set in `commands/ask.mjs`. |

## Limitations (read this — a strengths-only security doc is a false-confidence trap)

- **The update check contacts the public npm registry** (`registry.npmjs.org`) at most once per day.
  It's a `GET` and sends no information about you, but it *is* a network call. Disable it entirely
  with `--no-update-check` or `NO_UPDATE_NOTIFIER=1` if your environment forbids egress.
- **Local cache files** (`~/.config/sizmo/`) are written `0600` but are only as protected as your
  user account. On a shared or compromised machine, anyone with your user can read them.
- **The tool trusts GoHighLevel's API responses.** It does not independently verify data integrity
  beyond HTTP status; a compromised upstream would be reflected in output.
- **A leaked PIT is your GHL exposure, not sizmo's.** If your token is stolen (from anywhere), rotate
  it immediately in GoHighLevel → Settings → Integrations → Private Integrations. `sizmo doctor`
  surfaces your token's age so you can rotate before the 90-day limit.
- **`sizmo ask` is a third-party data flow, opt-in only.** Your AI key is stored the same way your
  PIT is (0600, atomic write) but it authenticates you to Anthropic or OpenAI, not GoHighLevel —
  their own data-handling policies apply to whatever request text and CRM-structure excerpt you
  send them. Don't type sensitive free text into `sizmo ask` if you wouldn't want it seen by your
  chosen AI provider. Leave `--ai-key` unset to disable the feature entirely.
- **Writes are real — including money-side ones (changed in 2.0).** `--confirm` fires an actual
  change in your CRM, and if your PIT carries `invoices.write` that includes creating or **sending**
  an invoice. The confirm gate prevents *accidental* writes, not *intended* ones. sizmo still cannot
  charge a card (GoHighLevel exposes no public endpoint for that), but a *sent* invoice is a real
  request for payment to your customer — grant money scopes deliberately. Prior to 2.0, sizmo
  excluded all money endpoints; 2.0 moved to "the PIT scope is the gate."
- **`sizmo ask` can fire a MULTI-step batch off one `--confirm`.** "Tag Ana as follow-up and book
  her Friday" previews both steps, then a single `--confirm` runs both in order — read the whole
  preview, not just the first line, before confirming. A batch stops at the first failed step;
  it never continues past one.

## Audit it yourself

```sh
git clone https://github.com/csalamida/sizmo-ghl-cli && cd sizmo-ghl-cli

npm ls --omit=dev           # runtime dependency tree — prints "(empty)"
ls lib/                     # the whole surface
node --test                 # the test suite
```

### Egress audit — prove for yourself where it can talk to

Every network destination is a literal string in the source. List them all:

```sh
grep -rhoE "https://[a-z0-9.-]+" bin/ lib/ commands/ | sort -u
```

That prints seven hosts. Only **three** are ever contacted:

| Host | What it is |
|------|-----------|
| `services.leadconnectorhq.com` | the GoHighLevel API (`lib/http.mjs`) — the actual job |
| `registry.npmjs.org` | once-a-day version check (`lib/update-notify.mjs`) — `GET`, sends nothing about you |
| `api.anthropic.com` / `api.openai.com` | `sizmo ask` only, **and only if you set an AI key** (`lib/llm.mjs` — the sole caller) |

The rest are never fetched: `app.gohighlevel.com` is only used to *build deep links printed to your
terminal* (`lib/cli.mjs`, override via `SIZMO_APP_URL`), and `acme.com` / `cal.me` are example
strings inside `--help` text.

Then prove nothing else can open a socket. Every command reaches the network through `ctx.http`,
which funnels into `lib/http.mjs` — so only three modules ever originate a request:

```sh
grep -rn "fetch(\|fetchImpl(" bin/ lib/ commands/ | grep -vE "fetchImpl =|typeof fetchImpl|fetchImpl,|fetchImpl }"
```

Five call sites, three files: `lib/http.mjs` (GoHighLevel), `lib/update-notify.mjs` (npm registry —
it calls through an injectable `fetchImpl` so tests can stub it, which is why a bare `grep "fetch("`
misses this one), and `lib/llm.mjs` (the two LLM providers). Nothing in `commands/` opens a socket
directly.

Because there are no dependencies, what you read is what runs.

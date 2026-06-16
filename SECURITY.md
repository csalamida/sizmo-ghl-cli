# Security Policy

`sizmo` is an unofficial GoHighLevel CLI. It handles one sensitive thing — your **Private
Integration Token (PIT)** — and it talks to a live CRM. This document explains exactly what it
does with your credentials, and how to verify those claims yourself rather than take them on faith.

The whole tool has **zero runtime dependencies** (`dependencies: {}` in `package.json`), so the
attack surface is just the code in this repo. You can read all of `lib/` in an afternoon.

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

Only two things:

1. **Your PIT** — a GoHighLevel Private Integration Token you create and paste in.
2. **A local CRM model cache** — slow-changing structure (pipeline/stage names, calendars, tags,
   custom fields, users, location) under `~/.config/sizmo/`. No contacts, conversations, or payments
   are cached.

That's the entire boundary. The tool stores nothing in the cloud and runs nowhere but your machine.

## Security guarantees — and how to verify each yourself

| Guarantee | How to verify |
|-----------|---------------|
| **The PIT is read from stdin or env only — never argv.** There is no `--pit` flag, so your token never lands in shell history, `ps`, or process args. | `grep -rn "'--pit'" lib/ commands/` — you'll find only `--pit-stdin` / `--pit-env`. |
| **The profile file is written 0600, atomically.** The PIT is stored owner-only, via a temp file created at mode `0600` then renamed — no window where it's world-readable, no half-written file on a crash. | Read `lib/config.mjs` (`saveProfiles`); check perms: `ls -l ~/.config/sizmo/profiles.json`. |
| **Money never moves.** No code path charges, collects, refunds, or issues an invoice. Payments and invoices are read-only. The only writes are operational — tag, note, opportunity, appointment, message — and **every write requires `--confirm`** (without it the CLI prints the change and exits 5). | `grep -rni "charge\|collect\|refund" commands/` — the hits are read/report fields, never a POST. See README "Safety model". |
| **No telemetry.** sizmo makes exactly two kinds of outbound request: the GoHighLevel API, and a once-a-day npm-registry check for a newer version (a plain `GET`, sending nothing about you). | Read `lib/update-notify.mjs`; opt out with `--no-update-check` or `NO_UPDATE_NOTIFIER=1`. |
| **Zero runtime dependencies.** No transitive supply chain to trust. | `cat package.json` → `"dependencies": {}`. |

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
- **Writes are real.** `--confirm` fires an actual change in your CRM. The confirm gate prevents
  *accidental* writes; it does not prevent *intended* ones. Money endpoints are excluded entirely.

## Audit it yourself

```sh
git clone https://github.com/csalamida07-cyber/sizmo-ghl-cli && cd sizmo-ghl-cli
cat package.json            # zero dependencies
ls lib/                     # the whole surface
node --test                 # the test suite
```

Because there are no dependencies, what you read is what runs.

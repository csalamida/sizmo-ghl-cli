# Changelog

All notable changes to `sizmo` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] — 2026-06-26

First feature minor since 1.0. Additive only — the frozen 1.x contract (exit codes, the `--json`
envelope, command/flag names) is unchanged. Includes everything from 1.0.1 below.

### Added
- **`--ndjson`** — streamed machine output: a leading meta line (carrying `command`, `location`,
  `degraded`, `warnings`, `count`, and every non-list field) then one JSON object per list item.
  Lets an agent process large lists line-by-line without buffering, and — unlike a bare CSV — the
  meta line means a blocked/`degraded` source is never silently dropped. No-list payloads (e.g.
  `doctor`) emit a single envelope line. Honors `--fields`. Shape frozen for `1.x` (see
  `API-STABILITY.md`).
- **`SIZMO_PROFILE` env var** — select a saved profile without `--profile` on every call
  (precedence: `--profile` flag > `SIZMO_PROFILE` > saved default). Mirrors `AWS_PROFILE`.

### Fixed
- **`--fields` now actually projects `brief` and `pipeline`.** Their list keys (`actions`, `stuck`)
  were missing from the projection set, so `--fields` silently did nothing on them. Now covered,
  plus a guard test that fails if any list-bearing recipe's key drifts out of the set (so the
  silent no-op can't return).

## [1.0.1] — 2026-06-26

### Fixed
- **`auth check` no longer reports "all green" while offline.** The shared scope probe treated a
  transport error (could-not-reach, `code:0`) the same as a real `200` — so on a dropped/flaky
  connection `auth check` printed "6/6 lanes readable · usable" and exited 0, while `doctor` (which
  patched around the same probe) correctly said "OFFLINE". The probe now treats `code:0` as
  unverifiable (not granted) at the source, and `auth check` reports "could not reach GoHighLevel"
  + exits non-zero when every lane is unreachable. Both commands now agree. (Pass-3 fake-green.)
- **Dates/times now render in the location's own timezone, not a hardcoded `Asia/Manila`.**
  `brief`, `snapshot`, `noshow`, and `booked-not-paid` showed every date in Manila time regardless
  of where the GoHighLevel location actually is — so a US/UK/AU client could see the wrong day in
  the `brief` header and Manila-shifted appointment times. The timezone now comes from the synced
  CRM model's location (it was already stored); when no model/timezone is available it still falls
  back to `Asia/Manila`, so existing PH users are unchanged. (Human output only — no contract change.)
- CHANGELOG: the 1.0.0 entry said CI runs on "Node 20 + 22" in one line and "22 + 24" in another;
  the real matrix is 22 + 24.

### Documentation
- Documented the already-shipped token-lean flags `--fields` (project list items to named keys, on
  every list-bearing recipe) and `--concise` (leaner `brief` payload) in the README + API-STABILITY,
  and froze them under `1.x`. No code change — these shipped earlier but were undocumented; they're
  the lowest-token way for an agent to consume sizmo.

### Security
- Completed the URL-encoding hardening started in 0.9.0: `encodeURIComponent` is now applied to
  every user-supplied id interpolated into a request path — `appointment cancel <apptId>`,
  `note <contactId>`, `opp move/update <oppId>`, and the `triage` conversation fetch. 0.9.0 had only
  covered location ids; a malformed/hand-edited id can no longer alter a request's path or query.

## [1.0.0] — 2026-06-17

First stable release. 1.0 is a **trust + stability commitment**, not new features — the public
contract is now frozen under semver (see `API-STABILITY.md`). Everything below is the trust
scaffolding that makes the existing CLI dependable.

### Added
- `SECURITY.md` — security policy, threat model, and verifiable guarantees (zero-deps,
  PIT-never-in-argv, money-never-moves, no-telemetry), each with a self-audit recipe.
- `CHANGELOG.md` — this file; release history backfilled from 0.4.0.
- `scripts/prepublish-gate.mjs` — wired into `prepublishOnly`; **aborts `npm publish`** unless the
  git tree is clean and HEAD is tagged `vX.Y.Z` matching `package.json`. Closes the loophole that
  let 0.7.0–0.9.0 ship while git was stuck at 0.6.0. No bypass flag.
- `CONTRIBUTING.md` — documented the release ritual; corrected the stale "never writes" claim
  (confirm-gated operational writes exist since 0.6.0; money still never moves).
- CI — GitHub Actions (`.github/workflows/ci.yml`): runs `node --test` on Node 22 + 24 on every
  push/PR, plus a generic gitleaks secret scan. CI / npm / zero-deps badges in the README.
- `API-STABILITY.md` — the frozen public contract for 1.x: exit codes, the two JSON contracts
  (data-command envelope + per-verb router shapes), `schemaVersion` policy, flag/command stability,
  and an explicit list of what is NOT covered (human output, stderr, internal modules).
- `docs/maintainers/api-versions.md` — where the GHL API date-version pins live, the deprecation
  watch, the bump procedure, and the Node-floor policy.

### Changed
- **Node floor raised to `>=22`** (current Active LTS; Node 20 reached end-of-life). `engines` is
  advisory — a user on an older Node gets an npm warning, not a failure. CI matrix is now 22 + 24.
- README now opens with a **"Why sizmo"** section (vs the GHL web UI / the official MCP server /
  Zapier-style automation) — the reason-to-choose, not just a feature list.

### Fixed
- **brief no longer fakes "all clear" on a wrong/expired PIT.** When a data source is blocked, the
  headline reads `No leaks in readable data · ⚠ partial` (not a falsely-complete "No leaks found")
  and the footnotes point to `sizmo doctor`. Found via a 1.0 unhappy-path review.

## [0.9.0] — 2026-06-15

### Added
- Zero-dependency **update notifier**: a once-a-day npm-registry check that prints a one-line
  "newer version available" nudge to stderr. Cached 24h, fail-silent/offline-safe, never under
  `--json` or when piped. Opt out with `--no-update-check`, `NO_UPDATE_NOTIFIER`, or
  `SIZMO_NO_UPDATE_CHECK`. No telemetry — a plain GET that sends nothing about you.
- `sizmo doctor` now reports a **CLI VERSION** line (cache-read-only; never gates health).
- `lib/money.mjs` — single source of truth for currency symbols + money formatting.

### Changed
- Currency formatting unified across all 7 commands that render money (previously duplicated).

### Fixed
- Currency symbol drift: an AUD/CAD amount rendered `A$`/`C$` in the brief headline but `AUD `/`CAD `
  in the ranked line — both now resolve from one symbol table.
- Removed dead never-billed code in `brief` (was never collected and could never rank).

### Security
- `encodeURIComponent` applied to every location-id URL interpolation in `lib/model.mjs`
  (defense-in-depth against a malformed/hand-edited location id corrupting a request).

## [0.8.0] — 2026-06-15

### Fixed
- **Currency honesty:** the `brief` headline summed an amount but labelled it with the *model's*
  currency symbol — a ₱ figure could display as `$`. The headline symbol now follows the amount's
  own currency.
- **Exit-code consistency:** `sizmo doctor` now treats a blocked `contacts` scope as a usability
  floor and exits `AUTH`, matching `sizmo auth check`.

### Security
- Profile file (`profiles.json`, holds the PIT) is now written **atomically at mode 0600** —
  temp file created owner-only then renamed, removing a brief window where it was world-readable
  and preventing a half-written file on crash.
- `encodeURIComponent` on location id in the scope-probe and doctor connectivity check.

### Changed
- Tightened several tests that were too weak to catch a regression (fake-green guard).

## [0.7.0] — 2026-06-14

### Added
- `sizmo init` — guided activation: prints the GHL path + exact scope copy-block, takes the token
  from stdin only, writes the profile, and auto-runs `doctor`. Agent-drivable non-interactively.
- `sizmo doctor` — one-shot health diagnosis (scopes, location reachability, CRM-model freshness),
  with an exact fix line per blocked scope. Never reports green when a lane is blocked.
- Share-worthy `brief`: an honest headline (`<currency>X found · N need you today`) plus
  `--format slack|md`. The `--json` envelope is unchanged — human render only.

## [0.6.0] — 2026-06-14

### Added
- **Operational writes** — `tag`, `note`, `opp`, `appointment`, `send`. Every write requires
  `--confirm`; without it the CLI prints the exact change + a rerun command and exits 5. Money
  endpoints (charge/collect/refund/invoice-issue) are deliberately excluded.
- Per-profile **memory**: "what changed vs last run" deltas, plus `ack`/`snooze` to hide handled
  items. All local — no GHL writes.
- Token-lean flags: global `--concise` and `--fields` projection.

### Changed
- `brief --json` payload trimmed ~87% (use `--verbose` to restore the raw sources blob).

## [0.5.0] — 2026-06-13

### Added
- Local **CRM model** — `sizmo sync` caches slow-changing structure (pipelines/stages, calendars,
  tags, custom fields, users, location) under `~/.config/sizmo/`.
- `sizmo crm` query surface (counts, lists, per-entity staleness).
- An id→name resolver that never fabricates: a cache miss renders `<unknown:id — run sizmo sync>`.

### Changed
- Recipes read structure from the local model instead of re-fetching it every run; currency comes
  from the location, not a hardcoded value.

## [0.4.1] — 2026-06-13

### Fixed
- Post-launch patch fixes following the initial public release.

## [0.4.0] — 2026-06-13

### Added
- Initial public release. Read-only GoHighLevel recipes: `brief`, `snapshot`, `triage`, `pipeline`,
  `noshow`, `receivables`, `reconcile`, `booked-not-paid`, `focus`, `segment`.
- Private Integration Token (PIT) auth via stdin/env (never argv); multi-profile config.
- Stable `--json` envelope (`schemaVersion: 1`); `sizmo auth status` / `auth check` / `schema`.

[Unreleased]: https://github.com/csalamida07-cyber/sizmo-ghl-cli/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/csalamida07-cyber/sizmo-ghl-cli/releases/tag/v1.1.0
[1.0.1]: https://github.com/csalamida07-cyber/sizmo-ghl-cli/releases/tag/v1.0.1
[1.0.0]: https://github.com/csalamida07-cyber/sizmo-ghl-cli/releases/tag/v1.0.0
[0.9.0]: https://github.com/csalamida07-cyber/sizmo-ghl-cli/releases/tag/v0.9.0
[0.8.0]: https://github.com/csalamida07-cyber/sizmo-ghl-cli/releases/tag/v0.8.0
[0.7.0]: https://github.com/csalamida07-cyber/sizmo-ghl-cli/releases/tag/v0.7.0
[0.6.0]: https://github.com/csalamida07-cyber/sizmo-ghl-cli/releases/tag/v0.6.0
[0.5.0]: https://github.com/csalamida07-cyber/sizmo-ghl-cli/releases/tag/v0.5.0
[0.4.1]: https://github.com/csalamida07-cyber/sizmo-ghl-cli/releases/tag/v0.4.1
[0.4.0]: https://github.com/csalamida07-cyber/sizmo-ghl-cli/releases/tag/v0.4.0

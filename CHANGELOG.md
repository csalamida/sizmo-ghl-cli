# Changelog

All notable changes to `sizmo` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `SECURITY.md` — security policy, threat model, and verifiable guarantees (zero-deps,
  PIT-never-in-argv, money-never-moves, no-telemetry), each with a self-audit recipe.
- `CHANGELOG.md` — this file; release history backfilled from 0.4.0.

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

[Unreleased]: https://github.com/csalamida07-cyber/sizmo-ghl-cli/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/csalamida07-cyber/sizmo-ghl-cli/releases/tag/v0.9.0
[0.8.0]: https://github.com/csalamida07-cyber/sizmo-ghl-cli/releases/tag/v0.8.0
[0.7.0]: https://github.com/csalamida07-cyber/sizmo-ghl-cli/releases/tag/v0.7.0
[0.6.0]: https://github.com/csalamida07-cyber/sizmo-ghl-cli/releases/tag/v0.6.0
[0.5.0]: https://github.com/csalamida07-cyber/sizmo-ghl-cli/releases/tag/v0.5.0
[0.4.1]: https://github.com/csalamida07-cyber/sizmo-ghl-cli/releases/tag/v0.4.1
[0.4.0]: https://github.com/csalamida07-cyber/sizmo-ghl-cli/releases/tag/v0.4.0

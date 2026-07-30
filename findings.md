# findings.md — 2026-07-31 — test-coverage run

## Enumeration: commands vs test files

All 34 commands in `commands/*.mjs` have at least one test file. The 2026-07-16 backlog
(`surveys`, `transactions`, `business`) was addressed in a prior run — all three have full,
substantive test files that pass.

| command | test file(s) |
|---------|-------------|
| ack | ack.test.mjs |
| appointment | appointment.test.mjs, appointment-list.test.mjs |
| ask | ask.test.mjs, ask-destructive-gate.test.mjs |
| booked-not-paid | booked-not-paid.test.mjs |
| brief | brief.test.mjs, brief-format.test.mjs, brief-memory.test.mjs |
| business | business.test.mjs |
| calendar | calendar.test.mjs |
| contact | contact.test.mjs, contact-find.test.mjs |
| crm | crm.test.mjs, crm-blocked.test.mjs |
| diff | diff.test.mjs |
| doctor | doctor.test.mjs |
| export | export.test.mjs |
| field | field.test.mjs |
| focus | focus.test.mjs, focus-memory.test.mjs |
| forms | forms.test.mjs |
| init | init.test.mjs |
| invoice | invoice.test.mjs, invoice-list.test.mjs |
| link | link.test.mjs |
| list | list.test.mjs, list-blocked.test.mjs |
| noshow | noshow.test.mjs |
| note | note.test.mjs |
| opp | opp.test.mjs |
| pipeline | pipeline.test.mjs |
| receivables | receivables.test.mjs |
| reconcile | reconcile.test.mjs |
| segment | segment.test.mjs |
| send | send.test.mjs |
| snapshot | snapshot.test.mjs |
| surveys | surveys.test.mjs |
| sync | sync.test.mjs, sync-blocked.test.mjs |
| tag | tag.test.mjs |
| transactions | transactions.test.mjs |
| triage | triage.test.mjs, triage-concurrency.test.mjs |
| value | value.test.mjs |

**Coverage gap: none.** Proceeding to deepen the weakest test file per task instructions.

## Weakest file identification

Test counts per file (bottom of distribution):

```
export.test.mjs:8    (99 lines)
diff.test.mjs:9     (118 lines)
link.test.mjs:10    (87 lines)
note.test.mjs:11    (130 lines)
```

`export.mjs` had the most uncovered branches relative to its test count — 9 reachable branches
vs 8 tests. Chosen for deepening.

## Action: deepened `test/commands/export.test.mjs`

9 tests added covering branches that were untested:

| Test added | Branch covered in export.mjs |
|------------|------------------------------|
| entity absent from model → `{ unavailable: 'not synced' }` | `entityGroup`: `!ent` path (line 44) |
| entity `networkError` → `{ unavailable: 'network' }` | `entityGroup`: `ent.networkError` path (line 45) |
| entity `blocked` with `httpCode` → `{ blocked, httpCode }` + "not a scope issue" | `entityGroup`: `ent.httpCode` sub-branch (lines 48-49) |
| customValues `code === 0` → `{ unavailable: 'network' }` | transport-failure branch (line 101) |
| customValues HTTP 500 → `{ unavailable: 'http 500' }` | non-ok non-auth branch (line 102) |
| `E.location.blocked` without `httpCode` → "blocked (missing scope)" warning | location-blocked branch (lines 73-74) |
| `E.location.blocked` with `httpCode` → "API error N (not a scope issue)" warning | location-blocked-httpCode branch (lines 72-73) |
| `run` without `--out` → canonical JSON printed to stdout | `out.card` stdout path (line 143) |
| `run` with unwritable `--out` path → `GhlError(EXIT.API)` | `writeFileSync` failure wrapper (line 127) |

## Before / after

```
Before:  node --test  →  1142 tests, 0 fail
After:   node --test  →  1151 tests, 0 fail
```

Evidence (actual `node --test` output after edit):

```
1..1151
# tests 1151
# suites 0
# pass 1151
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 8125.209292
```

## Files changed

- `test/commands/export.test.mjs` — 9 tests appended (lines 100-199 of the new file)

## Files NOT changed

- All command source files — no bugs found; read-only this run

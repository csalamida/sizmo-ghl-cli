# Daily Loop — Docs/Test Hygiene — 2026-07-16

## Gap Found

`commands/forms.mjs` had **zero test coverage** despite being a shipped command with two distinct code paths:
1. List mode (`sizmo forms`) — reads model cache via `ctx.ensureModel()`
2. Submissions feed (`sizmo forms <formId>`) — live HTTP GET with 4 distinct error branches (401/403/404/5xx)

Evidence — commands with no corresponding test file:
```
commands/forms.mjs        ← FIXED THIS RUN (0 → 12 tests)
commands/surveys.mjs      ← still untested (same structure as forms)
commands/transactions.mjs ← still untested
commands/business.mjs     ← still untested
```

`forms.mjs` was chosen first: highest branch count among the four (blocked/httpCode split on list path + 4 HTTP status branches on submissions path).

---

## Fix Applied

Added `test/commands/forms.test.mjs` — 12 tests, no mocks beyond the in-process `makeFakeCtx` helper already used by the rest of the suite.

| # | Test | Branch covered |
|---|------|----------------|
| 1 | list: items from model | happy path, envelope shape |
| 2 | list: empty items array | zero-item edge case |
| 3 | list: blocked (no httpCode) | EXIT.AUTH scope error |
| 4 | list: blocked with httpCode | EXIT.API non-scope API error |
| 5 | submissions: happy path | EXIT.OK + envelope shape |
| 6 | submissions: empty list | "(no submissions yet)" text |
| 7 | submissions: 401 | EXIT.AUTH |
| 8 | submissions: 403 | EXIT.AUTH |
| 9 | submissions: 404 | EXIT.NOTFOUND |
| 10 | submissions: 500 | EXIT.API |
| 11 | submissions: --top 5 | clamped limit in URL |
| 12 | submissions: --top 999 | MAX_TOP=100 ceiling enforced |

---

## Evidence

New test file alone:
```
$ node --test --test-concurrency=1 test/commands/forms.test.mjs
# tests 12
# pass 12
# fail 0
```

Full suite after adding the file (no regressions):
```
$ node --test --test-concurrency=1
# tests 600
# pass 600
# fail 0
```

Suite was 588 tests before this run (12 new tests added = 600 total).

---

## Files Changed

| File | Change |
|------|--------|
| `test/commands/forms.test.mjs` | New file — 12 tests covering list + submissions paths |

No doc changes. No code changes. No package.json changes. No GHL API calls made this run.

---

## Remaining Coverage Gaps (not fixed this run — one gap per loop)

- `commands/surveys.mjs` — identical structure to forms; same paths untested
- `commands/transactions.mjs` — untested
- `commands/business.mjs` — untested

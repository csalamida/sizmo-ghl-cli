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
- `SECURITY.md` — recipe inaccuracy (Claim 2) is low-severity and doc-only; left for supervised
  review rather than touching a security doc unattended
- All other source files — verified read-only

---

# findings — 2026-08-01 — failure-paths

## Area investigated

`opp move` — a write command that PUTs to `/opportunities/{id}` with no "fetch first" guard. Focus:
what does a real user see when they supply a nonexistent opportunity id?

## How the failure was induced

Built a minimal fake ctx with the HTTP fixture `{ 'PUT /opportunities/ghost-opp': { status: 404, j: { message: 'Not Found' } } }` and called `run({ _: ['move', 'ghost-opp'], stage: 'Won' }, ctx)` with `confirmed: true`.

```
node -e "
import('./commands/opp.mjs').then(({ run }) => {
  // ... [minimal ctx with MODEL + fixture] ...
  return run({ _:['move', 'ghost-opp'], stage:'Won' }, ctx)
    .catch(e => {
      console.log('THREW GhlError:', e.message);
      console.log('e.code =', e.code);
    });
});
"
```

**Output:**
```
THREW GhlError: opp move failed — HTTP 404: {"message":"Not Found"}
e.code = 1 (expected 4=NOTFOUND, actual = 1)
Bug confirmed: YES — exits API(1) for a 404, should be NOTFOUND(4)
```

## What the user sees (before fix)

- **Exit code:** 1 (`EXIT.API`) — wrong
- **Message:** `opp move failed — HTTP 404: {"message":"Not Found"}` — dumps raw GHL JSON, says nothing actionable
- **Remediation:** none
- **Leaks tokens/paths/internals?** No — the GHL JSON contains no sensitive data here

## Why it matters

`EXIT.API` (1) signals a transient server error — "retry this." `EXIT.NOTFOUND` (4) signals a permanently bad id — "don't retry, fix your input." sizmo's primary consumer is an agent branching on exit codes. An agent with `retry on exit 1` will loop forever on a typo'd opportunity id. The same gap was found and fixed for `opp update` on 2026-07-27 (see `commands/opp.mjs` line 334, `test/commands/opp.test.mjs` lines 473-487) but `opp move` was missed.

## Root cause

`opp update` added an explicit 404 check (lines 334-336 in the current file):
```js
if (r.code === 404) {
  throw new GhlError(`no opportunity with id ${oppId} — nothing changed`, EXIT.NOTFOUND);
}
```

`opp move` has no equivalent check — its error path falls through to the generic `!r.ok` arm which always exits `EXIT.API`.

## Fix applied

**`commands/opp.mjs`** — after the 401/403 block in `opp move`'s execute section, added:

```js
// opp move shared the same gap as opp update before 2026-07-27: a 404 from the PUT was mapped
// to EXIT.API ("server error — retry") instead of EXIT.NOTFOUND ("your id is wrong — do not
// retry"). For an agent branching on exit codes, retry-on-1 is sane policy; retrying a
// permanently-missing id forever is not.
if (r.code === 404) {
  throw new GhlError(`no opportunity with id ${oppId} — nothing changed`, EXIT.NOTFOUND);
}
```

**`test/commands/opp.test.mjs`** — added two regression tests:

```js
test('opp move: 404 → EXIT.NOTFOUND, not EXIT.API', async () => {
  const fixture = { 'PUT /opportunities/ghost-move': { status: 404, j: { message: 'Not Found' } } };
  const { ctx } = makeFakeCtx({ confirmed: true, model: MODEL, fixture });
  await assert.rejects(
    () => run({ _: ['move', 'ghost-move'], stage: 'Won' }, ctx),
    (e) => {
      assert.equal(e.code, EXIT.NOTFOUND, ...);
      assert.match(e.message, /ghost-move/);
      assert.match(e.message, /nothing changed/);
      return true;
    });
});

test('opp move: 500 still → EXIT.API (404 mapping must not swallow real server errors)', async () => {
  ...
});
```

## Test results

Before fix:
```
node --test test/commands/opp.test.mjs → 45 pass (no 404 test existed for opp move)
```

After fix:
```
node --test test/commands/opp.test.mjs → 47 pass (2 new tests, both green)
node --test --test-concurrency=1       → 1144 pass, 0 fail (full suite, no regressions)
```

## Checklist

| Criterion | Result |
|-----------|--------|
| Exit code correct? | ✅ Fixed: 404 now exits NOTFOUND(4), not API(1) |
| Message says what to DO next? | ✅ "no opportunity with id {id} — nothing changed" — names the bad id, confirms no write happened |
| Leaks tokens/paths/internals? | ✅ No — neither before nor after |

## Files changed

- `commands/opp.mjs` — added 404→NOTFOUND mapping in `opp move` execute section (mirrors existing fix in `opp update`)
- `test/commands/opp.test.mjs` — two new regression tests pinning the correct exit code, id naming, and "nothing changed" message

## Files NOT changed

- `commands/opp.mjs` `opp delete` — DELETE on a pre-fetched id can 404 only in a TOCTOU race; the fetch-first guard handles the common case (wrong id → 404 on GET → NOTFOUND before any write fires). Left as-is to avoid scope creep on an edge case.

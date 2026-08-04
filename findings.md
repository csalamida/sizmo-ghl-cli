# findings — 2026-08-05 — distribution/dx: AGENTS.md + SKILL.md parity

## What was wrong

Three commands added in v2.6.0 were absent from both `AGENTS.md` and `SKILL.md`:

| Command | What it does | Where it should appear |
|---------|-------------|------------------------|
| `sizmo contact find "<query>"` | Fuzzy lookup by name/email/phone → prints the contact id every write command needs | "Look Up IDs" section + "Read Commands" |
| `sizmo invoice list` | List invoices by status; the only way to find a draft invoice id after `invoice draft` creates one | "Read Commands" |
| `sizmo appointment list` | Upcoming appointments (forward-looking); the only way to find an appointment id to cancel/note | "Read Commands" |

All three confirmed in CLI source:

```
$ grep "SUBCOMMANDS" commands/contact.mjs
const SUBCOMMANDS = ['find', 'create', 'upsert', 'update', 'delete'];

$ grep "SUBCOMMANDS" commands/invoice.mjs
const SUBCOMMANDS = ['list', 'draft', 'send'];

$ grep "SUBCOMMANDS" commands/appointment.mjs
const SUBCOMMANDS = ['list', 'book', 'update', 'cancel', 'note'];
```

They are listed in the README's "What it does" table (Find row):
> `contact find` (name/email/phone → the id every write needs) · `invoice list` · `appointment list` (upcoming)

Gap: README knew about them; the two agent reference files (the ones Codex and Cursor pick up) did not.

## Why it matters

`AGENTS.md` "Look Up IDs Before Running a Command" is exactly the section an AI coding agent reads before writing. Without `contact find`, the documented lookup path was `sizmo list` (entities: calendars, pipelines, fields, users) and `sizmo segment` (contacts by tag/criteria, not name). No documented path from "I have a name" → "I have an id" — the most common write precondition. `contact find` is that path.

Without `invoice list`: no documented way to retrieve an invoice id after `invoice draft` creates one (needed by `invoice send`).

Without `appointment list`: no documented way to find an appointment id to cancel or note.

## Evidence: flags verified against source

```
contact find:
  --limit  type: int  desc: 'max matches to show (find only, default 10)'
  source: commands/contact.mjs, args declaration block

invoice list:
  --status  type: string  desc: 'filter by status, e.g. draft|sent|paid|void (list)'
  --top     type: int     desc: 'max rows to show (list, default 20)'
  source: commands/invoice.mjs, args declaration block

appointment list:
  --days  type: int  desc: 'how far AHEAD to look (list, default 14)'
  --top   type: int  desc: 'max rows to show (list, default 20)'
  source: commands/appointment.mjs, args declaration block
```

## What was changed

**`AGENTS.md`** (+9 lines):
- "Look Up IDs" bash block: added `contact find` with four usage examples (name, email, phone, `--limit`)
- "Read Commands" bullet list: added `contact find`, `invoice list`, `appointment list` after `transactions`

**`SKILL.md`** (+8 lines):
- "Look Up IDs" bash block: same `contact find` examples (phone example omitted — name/email cover the pattern)
- "Read Commands" bullet list: added the same three commands after `noshow`

Line counts before → after:
- `AGENTS.md`: 365 → 374
- `SKILL.md`: 267 → 275

## Files changed

- `AGENTS.md`
- `SKILL.md`

## Files NOT changed

- All command source files — read-only this run; no bugs found
- `README.md` — already documents these commands correctly in the "What it does" table
- All other source files

---

# findings.md — 2026-07-31 — test-coverage run
# findings — 2026-08-02 — claim-verification

## Enumeration: commands vs test files

All 34 commands in `commands/*.mjs` have at least one test file. The 2026-07-16 backlog
(`surveys`, `transactions`, `business`) was addressed in a prior run — all three have full,
substantive test files that pass.
Verified 5 specific, falsifiable claims from SECURITY.md, SKILL.md, and AGENTS.md against actual
source code in the 3.0.0 release. Claims chosen for trust-impact on a stranger handing this tool
a live CRM token. Found one documentation bug (PIT verification recipe description), fixed it.
All other claims verified correct.

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
### Claim 1 — SECURITY.md PIT verification recipe description is wrong

**Source:** SECURITY.md guarantee table — "The PIT is read from stdin or env only — never argv."
Verify column: `` `grep -rn "'--pit'" lib/ commands/` — you'll find only `--pit-stdin` / `--pit-env`. ``

**Underlying property:** TRUE. No bare `--pit` flag exists in the source. Confirmed:
```
grep -rn "\-\-pit" lib/ commands/ | grep -v "pit-stdin\|pit-env\|no PIT\|no-pit\|your PIT\|Your PIT\|the PIT\|a PIT\|PIT \|PIT'\|PIT\."
# → (no output — no bare --pit flag)
```
`commands/init.mjs:26` contains an explicit code comment: `// local flag parse — NOTE: no --pit flag exists by design.`

**Recipe description:** WRONG. The grep command is `grep -rn "'--pit'" lib/ commands/` — the pattern
searches for the literal string `'--pit'` (apostrophe-dash-dash-p-i-t-apostrophe). In the source,
the flags appear as `rest.includes('--pit-stdin')` and `flag('--pit-env')`. Neither contains a
closing apostrophe immediately after "pit", so the pattern matches nothing.

Running the exact command produces zero output:
```
grep -rn "'--pit'" lib/ commands/
# → (no output)
```

The description "you'll find only `--pit-stdin` / `--pit-env`" implies those strings will appear
in the output. They don't. A stranger who runs this gets silence, which they cannot distinguish
from "the grep missed something" vs "the flags don't exist at all."

**Fix applied:** SECURITY.md guarantee table, PIT row. Updated the verify column to explain that
the grep correctly returns nothing (no bare `--pit` literal), and added a second grep
(`grep -rn "pit-stdin\|pit-env" lib/ commands/`) that positively confirms the two allowed flags
exist.

---

### Claim 2 — Egress: "That prints seven hosts"

**Source:** SECURITY.md — "Every network destination is a literal string in the source. List them
all: `grep -rhoE "https://[a-z0-9.-]+" bin/ lib/ commands/ | sort -u` — That prints seven hosts."

**Command run + actual output:**
```
grep -rhoE "https://[a-z0-9.-]+" bin/ lib/ commands/ | sort -u
https://acme.com
https://api.anthropic.com
https://api.openai.com
https://app.gohighlevel.com
https://cal.me
https://registry.npmjs.org
https://services.leadconnectorhq.com
```

**Result: VERIFIED.** Exactly 7 hosts. The three active ones (services.leadconnectorhq.com,
registry.npmjs.org, api.anthropic.com / api.openai.com) match what SECURITY.md documents. The
remainder (app.gohighlevel.com for deep links, acme.com / cal.me in help-text examples) are
never fetched.

---

### Claim 3 — Fetch call sites: "Five call sites, three files"

**Source:** SECURITY.md — "Five call sites, three files: `lib/http.mjs` (GoHighLevel),
`lib/update-notify.mjs` (npm registry), and `lib/llm.mjs` (the two LLM providers).
Nothing in `commands/` opens a socket directly."

**Command run (using SECURITY.md's exclusion pattern):**
```
grep -rn "fetch(\|fetchImpl(" bin/ lib/ commands/ | grep -vE "fetchImpl =|typeof fetchImpl|fetchImpl,|fetchImpl \}"
lib//update-notify.mjs:42:    const r = await fetchImpl(REGISTRY_URL, ...
lib//llm.mjs:22:  const r = await fetch('https://api.anthropic.com/v1/messages', ...
lib//llm.mjs:37:  const r = await fetch('https://api.openai.com/v1/chat/completions', ...
lib//http.mjs:78:        res = await fetch(url, ...
lib//http.mjs:140:        res = await fetch(url, ...
```

**Result: VERIFIED.** Exactly 5 call sites, 3 files. No fetch in commands/. Each site maps to
the documented destination.

---

### Claim 4 — `sizmo ask` never auto-fires invoice, appointment, or opp update

**Source:** SECURITY.md / SKILL.md — "`sizmo ask` also declines to auto-fire money (`invoice`)
or scheduling (`appointment`) commands, and `opp update`."

**Verification:** `commands/ask.mjs`

```js
// ask.mjs:52
const EXECUTABLE_WRITE_COMMANDS = new Set(['tag', 'note', 'send', 'contact', 'opp', 'value', 'field', 'calendar', 'business', 'link']);

// ask.mjs:55
const EXECUTABLE_OPP_SUBCOMMANDS = new Set(['create', 'move', 'delete']);

// ask.mjs:449
if (step.command === 'opp') return EXECUTABLE_OPP_SUBCOMMANDS.has(step.subcommand);
```

`invoice` and `appointment` are absent from `EXECUTABLE_WRITE_COMMANDS`. `opp` is present but
gated through `EXECUTABLE_OPP_SUBCOMMANDS`, which excludes `update`. Lines 753-754 additionally
refuse mixed batches containing these commands. `send cancel` is excluded at line 453.

**Result: VERIFIED.** All three exclusions are in force. A `sizmo ask "send invoice …" --confirm`
will print the resolved command and exit without firing it.

---

### Claim 5 — 3.0.0 breaking change: destructive one-liner requires preview

**Source:** CHANGELOG.md (3.0.0) and AGENTS.md / SKILL.md — "Anything DESTRUCTIVE (delete, cancel)
refuses that shortcut: it previews the exact record and exits 5, so a second bare
`sizmo ask --confirm` is required."

**Verification:** `commands/ask.mjs`

```js
// ask.mjs:321
const DESTRUCTIVE_SUBCOMMANDS = new Set(['delete', 'cancel', 'remove', 'void']);

// ask.mjs:797-830 (abbreviated)
const destructive = result.concrete.filter(isDestructive);
if (ctx.confirmed && !destructive.length) { /* non-destructive one-liner path — fires */ }
const blockedOneShot = ctx.confirmed && destructive.length > 0;
// → exits with preview + exit 5, blockedOneShot:true in JSON envelope
```

When `--confirm` is passed alongside a sentence containing a destructive step:
- non-destructive steps: fire immediately (unchanged behaviour)
- destructive steps: blocked, preview printed, `blockedOneShot: true` + `reason: 'destructive_requires_preview'` in JSON, exits 5
- a bare `sizmo ask --confirm` then fires the cached plan

**Result: VERIFIED.** The gate is in place. The AGENTS.md/SKILL.md documentation accurately
describes the 3.0.0 behaviour.

---

## Summary table

| Claim | Status | Evidence |
|-------|--------|----------|
| PIT never in argv | ✅ TRUE (underlying) | `commands/init.mjs:26` comment; no bare `--pit` in source |
| PIT audit recipe description | 🔧 DOC BUG FIXED | `grep "'--pit'"` returns zero output, not `--pit-stdin`/`--pit-env` as described |
| Egress: seven hosts | ✅ VERIFIED | grep output = 7 hosts, matches doc exactly |
| Fetch: five call sites, three files | ✅ VERIFIED | `http.mjs` ×2, `llm.mjs` ×2, `update-notify.mjs` ×1 |
| `ask` never fires invoice/appointment/opp update | ✅ VERIFIED | `EXECUTABLE_WRITE_COMMANDS`, `EXECUTABLE_OPP_SUBCOMMANDS`, line 449 |
| 3.0.0 destructive one-liner requires preview | ✅ VERIFIED | `DESTRUCTIVE_SUBCOMMANDS` set, `blockedOneShot` guard, lines 797-830 |

---

## Files changed

- `SECURITY.md` — PIT guarantee row: updated verify column description. The grep command is
  unchanged; only the description of what it returns was corrected ("nothing" instead of
  "only `--pit-stdin` / `--pit-env`"). Added a second positive-confirmation grep.

## Files NOT changed

- All source files — all underlying security properties verified correct.

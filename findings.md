# findings — 2026-07-26 — claim-verification

## What was done

Verified 5 specific, falsifiable claims from README.md, SECURITY.md, and SKILL.md against actual
source code. Claims chosen for trust-impact on a stranger handing this tool a live CRM token.
Found one real bug (business writes not supporting `--dry-run`) and one misleading audit recipe.

---

## Claims verified + evidence

### Claim 1 — PIT never in argv

**Source:** SECURITY.md — "There is no `--pit` flag, so your token never lands in shell history,
`ps`, or process args."

**Command run:**
```
grep -rn "\-\-pit" lib/ commands/
```

**Output (abbreviated):**
```
lib//cli.mjs:354:      if (rest.includes('--pit-stdin')) {
lib//cli.mjs:364:      } else if (flag('--pit-env')) {
commands//init.mjs:26:  // local flag parse — NOTE: no --pit flag exists by design.
```

**Result: VERIFIED.** Only `--pit-stdin` and `--pit-env` exist. `init.mjs:26` has an explicit
code comment confirming this is intentional.

---

### Claim 2 — Zero runtime dependencies (audit recipe)

**Source:** SECURITY.md — "Zero runtime dependencies. Verify: `cat package.json` → `"dependencies": {}`."

**Finding: RECIPE MISLEADS (low severity).** The zero-dep claim is true. But `package.json` has
NO `"dependencies"` key at all — the field is omitted entirely rather than set to `{}`. Running
`cat package.json` will NOT show `"dependencies": {}`. A user following the self-audit recipe
would look for that key, find nothing, and be confused.

Evidence — full `package.json` keys: `name`, `version`, `description`, `type`, `bin`, `engines`,
`scripts`, `author`, `license`, `keywords`, `repository`, `bugs`, `homepage`, `files`, `publishConfig`.
No `dependencies`. No `devDependencies`.

**No code fix applied.** The underlying claim (zero runtime deps) is correct. The SECURITY.md
recipe should say: "`cat package.json` — you will NOT see a `dependencies` key; npm omits it
when the map would be empty. Zero entries = zero deps."

---

### Claim 3 — Update check skipped under `--json` and when piped

**Source:** README.md — "It never runs under `--json` or when output is piped."

**Verification:** `bin/sizmo.mjs:19`
```js
if (!noUpdateFlag && !argv.includes('--json') && !argv.includes('--ndjson') && process.stderr.isTTY) {
```

**Result: VERIFIED.** All four skip conditions enforced: `--json`, `--ndjson`, non-TTY stderr
(piped), and `--no-update-check` / `NO_UPDATE_NOTIFIER` env (handled inside `checkForUpdate`).

---

### Claim 4 — `--dry-run` available on ALL writes

**Source:** README.md — "`--dry-run` available on all writes. Shows the change description without
executing. Exits 0."

**Verification method:** `lib/confirm.mjs` implements the `dryRun` path in `requireConfirm()`.
Commands that call `requireConfirm()` get `--dry-run` automatically. Grepped for `requireConfirm`
across all write commands:

```
grep -rn "requireConfirm" commands/ (count mode)
→ field.mjs:3, contact.mjs:4, value.mjs:3, send.mjs:3, tag.mjs:2,
  calendar.mjs:3, opp.mjs:5, invoice.mjs:3, link.mjs:3,
  appointment.mjs:4, note.mjs:2
  (11 files, 35 total hits)
```

**Finding: BUG — `business create` and `business delete` missing `--dry-run` support.**

`commands/business.mjs` was NOT in the list. It checked `ctx.confirmed` manually:

```js
// BEFORE (broken) — commands/business.mjs:100
if (!ctx.confirmed) {
  ctx.out.line(`  rerun with --confirm to create`);
  return EXIT.CONFIRM;   // exits 5 whether --dry-run was passed or not
}
```

`ctx.dryRun` was never consulted. `sizmo business create --name "X" --dry-run` exited 5 instead
of 0, showed plain prose instead of the structured JSON confirm envelope, and was incapable of
emitting the `{status:'dry_run', changes, confirmCommand}` shape `--json` consumers expect.

**Fix applied in this run** (`commands/business.mjs`):
- Added `import { requireConfirm } from '../lib/confirm.mjs';`
- Replaced manual `if (!ctx.confirmed)` blocks in `createBusiness` and `deleteBusiness` with
  `requireConfirm({command, changes, rerunCommand}, ctx)` calls — same pattern as all other
  write commands
- Removed spurious `--confirm` entry from command `meta.flags` (global router strips `--confirm`
  before any command's `parseArgs` sees it; declaring it at command level only polluted help output)

**Test suite after fix:** `node --test --test-concurrency=1` → `606/606 pass`.

---

### Claim 5 — No `invoice void` command

**Source:** SKILL.md — "# Invoices — draft/send only, there is no void/charge command"
(Previous failure class: SKILL.md once documented `invoice void` which never existed in source.)

**Verification:** Read `commands/invoice.mjs` in full.

```js
export async function run(args, ctx) {
  const sub = args._?.[0];
  if (sub === 'draft') return draftInvoice(args, ctx);
  if (sub === 'send') return sendInvoice(args, ctx);
  throw new GhlError('usage: sizmo invoice draft ... | sizmo invoice send ...', EXIT.USAGE, ...);
}
```

**Result: VERIFIED.** Only `draft` and `send` exist. Any other subcommand throws `EXIT.USAGE`.
The ghost `invoice void` has been fully removed; SKILL.md's explicit disclaimer is accurate.

---

## Summary table

| Claim | Status | Evidence location |
|-------|--------|-------------------|
| PIT never in argv | ✅ VERIFIED | `commands/init.mjs:26`, `lib/cli.mjs:354,364` |
| Zero deps audit recipe | ⚠ RECIPE MISLEADS | `package.json` has no `dependencies` key; SECURITY.md says `"dependencies": {}` |
| Update check skipped under `--json`/pipe | ✅ VERIFIED | `bin/sizmo.mjs:19` |
| `--dry-run` on all writes | 🐛 BUG FIXED | `commands/business.mjs` — now uses `requireConfirm`; 606/606 tests pass |
| No `invoice void` command | ✅ VERIFIED | `commands/invoice.mjs:41-44` |

## Files changed

- `commands/business.mjs` — import `requireConfirm`; replace manual `ctx.confirmed` checks with
  `requireConfirm()` in `createBusiness` and `deleteBusiness`; remove spurious `--confirm` from
  meta flags. All 606 tests pass after the change.

## Files NOT changed

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

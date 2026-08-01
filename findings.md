# findings — 2026-08-02 — claim-verification

## What was done

Verified 5 specific, falsifiable claims from SECURITY.md, SKILL.md, and AGENTS.md against actual
source code in the 3.0.0 release. Claims chosen for trust-impact on a stranger handing this tool
a live CRM token. Found one documentation bug (PIT verification recipe description), fixed it.
All other claims verified correct.

---

## Claims verified + evidence

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

# findings — 2026-10-15 — docs hygiene: `invoice void` was real but documented as nonexistent

## What was wrong

`sizmo invoice void <invoiceId>` is a fully shipped, tested command (added in commit `a756e57`,
"feat(invoice): sizmo invoice void — take back an invoice that should not have gone out", 2026-08-11).
It is in the command's own subcommand list, has a dedicated handler, and has its own test file.

```
$ grep -n "SUBCOMMANDS" commands/invoice.mjs
const SUBCOMMANDS = ['list', 'draft', 'send', 'void'];

$ grep -c "." test/commands/invoice-void.test.mjs
# file exists, exercises confirm-gate, fetch-first preview, 401/403/404, already-paid warning, etc.

$ git log --oneline -1 -S"'void'" -- commands/invoice.mjs
a756e57 feat(invoice): sizmo invoice void — take back an invoice that should not have gone out
```

But `AGENTS.md` (Codex/Cursor's entire briefing on this CLI) and `SKILL.md` (Claude Code's entire
briefing) both stated the opposite, verbatim and unchanged since before the feature shipped:

```
# Invoices — draft/send only, there is no void/charge command
```

- `AGENTS.md:211`
- `SKILL.md:185`

Worse, `test/docs/agent-docs-drift.test.mjs` had a test that actively **enforced** this false
claim — a regression pin left over from when `invoice void` genuinely *was* a 2.4.8 fabrication
that had never been built:

```js
test('neither agent doc resurrects the non-existent `invoice void` command', () => {
  // Documented for real in SKILL.md until 2.4.8. It has never existed.
  for (const [label, doc] of [['SKILL.md', SKILL], ['AGENTS.md', AGENTS]]) {
    assert.ok(!/invoice\s+void/i.test(doc), ...);
  }
});
```

Once `a756e57` shipped the real command on 2026-08-11, this test's premise flipped from true to
false, but nobody updated it — so a green test suite was actively *blocking* correct documentation
of a real, shipped, confirm-gated money-surface command. Confirmed this was the state before my
change: `node --test test/docs/agent-docs-drift.test.mjs` passed 13/13 with the stale claim intact.

## Why it matters

`AGENTS.md`'s own header says it is "the file an AI coding agent reads before writing" — same
framing `SKILL.md` carries for Claude Code. An agent told "there is no void command" for an invoice
that should not have gone out has exactly one documented way forward: the raw `sizmo api` escape
hatch. That is precisely the risk `a756e57`'s commit message says `invoice void` was built to
eliminate ("the only route was the raw `sizmo api` escape hatch, under time pressure, against a
document a customer has already seen"). The docs were steering agents back into the hazard the
feature exists to remove — on a money surface, where the operation is irreversible.

## What was changed

1. **`AGENTS.md`** — replaced the false claim with the real one and added the usage line:
   ```
   # Invoices — draft/send/void, there is no card-charge command
   sizmo invoice draft --contact <id> --item "Session:5000" [--currency PHP --due 2026-08-01] --confirm
   sizmo invoice send <invoiceId> --confirm
   sizmo invoice void <invoiceId> --confirm   # cannot be undone — fetches + shows the record first
   ```
2. **`SKILL.md`** — identical fix, same three lines.
3. **`commands/invoice.mjs`** line 1 — the file-header comment ("LIST invoices, create a DRAFT
   invoice for a contact, or SEND an existing one") omitted the fourth, already-implemented verb.
   Changed to "...SEND or VOID an existing one."
4. **`test/docs/agent-docs-drift.test.mjs`** — flipped the backwards regression pin into a correct
   positive assertion (mirroring the existing `ack is documented in both docs` pattern right below
   it), with a comment explaining why the assertion direction changed and when:
   ```js
   test('invoice void is documented in both agent docs now that it is real (shipped a756e57)', () => {
     for (const [label, doc] of [['SKILL.md', SKILL], ['AGENTS.md', AGENTS]]) {
       assert.ok(/invoice\s+void/i.test(doc), ...);
     }
   });
   ```

## Verification

```
$ node --test test/docs/agent-docs-drift.test.mjs
# tests 13
# pass 13
# fail 0

$ node --test --test-concurrency=1
# tests 1263
# pass 1263
# fail 0
```

Full suite run (all 1263 tests, concurrency 1, matching `npm test`'s own invocation) passes clean
after the change — no other test depended on the old wording.

## Files changed

- `AGENTS.md`
- `SKILL.md`
- `commands/invoice.mjs` (comment only, no behavior change)
- `test/docs/agent-docs-drift.test.mjs`

## Files NOT changed

- `README.md` — does not make the false "no void" claim (it simply doesn't mention `invoice void`
  in its command tables). The existing drift tests check command-level coverage, not subcommand-level,
  so README's omission doesn't trip any guard and isn't a contradiction, just a smaller gap than the
  one fixed here. Left alone to keep this change small and scoped to the actual false claim.
- `docs/api-coverage.md` / `docs/api-inventory.json` — already correctly list `void-invoice` as
  implemented; these were accurate.
- `CHANGELOG.md` — the 2026-08-11 entry already documents `invoice void` correctly; only the two
  agent-facing reference docs and their guarding test were stale.
- All other command source files — read-only this run; no other doc/code mismatches found.

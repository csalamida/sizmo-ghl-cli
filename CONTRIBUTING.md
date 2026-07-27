# Contributing

Thanks for looking at sizmo. A few rules before you open a PR.

## Ground rules

- **No card-charging path.** Every write — operational *or* money — is confirm-gated. sizmo never charges, captures, collects or refunds: GoHighLevel exposes no public endpoint for it, and no PR may add one.
  **It does draft and send invoices** (`invoice draft`, `invoice send`) when your PIT carries `invoices.write` — a sent invoice is a real document a customer receives. Payments and transactions are read-only; invoices are not. (This bullet used to say the opposite, contradicting both the shipped code and `SECURITY.md`.) Any PR that adds a charge/capture/refund path will be closed.
- **No new scopes.** Do not add GoHighLevel API scopes beyond what is already used.
- **No secrets in code.** No PITs, no location IDs, no personal paths. The test suite uses synthetic IDs (e.g. `LOC_TEST_000`, `pit-TEST...`).
- **Tests must pass.** Run `npm test` before opening a PR — the full suite must stay green. Add tests for new behavior.
  Use `npm test`, not a bare `node --test`: the script pins `--test-concurrency=1`, because several
  suites swap `XDG_CONFIG_HOME` and `process.env` around a shared profile store. A version of that
  pattern once corrupted a real profile through an unawaited async race (see the note at the top of
  `test/client/router-verb.test.mjs`).

## Development setup

```sh
git clone <repo>
cd sizmo-ghl-cli
node --version   # must be 22+
npm test         # run the test suite (pins --test-concurrency=1)
```

No `npm install` needed — zero production dependencies.

## Running tests

```sh
npm test
```

All tests run in-process against mock HTTP. No live GoHighLevel connection required to run the test suite.

## Adding a new recipe command

1. Create `commands/your-command.mjs` — export `meta` (name, summary, flags, readOnly: true) and `run(args, ctx)`
2. Add it to `lib/registry.mjs`
3. Write tests in `test/commands/your-command.test.mjs` + a golden fixture in `test/golden/`
4. Run `npm test` — all tests pass
5. Update the `README.md` command table **by hand** — nothing generates it. `test/docs/agent-docs-drift.test.mjs`
   checks it against the source and will fail your PR if a command or its key flags are missing.
   (This step used to claim the table "is generated from `sizmo schema`". No such generator exists,
   so contributors reasonably left the table alone and hit the drift guard instead.)

## Security & secrets

Never commit secrets. Your Private Integration Token (PIT) belongs in `~/.config/sizmo/profiles.json` (chmod 600) or the `GHL_PIT` environment variable — **never** in the repo. `.gitignore` excludes `.env*` and the config directory.

Before opening a PR, run a secret scan — e.g. [gitleaks](https://github.com/gitleaks/gitleaks):

```sh
gitleaks detect --source .
```

Any PR that adds a credential, token, real location id, or `.env` file will be rejected. Maintainers run an additional review before each release.

## Releasing (maintainers)

**A release is never published from an uncommitted or untagged tree.** Versions 0.7.0–0.9.0 once
shipped to npm while git was stuck at 0.6.0 — no commit, no tag, no traceable source. That can't
happen again: `scripts/prepublish-gate.mjs` runs in `prepublishOnly` and **aborts `npm publish`**
unless the working tree is clean and HEAD is tagged `vX.Y.Z` matching `package.json`. There is no
bypass flag.

The ritual, in order:

```sh
# 1. bump the version in package.json
# 2. update CHANGELOG.md (move [Unreleased] → the new version)
npm test                          # full suite green
git add -A && git commit -m "..."  # commit everything (gate requires a clean tree)
git tag -a vX.Y.Z -m "..."         # tag must match package.json (gate requires it at HEAD)
npm publish                        # prepublish-gate + tests run automatically; aborts if not clean+tagged
git push origin main --tags        # publish the history + tag
```

Maintainers also run the out-of-tree secret/moat scan before pushing public.

## Code style

- ESM only (`type: "module"` in package.json)
- No dependencies. Keep it that way.
- File names: `kebab-case.mjs`
- Each command is self-contained — no shared mutable state between commands

## Disclaimer

sizmo is unofficial and not affiliated with HighLevel. Contributors agree that their contributions are also unofficial and unaffiliated.

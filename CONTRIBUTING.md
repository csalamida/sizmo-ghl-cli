# Contributing

Thanks for looking at sizmo. A few rules before you open a PR.

## Ground rules

- **Read-only only.** This tool never writes to GoHighLevel. Any PR that adds write capability — creating contacts, sending messages, issuing invoices, charging payments — will be closed.
- **No new scopes.** Do not add GoHighLevel API scopes beyond what is already used.
- **No secrets in code.** No PITs, no location IDs, no personal paths. The test suite uses synthetic IDs (e.g. `LOC_TEST_000`, `pit-TEST...`).
- **Tests must pass.** Run `node --test` before opening a PR. All 124 tests must stay green. Add tests for new behavior.

## Development setup

```sh
git clone <repo>
cd sizmo-cli
node --version   # must be 20+
node --test      # run the test suite
```

No `npm install` needed — zero production dependencies.

## Running tests

```sh
node --test
```

All tests run in-process against mock HTTP. No live GoHighLevel connection required to run the test suite.

## Adding a new recipe command

1. Create `commands/your-command.mjs` — export `meta` (name, summary, flags, readOnly: true) and `run(args, ctx)`
2. Add it to `lib/registry.mjs`
3. Write tests in `test/commands/your-command.test.mjs` + a golden fixture in `test/golden/`
4. Run `node --test` — all tests pass
5. Update `README.md` command table (the table is generated from `sizmo schema`)

## Security & secrets

Never commit secrets. Your Private Integration Token (PIT) belongs in `~/.config/sizmo/profiles.json` (chmod 600) or the `GHL_PIT` environment variable — **never** in the repo. `.gitignore` excludes `.env*` and the config directory.

Before opening a PR, run a secret scan — e.g. [gitleaks](https://github.com/gitleaks/gitleaks):

```sh
gitleaks detect --source .
```

Any PR that adds a credential, token, real location id, or `.env` file will be rejected. Maintainers run an additional review before each release.

## Code style

- ESM only (`type: "module"` in package.json)
- No dependencies. Keep it that way.
- File names: `kebab-case.mjs`
- Each command is self-contained — no shared mutable state between commands

## Disclaimer

sizmo is unofficial and not affiliated with HighLevel. Contributors agree that their contributions are also unofficial and unaffiliated.

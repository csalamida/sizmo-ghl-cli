#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { run } from '../lib/cli.mjs';
import { checkForUpdate, updateNotice } from '../lib/update-notify.mjs';

// Strip the notifier-only flag before the command parser sees it (route's parseArgs would
// reject it as unknown). Its presence is a per-run opt-out, alongside the env opt-outs.
const rawArgv = process.argv.slice(2);
const noUpdateFlag = rawArgv.includes('--no-update-check');
const argv = rawArgv.filter(a => a !== '--no-update-check');

const code = await run(argv);

// Update check — runs AFTER the command, NEVER affects the exit code. Skipped when:
//   · --json or --ndjson is present (the machine path must stay byte-clean)
//   · stderr is not a TTY (don't pollute piped logs)
//   · --no-update-check was passed (env opt-outs are handled inside checkForUpdate)
try {
  if (!noUpdateFlag && !argv.includes('--json') && !argv.includes('--ndjson') && process.stderr.isTTY) {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const notice = updateNotice(await checkForUpdate({ current: pkg.version }));
    if (notice) process.stderr.write(notice);
  }
} catch { /* notifier is best-effort — never let it change the outcome */ }

process.exit(code ?? 0);

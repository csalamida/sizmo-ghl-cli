#!/usr/bin/env node
// scripts/daily-loop/run.mjs — daily recurring engineering loop orchestrator.
//
// Deterministic Node script — NOT an agent. This is the actual safety boundary: the LLM agent
// (dispatched below via `claude -p`) only ever produces a diff + findings.md in an isolated git
// worktree. THIS script — plain code, no LLM in the loop — is the only thing that ever commits,
// pushes, or opens a PR.
//
// The agent runs DEFAULT-DENY: --permission-mode default + an explicit --allowedTools allowlist
// (SAFETY_ALLOWED_TOOLS). Nothing not on that list is reachable — not because it's blocked, but
// because it was never granted. No TTY is present to approve an ad hoc request, so anything off
// the allowlist is refused outright rather than hanging. This replaced an earlier draft that used
// --permission-mode bypassPermissions + a hand-written denylist; the permission classifier
// correctly flagged that as weaker (a denylist can be incomplete; an allowlist can't grant what
// isn't on it).
//
// Never auto-merges, never runs npm publish, never touches main. Every run notifies Discord and
// logs to MC OS — success, "nothing found," failure, or timeout. Silence is not an allowed state.
//
// Kill switch: touch scripts/daily-loop/PAUSED to skip runs without touching cron/launchd.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LANES, laneForDate, SAFETY_ALLOWED_TOOLS, REPO_SLUG } from './config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const PAUSE_FLAG = join(__dirname, 'PAUSED');
const MAX_RUNTIME_MS = 20 * 60 * 1000; // 20 min hard kill
const MAX_BUDGET_USD = '3';

async function notify({ title, body, kind }) {
  try {
    const { notifyDiscord } = await import(
      '/Users/cjay1107/Desktop/clawd-local/Clawd Projects/mission-control-os/scripts/notify.mjs'
    );
    await notifyDiscord({ title, body, kind, agent: 'daily-loop' });
  } catch (e) {
    console.error('discord notify failed (non-fatal):', e.message);
  }
}

function logToMcos(laneKey, outcome, summary, prUrl) {
  try {
    execFileSync('node', [join(__dirname, 'mcos-log-run.mjs'), laneKey, outcome, summary, prUrl || ''], { stdio: 'inherit' });
  } catch (e) {
    console.error('mcos log failed (non-fatal):', e.message);
  }
}

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', cwd: REPO_ROOT, ...opts }).trim();
}

// Smoke-tests each candidate with --version rather than just checking it exists — a broken
// binary (wrong platform/arch, dangling symlink) can be present on disk and still unusable.
function resolveClaudeBin() {
  const home = process.env.HOME || '';
  const candidates = ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', join(home, '.local/bin/claude')];
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    try {
      execFileSync(c, ['--version'], { timeout: 5000, stdio: 'pipe' });
      return c;
    } catch { /* try next candidate */ }
  }
  throw new Error(`no working claude binary found — tried: ${candidates.join(', ')}`);
}

async function main() {
  const today = new Date();
  // Local date, not UTC — laneForDate() below uses date.getDay() (local), so the branch/log
  // date string must match it. toISOString() is UTC and drifts a day behind local time for any
  // hour before UTC midnight (e.g. 7am in UTC+8 is still "yesterday" in UTC), which caused the
  // 2026-07-15 run to recompute 2026-07-14's exact branch name and collide with the already-
  // merged PR #2 branch — real push failure, not cosmetic.
  const dateStr = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, '0'),
    String(today.getDate()).padStart(2, '0'),
  ].join('-');

  if (existsSync(PAUSE_FLAG)) {
    console.log('PAUSED flag present — skipping run.');
    await notify({ title: 'Daily loop — paused', body: `${dateStr}: PAUSED flag present, skipped.`, kind: 'info' });
    return;
  }

  const lane = laneForDate(today);
  if (!lane) {
    console.log(`No lane scheduled for ${dateStr} (weekend) — skipping.`);
    return; // no notify — weekends are expected silence, not a failure
  }

  console.log(`=== Daily loop: ${dateStr} · lane=${lane.key} ===`);

  // Idempotency: skip if a prior daily-loop PR is still open awaiting review.
  let openPrs = [];
  try {
    const json = sh('gh', ['pr', 'list', '--repo', REPO_SLUG, '--state', 'open', '--json', 'headRefName,url']);
    openPrs = JSON.parse(json).filter(p => p.headRefName.startsWith('daily-loop/'));
  } catch (e) {
    console.error('gh pr list failed — proceeding anyway:', e.message);
  }
  if (openPrs.length > 0) {
    const summary = `${openPrs.length} daily-loop PR(s) still open awaiting review — skipping today's run.`;
    console.log(summary);
    await notify({ title: `Daily loop [${lane.key}] — skipped`, body: `${summary}\n${openPrs.map(p => p.url).join('\n')}`, kind: 'info' });
    logToMcos(lane.key, 'clean', summary);
    return;
  }

  const branch = `daily-loop/${dateStr}-${lane.key}`;
  const worktreeDir = mkdtempSync(join(tmpdir(), `sizmo-daily-loop-${lane.key}-`));
  let outcome = 'clean';
  let summary = '';
  let prUrl = '';

  try {
    // Fresh worktree off latest main — never the possibly-stale local checkout. A crashed prior
    // attempt on the same day can leave the branch name behind (worktree remove doesn't delete
    // the branch pointer) — clear it first so a retry isn't blocked by its own last failure.
    sh('git', ['fetch', 'origin', 'main']);
    try { sh('git', ['branch', '-D', branch]); } catch { /* didn't exist, fine */ }
    sh('git', ['worktree', 'add', '-b', branch, worktreeDir, 'origin/main']);

    // Resolve an ABSOLUTE path to a claude binary that actually runs — never rely on inherited
    // PATH. Verified live 2026-07-06: a stale ~/.local/bin/claude symlink (pointing at a Linux
    // ELF binary, not macOS Mach-O) sits earlier in PATH than the real /opt/homebrew/bin/claude
    // in at least one invocation context. A bare `spawn('claude', …)` hit that broken one and
    // failed with ENOEXEC. Each candidate is smoke-tested with --version, not just checked for
    // existence, since the broken file DOES exist — it just can't execute.
    const claudeBin = resolveClaudeBin();

    const child = spawn(claudeBin, [
      '-p', lane.prompt,
      '--permission-mode', 'default',
      '--allowedTools', SAFETY_ALLOWED_TOOLS,
      '--model', 'sonnet',
      '--max-budget-usd', MAX_BUDGET_USD,
      '--no-session-persistence',
    ], { cwd: worktreeDir, stdio: ['ignore', 'pipe', 'pipe'] });

    let stderrBuf = '';
    child.stdout.on('data', d => process.stdout.write(d));
    child.stderr.on('data', d => { process.stderr.write(d); stderrBuf += d.toString(); });

    const { timedOut, exitCode, spawnError } = await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ timedOut: true, exitCode: null, spawnError: null }); }, MAX_RUNTIME_MS);
      child.on('error', (err) => { clearTimeout(timer); resolve({ timedOut: false, exitCode: null, spawnError: err }); });
      child.on('exit', (code) => { clearTimeout(timer); resolve({ timedOut: false, exitCode: code, spawnError: null }); });
    });

    if (spawnError) {
      // Should be unreachable now that resolveClaudeBin() smoke-tests the binary first — kept
      // as a hard backstop so a spawn-level failure is never misreported as "clean."
      outcome = 'failed';
      summary = `Lane "${lane.key}" failed to launch claude: ${spawnError.message}`;
    } else if (timedOut) {
      outcome = 'timeout';
      summary = `Lane "${lane.key}" exceeded ${MAX_RUNTIME_MS / 60000} min — killed.`;
    } else if (exitCode !== 0) {
      // A non-zero exit (rate limit hit, auth issue, crash) must never fall through to the
      // "no diff => clean" check below — that's exactly how a real failure gets silently
      // misreported as "ran fine, found nothing." Distinguish them explicitly.
      outcome = 'failed';
      summary = `Lane "${lane.key}" exited ${exitCode}: ${stderrBuf.slice(-500) || '(no stderr captured)'}`;
    } else {
      const status = sh('git', ['status', '--porcelain'], { cwd: worktreeDir });
      if (!status) {
        outcome = 'clean';
        summary = `Lane "${lane.key}" ran, found nothing to change.`;
      } else {
        const findingsPath = join(worktreeDir, 'findings.md');
        const findings = existsSync(findingsPath)
          ? readFileSync(findingsPath, 'utf8')
          : '(agent produced a diff but did not write findings.md — see the diff directly)';

        sh('git', ['add', '-A'], { cwd: worktreeDir });
        sh('git', ['commit', '-m', `daily-loop: ${lane.key} — ${dateStr}`], { cwd: worktreeDir });
        sh('git', ['push', '-u', 'origin', branch], { cwd: worktreeDir });
        prUrl = sh('gh', [
          'pr', 'create', '--repo', REPO_SLUG, '--draft',
          '--title', `Daily loop: ${lane.title} (${dateStr})`,
          '--body', findings, '--head', branch, '--base', 'main',
        ], { cwd: worktreeDir });

        outcome = 'pr';
        summary = `Lane "${lane.key}" opened a draft PR — review before merging.`;
      }
    }
  } catch (e) {
    outcome = 'failed';
    summary = `Lane "${lane.key}" failed: ${e.message}`;
    console.error(summary);
  } finally {
    try { sh('git', ['worktree', 'remove', '--force', worktreeDir]); } catch { /* best-effort cleanup */ }
    // Local branch ref is redundant once pushed (origin has it) and just clutter otherwise —
    // always drop it so a retry never trips over its own prior branch name.
    try { sh('git', ['branch', '-D', branch]); } catch { /* best-effort cleanup */ }
  }

  const kindMap = { pr: 'success', clean: 'info', failed: 'failure', timeout: 'failure' };
  await notify({
    title: `Daily loop [${lane.key}] — ${outcome}`,
    body: `${summary}${prUrl ? `\n${prUrl}` : ''}`,
    kind: kindMap[outcome],
  });
  logToMcos(lane.key, outcome, summary, prUrl);

  console.log(`=== Done: ${outcome} ===`);
}

main().catch(async (e) => {
  console.error('daily-loop crashed:', e);
  await notify({ title: 'Daily loop — CRASHED', body: String(e?.stack || e), kind: 'failure' });
  process.exitCode = 1;
});

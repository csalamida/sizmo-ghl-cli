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

async function main() {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10);

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
    // Fresh worktree off latest main — never the possibly-stale local checkout.
    sh('git', ['fetch', 'origin', 'main']);
    sh('git', ['worktree', 'add', '-b', branch, worktreeDir, 'origin/main']);

    const child = spawn('claude', [
      '-p', lane.prompt,
      '--permission-mode', 'default',
      '--allowedTools', SAFETY_ALLOWED_TOOLS,
      '--model', 'sonnet',
      '--max-budget-usd', MAX_BUDGET_USD,
      '--no-session-persistence',
    ], { cwd: worktreeDir, stdio: 'inherit' });

    const timedOut = await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(true); }, MAX_RUNTIME_MS);
      child.on('exit', () => { clearTimeout(timer); resolve(false); });
    });

    if (timedOut) {
      outcome = 'timeout';
      summary = `Lane "${lane.key}" exceeded ${MAX_RUNTIME_MS / 60000} min — killed.`;
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

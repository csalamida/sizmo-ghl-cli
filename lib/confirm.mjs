// lib/confirm.mjs — exit-5 confirmation envelope. The universal agent-safety gate.
//
// RULE: a write command must NEVER fire silently. Every write call passes here first.
//   ctx.confirmed  (--confirm flag) → proceed:true (execute)
//   ctx.dryRun     (--dry-run flag) → shows change description, status:'dry_run', exits 0, never executes
//   neither         → prints/emits the envelope, exits 5 (CONFIRM), never executes
//
// The agent pattern:
//   1. Agent runs command WITHOUT --confirm → sees exit 5 + confirmCommand
//   2. Agent surfaces the change to a human for approval
//   3. Human approves → agent reruns with --confirm → write fires
import { EXIT } from './errors.mjs';

/**
 * requireConfirm({ command, changes, rerunCommand }, ctx)
 * @param {object} opts
 * @param {string}   opts.command        short name of the command being gated (e.g. 'tag')
 * @param {string[]} opts.changes        human-readable lines describing the exact change
 * @param {string}   opts.rerunCommand   verbatim CLI string to rerun with --confirm
 * @param {object} ctx                   ctx from buildCtx — reads ctx.confirmed, ctx.dryRun, ctx.out
 * @returns {{ proceed: boolean, code: number }}
 */
export function requireConfirm({ command, changes, rerunCommand }, ctx) {
  // --confirm → proceed
  if (ctx.confirmed) return { proceed: true, code: EXIT.OK };

  // --dry-run → show but never execute, exit 0
  if (ctx.dryRun) {
    ctx.out.data({ status: 'dry_run', command, changes, confirmCommand: rerunCommand });
    ctx.out.card(() => {
      ctx.out.line(`  DRY RUN — ${command}`);
      for (const line of changes) ctx.out.line(`  ${line}`);
      ctx.out.line(`  (dry run — no write fired)`);
    });
    return { proceed: false, code: EXIT.OK };
  }

  // No --confirm → confirmation-required envelope (exit 5)
  ctx.out.data({ status: 'confirmation_required', command, changes, confirmCommand: rerunCommand });
  ctx.out.card(() => {
    ctx.out.line(`  CONFIRM REQUIRED — ${command}`);
    for (const line of changes) ctx.out.line(`  ${line}`);
    ctx.out.line(`  → rerun with --confirm to execute:`);
    ctx.out.line(`    ${rerunCommand}`);
  });
  return { proceed: false, code: EXIT.CONFIRM };
}

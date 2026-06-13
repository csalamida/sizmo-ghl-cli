// commands/ack.mjs — ack/snooze: mark a contact as handled so they stop resurfacing.
// Acked items are HIDDEN not deleted — always signaled in focus/brief footer.
// --show-acked reveals them. snooze auto-expires, item returns to queue.
// READ-ONLY toward GHL — all state is local (~/.config/sizmo/memory/<loc>.json).
//
// HONESTY contract:
//   - ack --list shows ALL active snoozes with expiry
//   - ack --clear un-snoozes (item returns immediately)
//   - expired snoozes are shown with (expired) marker in --list
//   - never silently vanishes work with no signal
import {
  addSnooze, removeSnooze, listSnoozes,
  DEFAULT_SNOOZE_MS, formatAge,
} from '../lib/memory.mjs';
import { GhlError, EXIT } from '../lib/errors.mjs';

export const meta = {
  name: 'ack',
  summary: 'snooze a contact so they stop appearing in focus/brief until the snooze expires',
  flags: [
    { name: '--for',        type: 'string', default: '7d',  desc: 'snooze duration: e.g. 7d, 48h, 30m (default 7d)' },
    { name: '--reason',     type: 'string', default: '',    desc: 'optional note why this is snoozed' },
    { name: '--list',       type: 'bool',   default: false, desc: 'show all active snoozes' },
    { name: '--clear',      type: 'string', default: '',    desc: 'un-snooze a contact by id' },
  ],
  readOnly: true, // local state only — no GHL writes
};

// parseDuration("7d") → ms; ("48h") → ms; ("30m") → ms
function parseDuration(str) {
  if (!str) return DEFAULT_SNOOZE_MS;
  const m = String(str).trim().match(/^(\d+(?:\.\d+)?)(d|h|m)$/i);
  if (!m) return null; // invalid
  const n = Number(m[1]);
  if (m[2].toLowerCase() === 'd') return Math.round(n * 86400000);
  if (m[2].toLowerCase() === 'h') return Math.round(n * 3600000);
  return Math.round(n * 60000);
}

export async function run(args, ctx) {
  const loc = ctx.cfg.loc;
  const now = ctx.now;
  const memDir = ctx.memoryDir; // injectable for tests

  // ── ack --list ───────────────────────────────────────────────────────────
  if (args.list) {
    const snoozes = listSnoozes(loc, now, memDir);

    if (!snoozes.length) {
      ctx.out.data({ location: loc, snoozes: [] });
      ctx.out.line('  No active snoozes. Use: sizmo ack <contactId> [--for 7d] [--reason "..."]');
      return 0;
    }

    const active = snoozes.filter(s => !s.expired);
    const expired = snoozes.filter(s => s.expired);

    ctx.out.data({ location: loc, snoozes, activeCount: active.length, expiredCount: expired.length });

    ctx.out.card(() => {
      ctx.out.line('\n  ACK/SNOOZE LIST — loc ' + loc);
      ctx.out.line('  ' + '─'.repeat(64));
      if (active.length) {
        ctx.out.line('  ACTIVE (' + active.length + ')');
        for (const s of active) {
          const expiresIn = formatAge(s.remainingMs).replace(' ago', '');
          const reason = s.reason ? `  "${s.reason}"` : '';
          ctx.out.line(`  ${s.contactId.padEnd(32)} expires in ${expiresIn}${reason}`);
        }
      }
      if (expired.length) {
        ctx.out.line('  EXPIRED (' + expired.length + ') — will surface again at next run');
        for (const s of expired) {
          ctx.out.line(`  ${s.contactId.padEnd(32)} (expired)`);
        }
      }
      ctx.out.line('  ' + '─'.repeat(64));
      ctx.out.line('  sizmo ack --clear <contactId> to un-snooze immediately\n');
    });
    return 0;
  }

  // ── ack --clear <contactId> ──────────────────────────────────────────────
  if (args.clear) {
    const contactId = args.clear;
    removeSnooze(loc, contactId, memDir);
    ctx.out.data({ location: loc, cleared: contactId });
    ctx.out.line(`  un-snoozed ${contactId} — will surface again in focus/brief`);
    return 0;
  }

  // ── ack <contactId> [--for 7d] [--reason "..."] ──────────────────────────
  const contactId = args._?.[0];
  if (!contactId) {
    throw new GhlError(
      'usage: sizmo ack <contactId> [--for 7d] [--reason "..."] | --list | --clear <contactId>',
      EXIT.USAGE,
      'sizmo ack --list shows current snoozes'
    );
  }

  const snoozeMs = parseDuration(args.for || '7d');
  if (snoozeMs === null) {
    throw new GhlError(
      `invalid --for value "${args.for}" — use format like 7d, 48h, 30m`,
      EXIT.USAGE,
      'examples: --for 7d · --for 48h · --for 30m'
    );
  }

  const entry = addSnooze(loc, contactId, { snoozeMs, reason: args.reason || '' }, now, memDir);
  const until = new Date(entry.snoozeUntil).toISOString().slice(0, 10);
  const reasonNote = entry.reason ? ` · "${entry.reason}"` : '';

  ctx.out.data({ location: loc, snoozed: entry });
  ctx.out.line(`  snoozed ${contactId} until ${until}${reasonNote}`);
  ctx.out.line(`  item will resurface automatically after snooze expires`);
  ctx.out.line(`  see all snoozes: sizmo ack --list`);
  return 0;
}

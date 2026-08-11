// commands/focus.mjs — One ranked action queue by money at stake.
// Reuses the 5 existing collect()s on the shared cached ctx — inherits A's speed + cache.
// Ranks via lib/prioritize.mjs (single source of truth shared with brief).
// READ-ONLY. Never sends, charges, or writes.
// Memory: ack/snooze filtering — handled items stay hidden until snooze expires.
import { EXIT } from '../lib/errors.mjs';
import { collect as pipeCollect }   from './pipeline.mjs';
import { collect as arCollect }     from './receivables.mjs';
import { collect as triageCollect } from './triage.mjs';
import { collect as noshowCollect } from './noshow.mjs';
import { collect as bnpCollect }    from './booked-not-paid.mjs';
import { rankActions, hasMixedCurrencies } from '../lib/prioritize.mjs';
import { filterSnoozed } from '../lib/memory.mjs';
import { parseAgeDays } from '../lib/dates.mjs';

export const meta = {
  name: 'focus',
  summary: 'one ranked to-do queue by money at stake',
  flags: [
    { name: '--top',        type: 'int',  default: 15,   desc: 'max items to display' },
    { name: '--stuck-days', type: 'int',  default: 7,    desc: 'idle threshold for stuck deals' },
    { name: '--no-memory',  type: 'bool', default: false, desc: 'skip snooze filtering (pure stateless run)' },
    { name: '--show-acked', type: 'bool', default: false, desc: 'include snoozed/acked items in output' },
  ],
  readOnly: true,
};

// Parse an age string like "21d", "3h", "5m" back to ageDays (fractional ok, floor to 0)

// Wrap a collect() so a throw → degraded sentinel instead of crashing focus
async function safe(name, fn, ctx) {
  try { return await fn(); }
  catch (err) {
    const msg = `${name} failed — ${(err?.message || String(err)).split('\n')[0]}`;
    ctx.out.warn(msg, { degraded: true });
    return { __error: msg };
  }
}

// ── collect: shape all lanes into rankActions input, return ranked result ─────
export async function collect(args, ctx) {
  const STUCK_DAYS = args['stuck-days'] ?? 7;
  const NOW = ctx.now;

  // Fan-out all 5 sub-collects in parallel on the same ctx (same http client, same cache)
  const [pipe, ar, triage, noshow, bnp] = await Promise.all([
    safe('pipeline',       () => pipeCollect({ 'stuck-days': STUCK_DAYS, top: 200 }, ctx), ctx),
    safe('receivables',    () => arCollect({ top: 200 }, ctx), ctx),
    safe('triage',         () => triageCollect({ days: 30, top: 200 }, ctx), ctx),
    safe('noshow',         () => noshowCollect({ days: 30, top: 200 }, ctx), ctx),
    safe('booked-not-paid',() => bnpCollect({ days: 30, top: 200 }, ctx), ctx),
  ]);

  const loc = pipe.location || ar.location || triage.location || ctx.cfg.loc;

  // ── Shape lane data into rankActions input ────────────────────────────────

  // deals: pipeline stuck — each has monetaryValue + idle string like "21d"
  const deals = pipe.__error ? [] : (pipe.stuck || []).map(d => ({
    contactId:     d.contactId,
    name:          d.name || '(unknown)',
    monetaryValue: Number(d.value) || 0,
    ageDays:       parseAgeDays(d.idle),
  }));

  // invoices: receivables list — already has due + cur + age (days)
  const invoices = ar.__error ? [] : (ar.list || []).map(i => ({
    contactId: i.id,   // receivables uses i.id as the invoice id; contactId not in list shape
    name:      i.name || '(unknown)',
    due:       Number(i.due) || 0,
    cur:       i.cur || 'PHP',
    ageDays:   Number(i.age) || 0,
  }));
  // Fix: receivables.list has no contactId in the shape. Use invoice id as fallback key.
  // The action points to 'ghl receivables' which shows the full list.

  // threads: triage.threads — has waiting string like "3d"; no monetary value
  const threads = triage.__error ? [] : (triage.threads || []).map(t => ({
    contactId: t.contactId,
    name:      t.name || '(unknown)',
    ageDays:   parseAgeDays(t.waiting),
  }));

  // noshows: noshow.list — has when (ISO), compute ageDays
  const noshows = noshow.__error ? [] : (noshow.list || []).map(n => ({
    contactId: n.contactId,
    name:      n.name || '(unknown)',
    ageDays:   Math.floor((NOW - new Date(n.when).getTime()) / 86400000),
  }));

  // neverBilled: booked-not-paid.neverBilled — no estValue in the collect output shape
  // (booked-not-paid detect they have sessions but no invoice — value unknown)
  const neverBilled = bnp.__error ? [] : (bnp.neverBilled || []).map(b => ({
    contactId: b.contactId,
    name:      b.name || '(unknown)',
    estValue:  0,   // no estimate available from this collect → goes to unknownValue group
    ageDays:   Math.floor((NOW - (b.lastSessionTs || 0)) / 86400000),
  }));

  const { ranked: allRanked, unknownValue: allUnknown } = rankActions({ deals, invoices, threads, noshows, neverBilled });
  const mixedCurrencies = hasMixedCurrencies(allRanked);

  // ── Ack/snooze filtering ──────────────────────────────────────────────────
  const noMemory = !!(args['no-memory'] || ctx.noMemory);
  const showAcked = !!(args['show-acked'] || ctx.showAcked);
  const memDir = ctx.memoryDir; // injectable for tests

  let ranked = allRanked;
  let unknownValue = allUnknown;
  let snoozedCount = 0;

  if (!noMemory && !showAcked) {
    const filteredRanked = filterSnoozed(loc, allRanked, NOW, memDir);
    const filteredUnknown = filterSnoozed(loc, allUnknown, NOW, memDir);
    ranked = filteredRanked.visible;
    unknownValue = filteredUnknown.visible;
    snoozedCount = filteredRanked.snoozedCount + filteredUnknown.snoozedCount;
  }

  return { location: loc, ranked, unknownValue, mixedCurrencies, snoozedCount };
}

// ── run: bimodal output (JSON envelope OR TTY card) ───────────────────────────
export async function run(args, ctx) {
  const TOP = args.top ?? 15;
  const data = await collect(args, ctx);

  ctx.out.data(data);

  ctx.out.card(() => {
    const W = 70;
    const bar = (ch = '─') => ch.repeat(W);
    ctx.out.line('\n  FOCUS — ranked action queue by money at stake  ·  loc ' + data.location);
    ctx.out.line('  ' + bar());

    if (!data.ranked.length && !data.unknownValue.length) {
      // "All clear" is a CLAIM ABOUT THE ACCOUNT. It may only be made when the account was
      // actually readable. Verified 2026-07-28: with every source returning 401, focus printed
      // "Nothing to action — all clear. ✅" and exited 0, while its own --json envelope in the
      // same run carried degraded:true and five warnings. One run, two contradictory answers, and
      // the reassuring one is the one a human reads.
      //
      // commands/brief.mjs already enforces exactly this ("human render never says 'All clear'
      // while degraded"). focus had simply diverged from it.
      if (ctx.out.degraded) {
        ctx.out.line('  Nothing shown — sizmo could not read your account, so this is NOT "all clear".');
        ctx.out.line('  See the warnings above; fix those and re-run.\n');
      } else {
        ctx.out.line('  Nothing to action — all clear. ✅\n');
      }
      return;
    }

    // ── MONEY-RANKED items ──────────────────────────────────────────────────
    if (data.ranked.length) {
      ctx.out.line('  RANKED BY MONEY AT STAKE');
      const show = data.ranked.slice(0, TOP);
      show.forEach((item, i) => {
        const label = (item.name || '(unknown)').slice(0, 24).padEnd(24);
        ctx.out.line(`  ${String(i + 1).padStart(2)}. ${label}  ${item.inputs}`);
        ctx.out.line(`      → ${item.action}  ·  contact ${item.contact}`);
      });
      if (data.ranked.length > TOP) ctx.out.line(`  … +${data.ranked.length - TOP} more money items`);
      ctx.out.line('');
    }

    // ── UNKNOWN VALUE items ─────────────────────────────────────────────────
    if (data.unknownValue.length) {
      ctx.out.line('  VALUE UNKNOWN — your call');
      ctx.out.line('  (no money on record; sorted oldest first — may still be urgent)');
      data.unknownValue.slice(0, TOP).forEach((item, i) => {
        const label = (item.name || '(unknown)').slice(0, 24).padEnd(24);
        ctx.out.line(`  ${String(i + 1).padStart(2)}. ${label}  ${item.inputs}`);
        ctx.out.line(`      → ${item.action}  ·  contact ${item.contact}`);
      });
      if (data.unknownValue.length > TOP) ctx.out.line(`  … +${data.unknownValue.length - TOP} more unknown-value items`);
      ctx.out.line('');
    }

    // ── Snoozed footer — signaled, never silent ──────────────────────────────
    if (data.snoozedCount > 0) {
      ctx.out.line(`  ${data.snoozedCount} snoozed (sizmo ack --list · --show-acked to reveal)`);
    }

    ctx.out.line('  ' + bar());
    ctx.out.line('  Ranked by money we can actually see (deal value, invoice amount due, est. value).');
    if (data.mixedCurrencies) {
      ctx.out.line('  ⚠ Mixed currencies detected — ranked by raw number, NOT converted. ₱1000 vs $100 is NOT comparable.');
    }
    ctx.out.line('  Read-only: I surface + point to the recipe. You act.\n');
  });

  // Exit code must distinguish "looked, found nothing" from "could not look".
  //
  // focus was not part of the earlier blind-exit sweep because it owns no fetches of its own — it
  // composes other collects, and their failures arrive as degraded warnings rather than a
  // `blocked` marker. The consequence was the same one that sweep fixed elsewhere:
  // `sizmo focus && echo "nothing urgent"` ran its second half while sizmo was blind.
  //
  // Only fires when BOTH lists are empty. A degraded run that still surfaced real actions produced
  // usable output and exits 0 — partial sight is not blindness.
  if (ctx.out.degraded && !data.ranked.length && !data.unknownValue.length) {
    const sawAuth = (ctx.out.warnings ?? []).some(w => /\b401\b|\b403\b|scope|unauthor/i.test(String(w)));
    return sawAuth ? EXIT.AUTH : EXIT.API;
  }
  return EXIT.OK;
}

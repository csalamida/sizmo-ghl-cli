// commands/receivables.mjs — A/R: who owes, how much, how old.
// Trust-fix #1: LOC from ctx.cfg.loc.
// Trust-fix #2: invoices paginate to completion (was offset-capped at 2000).
// Trust-fix #3: per-currency totals (never cross-sum).
// READ-ONLY. Invoices and payments are read-only — no charges, no voids, no sends from this command.
import { paginate } from '../lib/paginate.mjs';
import { fmtMoney as money } from '../lib/money.mjs';
import { exitForBlockedSource } from '../lib/blind.mjs';

export const meta = {
  name: 'receivables',
  summary: 'A/R — who owes, how much, how old',
  flags: [
    { name: '--top', type: 'int', default: 20, desc: 'max rows to display' },
  ],
  readOnly: true,
};

const UNPAID = new Set(['sent', 'overdue', 'partially_paid', 'partially paid', 'payment_processing', 'viewed', 'due']);

export async function collect(args, ctx) {
  const TOP = args.top ?? 20;
  const LOC = ctx.cfg.loc;
  const NOW = ctx.now;
  const ageDays = (t) => t ? Math.floor((NOW - t) / 86400000) : null;

  let firstErr = null;
  const inv = [];
  for await (const item of paginate({
    fetchPage: async (offset = 0) => {
      const r = await ctx.http.get('/invoices/', {
        query: { altId: LOC, altType: 'location', limit: 100, offset },
      });
      if (!r.ok) return { _err: r.code, invoices: [] };
      return r.j;
    },
    getItems: (resp) => {
      if (resp._err) { firstErr = resp._err; return []; }
      return resp.invoices || resp.data || [];
    },
    nextCursor: (resp, items, offset = 0) => {
      if (resp._err || items.length < 100) return null;
      return offset + 100;
    },
    maxPages: 500,
    startCursor: 0,
  })) {
    inv.push(item);
  }

  if (firstErr && inv.length === 0) {
    ctx.out.warn(`can't see invoices → HTTP ${firstErr}`, { degraded: true });
    // UNKNOWN, not zero. README states this twice as a core promise ("a blocked data source is
    // reported as unknown, never as zero" / "a blocked source is not zero — treat it as unknown")
    // and it was false here: this branch returned totalOwed:0 while holding the HTTP code that
    // proves we never saw the invoices. A consumer summing totalOwed across locations silently
    // under-counted real money owed, with nothing in the payload to distinguish "settled" from
    // "denied". null is the honest value; `blocked` carries the reason.
    // Same pattern booked-not-paid.mjs already uses (invoicesBlocked/paymentsBlocked → suppress
    // the bucket rather than assert a false zero).
    return { location: LOC, blocked: firstErr, scanned: null, outstanding: null, totalOwed: null, currency: null, list: [] };
  }

  const owed = inv
    .filter(i => UNPAID.has(String(i.status || '').toLowerCase()))
    .map(i => {
      const total = Number(i.total ?? i.amount ?? i.invoiceTotal ?? 0);
      const paid = Number(i.amountPaid ?? i.totalPaid ?? 0);
      const due = total - paid;
      const dt = Date.parse(i.dueDate || i.issueDate || i.createdAt) || 0;
      return {
        name: i.contactDetails?.name || i.name || i.invoiceNumber || '(unknown)',
        num: i.invoiceNumber || i._id || i.id,
        due, total,
        cur: (i.currency || 'PHP').toUpperCase(),
        status: i.status,
        // `age` is DAYS SINCE THE DUE DATE, so it is NEGATIVE for an invoice that is not yet due.
        // That is honest as data but was rendered as "aged -30d", which reads as a bug. `overdue`
        // is emitted alongside it so a caller does not have to infer the distinction from the sign.
        age: ageDays(dt),
        overdue: ageDays(dt) != null ? ageDays(dt) > 0 : null,
        id: i._id || i.id,
        contactId: i.contactDetails?.id || i.contactDetails?._id || i.contactId || null,
      };
    })
    .filter(x => x.due > 0.0001)
    .sort((a, b) => (b.age || 0) - (a.age || 0));

  // per-currency totals (trust-fix #3)
  const byCur = {};
  for (const x of owed) {
    byCur[x.cur] = (byCur[x.cur] || 0) + x.due;
  }
  // keep backward-compat: single currency → flat totalOwed + currency; multi → byCurrency map
  const currencies = Object.keys(byCur);
  const totalOwed = currencies.length === 1 ? byCur[currencies[0]] : Object.values(byCur).reduce((s, v) => s + v, 0);
  const currency = currencies.length === 1 ? currencies[0] : (owed[0]?.cur || 'PHP');

  return {
    location: LOC,
    scanned: inv.length,
    outstanding: owed.length,
    totalOwed,
    currency,
    ...(currencies.length > 1 ? { byCurrency: byCur } : {}),
    list: owed.slice(0, TOP),
  };
}

export async function run(args, ctx) {
  const data = await collect(args, ctx);
  ctx.out.data(data);

  const TOP = args.top ?? 20;
  ctx.out.card(() => {
    // Blocked → say so. Rendering money(null) or "Nothing outstanding. All settled. ✅" here
    // would tell the user their books are clear when the truth is we were denied the read.
    if (data.blocked) {
      ctx.out.line(`\n  RECEIVABLES — UNKNOWN · can't see invoices (HTTP ${data.blocked})  ·  loc ${data.location}`);
      ctx.out.line('  ' + '─'.repeat(72));
      ctx.out.line('  This is NOT "nothing outstanding" — the invoices could not be read at all.');
      ctx.out.line('  Add the invoices.readonly scope in GoHighLevel → Private Integrations,');
      ctx.out.line('  then rerun. `sizmo doctor` shows every blocked scope.\n');
      return;
    }
    ctx.out.line(`\n  RECEIVABLES — ${money(data.totalOwed, data.currency)} outstanding across ${data.outstanding} invoice(s)  ·  ${data.scanned} scanned  ·  loc ${data.location}`);
    ctx.out.line('  ' + '─'.repeat(72));
    if (!data.list.length) {
      ctx.out.line('  Nothing outstanding. All settled. ✅\n');
      return;
    }
    data.list.forEach((x, i) => {
      // An unpaid invoice that is not yet due belongs in an outstanding total — that part was
      // right — but it is not AGED. It used to render "aged -30d" for an invoice due in 30 days,
      // which reads as a broken number and, worse, filed a current invoice under the same heading
      // as a genuinely overdue one. Reproduced 2026-07-30.
      const aged = x.age == null ? 'age unknown'
                 : x.age < 0     ? `due in ${-x.age}d`
                 : x.age === 0   ? 'due today'
                 : x.age >= 30   ? `aged ${x.age}d ⚠`
                 :                 `aged ${x.age}d`;
      ctx.out.line(`  ${String(i + 1).padStart(2)}. ${(x.name || '?').slice(0, 24).padEnd(24)} ${money(x.due, x.cur).padStart(11)}  ${String(x.status).padEnd(14)} ${aged}`);
      ctx.out.line(`      invoice ${x.num} · id ${x.id}`);
      if (x.contactId) ctx.out.line(`      → sizmo send ${x.contactId} --channel email --message "..."   ·   sizmo open ${x.contactId}`);
    });
    if (data.outstanding > TOP) ctx.out.line(`  … +${data.outstanding - TOP} more`);
    ctx.out.line('  ' + '─'.repeat(72));
    ctx.out.line('  → Read-only. Per-row commands above are ready to run (send needs --confirm; money never moves through sizmo).\n');
  });
  // A report whose source was DENIED must not exit 0 — `sizmo receivables && ...` would
  // proceed and an agent checking $? would read "nothing found" as fact. See lib/blind.mjs.
  return exitForBlockedSource(data?.blocked);
}

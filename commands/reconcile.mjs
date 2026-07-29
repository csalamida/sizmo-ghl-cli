// commands/reconcile.mjs — Collected by source + status breakdown + flags.
// Trust-fix #1: LOC from ctx.cfg.loc.
// Trust-fix #2: transactions + subscriptions paginate to completion.
// Trust-fix #3: collected-by-source per currency (never cross-sums).
// v0.5.0: default currency from CRM model location (not hardcoded PHP).
// v0.6.0 (C2): modelMeta emitted in JSON envelope; TTY staleness note.
// READ-ONLY. NEVER charges, refunds, or collects.
import { paginate } from '../lib/paginate.mjs';
import { ENTITY_SPECS } from '../lib/model.mjs';
import { fmtMoney as m } from '../lib/money.mjs';
import { exitForBlockedSource } from '../lib/blind.mjs';

export const meta = {
  name: 'reconcile',
  summary: 'Money reconciliation — collected by source, flags, recurring',
  flags: [
    { name: '--days', type: 'int', default: 30, desc: 'window in days' },
    { name: '--top', type: 'int', default: 20, desc: 'max source rows' },
  ],
  readOnly: true,
};

const SUCCESS = new Set(['succeeded', 'success', 'paid', 'completed', 'captured']);
const srcOf = (t) =>
  (t.paymentProviderType || t.providerType || t.source || t.chargeSnapshot?.provider || t.entitySourceType || 'unknown').toString();

export async function collect(args, ctx) {
  const DAYS = args.days ?? 30;
  const LOC = ctx.cfg.loc;
  const NOW = ctx.now;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const START = NOW - DAYS * DAY_MS;
  // YYYY-MM-DD, the format list-transactions documents for startAt/endAt.
  const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
  // Mirror snapshot's inWindow normalization: numeric seconds (< 1e12) → ms.
  // GHL currently returns ISO strings, but numeric-epoch fields are defensively handled.
  const inWin = (v) => {
    const t = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : (Date.parse(v) || 0);
    return t >= START && t <= NOW;
  };

  // Location currency from CRM model (fallback PHP if model missing/blocked)
  let locationCurrency = 'PHP';
  let _reconcileModelLoaded = null;
  let modelMeta = null;
  if (ctx.ensureModel) {
    try {
      _reconcileModelLoaded = await ctx.ensureModel();
      const locCur = _reconcileModelLoaded?.entities?.location?.item?.business?.currency
        || _reconcileModelLoaded?.entities?.location?.item?.currency;
      if (locCur) locationCurrency = locCur.toUpperCase();
    } catch { /* use default */ }
  } else if (ctx.cfg.currency) {
    locationCurrency = ctx.cfg.currency;
  }
  // Build modelMeta for the JSON envelope (C2)
  if (_reconcileModelLoaded) {
    const specMap = Object.fromEntries(ENTITY_SPECS.map(s => [s.name, s]));
    const locEnt = _reconcileModelLoaded.entities?.location;
    const locSpec = specMap.location;
    const locStale = locEnt && locSpec ? (NOW - (locEnt.fetchedAt ?? 0)) > locSpec.ttlMs : false;
    modelMeta = {
      syncedAt: _reconcileModelLoaded.syncedAt,
      ageMs: NOW - _reconcileModelLoaded.syncedAt,
      stale: locStale,
      offline: !!(_reconcileModelLoaded.offline),
    };
  }

  // transactions paginated to completion (trust-fix #2)
  const txns = [];
  let txnErr = null;
  for await (const t of paginate({
    fetchPage: async (offset = 0) => {
      const r = await ctx.http.get('/payments/transactions', {
        // startAt/endAt narrow the fetch SERVER-SIDE. Without them this paginated the account's
        // entire transaction history (maxPages 500 x 100 = up to 50,000 rows) and then threw away
        // everything outside the window locally — so `reconcile --days 30` on an account with five
        // years of payments downloaded five years of payments. The parameters were there all along:
        // list-transactions documents startAt and endAt (format 2024-02-01), verified via
        // describe_operation 2026-07-28.
        //
        // PADDED BY A DAY ON EACH SIDE, deliberately. The docs give the format but not whether the
        // bounds are inclusive, nor which timezone they are interpreted in. Rather than guess at an
        // API's semantics, the server-side filter is widened so it cannot possibly exclude a
        // transaction inside the true window, and the exact millisecond filter below (`inWin`)
        // stays the authority for what actually counts. Worst case the pad costs one extra day of
        // rows; it can never cost correctness.
        query: { altId: LOC, altType: 'location', limit: 100, offset,
                 startAt: ymd(START - DAY_MS), endAt: ymd(NOW + DAY_MS) },
      });
      if (!r.ok) return { _err: r.code, data: [] };
      return r.j;
    },
    getItems: (resp) => {
      if (resp._err) { txnErr = resp._err; return []; }
      return resp.data || resp.transactions || [];
    },
    nextCursor: (resp, items, offset = 0) => {
      if (resp._err || items.length < 100) return null;
      return offset + 100;
    },
    maxPages: 500,
    startCursor: 0,
  })) {
    txns.push(t);
  }

  if (txnErr && txns.length === 0) {
    ctx.out.warn(`can't see transactions → HTTP ${txnErr}`, { degraded: true });
    // UNKNOWN, not zero — third and last money surface in this sweep (after receivables and
    // pipeline). `collected: 0` told a coach they collected nothing in the window when sizmo was
    // never allowed to read a single transaction. flags are nulled too: "0 refunds, 0 failed,
    // 0 orphans" is an equally fabricated all-clear on money that was never examined.
    return {
      location: LOC, days: DAYS, blocked: txnErr,
      scanned: null, inWindow: null, collected: null, currency: null,
      bySource: {}, byStatus: {}, flags: null, subscriptions: null,
    };
  }

  const win = txns.filter(t => inWin(t.createdAt || t.created_at || t.dateAdded));

  // per-source, per-currency (trust-fix #3 — real implementation)
  const byStatus = {};
  // byCur: { PHP: { bySource: { stripe: {c,v} }, total: n }, USD: { ... } }
  const byCur = {};
  const refunds = [], failed = [], orphans = [];

  for (const t of win) {
    const st = (t.status || t.paymentStatus || '').toLowerCase();
    byStatus[st] = (byStatus[st] || 0) + 1;
    const amt = Number(t.amount) || 0;
    const cur = (t.currency || locationCurrency).toUpperCase();
    if (SUCCESS.has(st)) {
      const s = srcOf(t);
      byCur[cur] ??= { bySource: {}, total: 0 };
      byCur[cur].bySource[s] ??= { c: 0, v: 0 };
      byCur[cur].bySource[s].c++;
      byCur[cur].bySource[s].v += amt;
      byCur[cur].total += amt;
      if (!(t.entityId || t.invoiceId || t.entitySourceType)) orphans.push(t);
    } else if (/refund/.test(st)) {
      refunds.push(t);
    } else if (/fail|declin|error/.test(st)) {
      failed.push(t);
    }
  }

  // flatten for output — single currency → backward-compat flat shape; multi → byCurrency map
  const currencies = Object.keys(byCur);
  const isSingle = currencies.length <= 1;
  const currency = isSingle ? (currencies[0] || locationCurrency) : (currencies[0] || locationCurrency);
  const collected = isSingle ? (byCur[currency]?.total ?? 0) : null;
  const byCurrency = isSingle ? null : Object.fromEntries(currencies.map(c => [c, byCur[c].total]));
  // bySource: when single currency keep flat {src:{c,v}} for backward compat; multi-currency not surfaced at top level
  const bySource = isSingle ? (byCur[currency]?.bySource ?? {}) : Object.fromEntries(
    currencies.flatMap(c => Object.entries(byCur[c].bySource).map(([s, v]) => [`${s}(${c})`, v]))
  );

  // subscriptions paginated to completion (trust-fix #2)
  let subs = null;
  const subItems = [];
  let subErr = null;
  for await (const s of paginate({
    fetchPage: async (offset = 0) => {
      const r = await ctx.http.get('/payments/subscriptions', {
        query: { altId: LOC, altType: 'location', limit: 100, offset },
      });
      if (!r.ok) return { _err: r.code, data: [] };
      return r.j;
    },
    getItems: (resp) => {
      if (resp._err) { subErr = resp._err; return []; }
      return resp.data || resp.subscriptions || [];
    },
    nextCursor: (resp, items, offset = 0) => {
      if (resp._err || items.length < 100) return null;
      return offset + 100;
    },
    maxPages: 100,
    startCursor: 0,
  })) {
    subItems.push(s);
  }

  if (!subErr) {
    const active = subItems.filter(s => /active|trialing/i.test(s.status || ''));
    // MRR per-currency — same treatment as transactions (never cross-sum currencies)
    const mrrByCur = {};
    for (const x of active) {
      const cur = (x.currency || locationCurrency).toUpperCase();
      mrrByCur[cur] = (mrrByCur[cur] || 0) + (Number(x.amount) || 0);
    }
    const mrrCurrencies = Object.keys(mrrByCur);
    const isSingleMrr = mrrCurrencies.length <= 1;
    subs = {
      active: active.length,
      total: subItems.length,
      // single-currency: flat mrr for backward compat; multi-currency: mrrByCurrency map
      ...(isSingleMrr
        ? { mrr: mrrByCur[mrrCurrencies[0]] ?? 0 }
        : { mrrByCurrency: mrrByCur }),
    };
  }

  return {
    location: LOC,
    days: DAYS,
    scanned: txns.length,
    inWindow: win.length,
    // single-currency: flat `collected` + `currency`; multi-currency: `byCurrency` map (no cross-sum)
    ...(isSingle
      ? { collected, currency }
      : { byCurrency }),
    bySource,
    byStatus,
    flags: { refunds: refunds.length, failed: failed.length, orphans: orphans.length },
    subscriptions: subs,
    ...(modelMeta ? { modelMeta } : {}),
  };
}

export async function run(args, ctx) {
  const data = await collect(args, ctx);
  ctx.out.data(data);

  const isMulti = !!data.byCurrency;
  const collectedLine = isMulti
    ? Object.entries(data.byCurrency).map(([c, v]) => m(v, c)).join(' + ')
    : m(data.collected, data.currency);
  const cur = data.currency || 'PHP';

  ctx.out.card(() => {
    // Blocked → UNKNOWN. Printing "0 collected · 0 txn in window" plus a clean flags line would
    // be a fabricated all-clear on money nobody was allowed to look at — and this render also
    // reads data.flags.*, which is null on a blocked read.
    if (data.blocked) {
      ctx.out.line(`\n  RECONCILE — UNKNOWN · can't see transactions (HTTP ${data.blocked}) · last ${data.days}d · loc ${data.location}`);
      ctx.out.line('  ' + '─'.repeat(64));
      ctx.out.line('  This is NOT "nothing collected" and NOT a clean reconciliation —');
      ctx.out.line('  no transaction was read, so refunds/failed/orphans are unknown too.');
      ctx.out.line('  Needs payments/transactions.readonly in GoHighLevel → Private Integrations.');
      ctx.out.line('  `sizmo doctor` lists every blocked scope.\n');
      return;
    }
    ctx.out.line(`\n  RECONCILE — ${collectedLine} collected · last ${data.days}d · ${data.inWindow} txn in window · loc ${data.location}`);
    // C2: model staleness note
    if (data.modelMeta) {
      const mm = data.modelMeta;
      if (mm.offline) {
        ctx.out.line(`  · CRM model OFFLINE — currency from cache`);
      } else if (mm.stale) {
        const ageD = Math.round(mm.ageMs / 86400000);
        ctx.out.line(`  · CRM model ${ageD}d old — run sizmo sync`);
      }
    }
    ctx.out.line('  ' + '─'.repeat(64));
    ctx.out.line('  BY SOURCE (succeeded)');
    const srcs = Object.entries(data.bySource).sort((a, b) => b[1].v - a[1].v);
    if (!srcs.length) ctx.out.line('    (none)');
    else for (const [s, v] of srcs) ctx.out.line(`    ${s.slice(0, 24).padEnd(24)} ${String(v.c).padStart(3)} txn  ${m(v.v, isMulti ? (s.match(/\((\w+)\)$/)?.[1] || cur) : cur).padStart(12)}`);
    ctx.out.line('\n  BY STATUS');
    for (const [s, c] of Object.entries(data.byStatus).sort((a, b) => b[1] - a[1]))
      ctx.out.line(`    ${s.slice(0, 24).padEnd(24)} ${String(c).padStart(3)}`);
    ctx.out.line('\n  FLAGS');
    ctx.out.line(`    refunds ${data.flags.refunds}  ·  failed ${data.flags.failed}  ·  orphan (no invoice/order) ${data.flags.orphans}`);
    if (data.subscriptions) {
      const sub = data.subscriptions;
      const mrrLine = sub.mrrByCurrency
        ? Object.entries(sub.mrrByCurrency).map(([c, v]) => m(v, c)).join(' + ')
        : m(sub.mrr, cur);
      ctx.out.line(`\n  RECURRING  ${sub.active} active / ${sub.total} subs  ·  ${mrrLine} per cycle`);
    } else {
      ctx.out.line("\n  RECURRING  can't see (payments/subscriptions scope absent or none)");
    }
    ctx.out.line('  ' + '─'.repeat(64));
    ctx.out.line('  Read-only. I reconcile + flag — I never charge, refund, or collect. That stays you.\n');
  });
  // A report whose source was DENIED must not exit 0 — `sizmo reconcile && ...` would
  // proceed and an agent checking $? would read "nothing found" as fact. See lib/blind.mjs.
  return exitForBlockedSource(data?.blocked);
}

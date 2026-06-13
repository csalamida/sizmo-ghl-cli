// commands/reconcile.mjs — Collected by source + status breakdown + flags.
// Trust-fix #1: LOC from ctx.cfg.loc.
// Trust-fix #2: transactions + subscriptions paginate to completion.
// Trust-fix #3: collected-by-source per currency (never cross-sums).
// v0.5.0: default currency from CRM model location (not hardcoded PHP).
// v0.6.0 (C2): modelMeta emitted in JSON envelope; TTY staleness note.
// READ-ONLY. NEVER charges, refunds, or collects.
import { paginate } from '../lib/paginate.mjs';
import { ENTITY_SPECS } from '../lib/model.mjs';

export const meta = {
  name: 'reconcile',
  summary: 'Money reconciliation — collected by source, flags, recurring',
  flags: [
    { name: '--days', type: 'int', default: 30, desc: 'window in days' },
    { name: '--top', type: 'int', default: 20, desc: 'max source rows' },
  ],
  readOnly: true,
};

const SYM = { PHP: '₱', USD: '$', EUR: '€', GBP: '£' };
const m = (n, c = 'PHP') => !Number.isFinite(Number(n)) ? '—' : (SYM[c] || c + ' ') + Number(n || 0).toLocaleString('en-PH', { maximumFractionDigits: 0 });
const SUCCESS = new Set(['succeeded', 'success', 'paid', 'completed', 'captured']);
const srcOf = (t) =>
  (t.paymentProviderType || t.providerType || t.source || t.chargeSnapshot?.provider || t.entitySourceType || 'unknown').toString();

export async function collect(args, ctx) {
  const DAYS = args.days ?? 30;
  const LOC = ctx.cfg.loc;
  const NOW = ctx.now;
  const START = NOW - DAYS * 24 * 60 * 60 * 1000;
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
        query: { altId: LOC, altType: 'location', limit: 100, offset },
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
    return {
      location: LOC, days: DAYS, scanned: 0, inWindow: 0, collected: 0, currency: locationCurrency,
      bySource: {}, byStatus: {}, flags: { refunds: 0, failed: 0, orphans: 0 }, subscriptions: null,
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
  return 0;
}

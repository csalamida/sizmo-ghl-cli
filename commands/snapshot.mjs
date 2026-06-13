// commands/snapshot.mjs — Monday card: 6 metrics, one screen.
// Trust-fix #1: LOC from ctx.cfg.loc (no baked default).
// Trust-fix #2: leads() and revenue() paginate to completion.
// Trust-fix #3: revenue tracks per-currency (never cross-sums).
// v0.5.0: calendar list from CRM model; location currency from model.
// v0.6.0 (C2): modelMeta emitted in JSON envelope; TTY staleness note.
import { paginate } from '../lib/paginate.mjs';
import { mapLimit } from '../lib/pool.mjs';
import { ENTITY_SPECS } from '../lib/model.mjs';

export const meta = {
  name: 'snapshot',
  summary: 'Monday card — 6 metrics, one screen',
  flags: [{ name: '--days', type: 'int', default: 7, desc: 'window in days' }],
  readOnly: true,
};

const SYM = { PHP: '₱', USD: '$', EUR: '€', GBP: '£', AUD: 'A$', CAD: 'C$' };
const money = (n, cur = 'PHP') =>
  (n == null || !Number.isFinite(Number(n))) ? '—' : (SYM[cur] || cur + ' ') + Number(n).toLocaleString('en-PH', { maximumFractionDigits: 0 });
const fmtManila = (ms) =>
  new Date(ms).toLocaleString('en-US', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric' });
const metric = (label, value, { note = '', blocked = false, blocker = '' } = {}) =>
  ({ label, value, note, blocked, blocker });

export async function collect(args, ctx) {
  const DAYS = args.days != null ? args.days : (Number(args._?.[0]) || 7);
  const LOC = ctx.cfg.loc;
  const NOW = ctx.now;
  const START = NOW - DAYS * 24 * 60 * 60 * 1000;
  const startISO = new Date(START).toISOString();
  const inWindow = (v) => {
    const t = typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v);
    return Number.isFinite(t) && t >= START && t <= NOW;
  };

  // Location currency from CRM model (fallback PHP if model missing/blocked)
  let locationCurrency = 'PHP';
  let _snapshotModelLoaded = null;
  let modelMeta = null;
  if (ctx.ensureModel) {
    try {
      _snapshotModelLoaded = await ctx.ensureModel();
      const locCur = _snapshotModelLoaded?.entities?.location?.item?.business?.currency
        || _snapshotModelLoaded?.entities?.location?.item?.currency;
      if (locCur) locationCurrency = locCur.toUpperCase();
    } catch { /* use default */ }
  } else if (ctx.cfg.currency) {
    locationCurrency = ctx.cfg.currency;
  }
  // Build modelMeta for the JSON envelope (C2)
  if (_snapshotModelLoaded) {
    const specMap = Object.fromEntries(ENTITY_SPECS.map(s => [s.name, s]));
    // Check calendars staleness (the main model-sourced entity in snapshot)
    const calEnt = _snapshotModelLoaded.entities?.calendars;
    const calSpec = specMap.calendars;
    const calStale = calEnt && calSpec ? (NOW - (calEnt.fetchedAt ?? 0)) > calSpec.ttlMs : false;
    modelMeta = {
      syncedAt: _snapshotModelLoaded.syncedAt,
      ageMs: NOW - _snapshotModelLoaded.syncedAt,
      stale: calStale,
      offline: !!(_snapshotModelLoaded.offline),
    };
  }

  // ── LEADS: paginate contacts newest→older, stop past window ──
  async function leads() {
    let count = 0, pages = 0, oldest = null;
    let startAfter, startAfterId, done = false;
    for await (const c of paginate({
      fetchPage: async (cursor) => {
        const q = { locationId: LOC, limit: 100 };
        if (cursor) { q.startAfter = cursor.startAfter; q.startAfterId = cursor.startAfterId; }
        const r = await ctx.http.get('/contacts/', { query: q });
        if (!r.ok) return { _err: r.code, contacts: [] };
        return r.j;
      },
      getItems: (resp) => {
        if (resp._err) return [];
        const arr = resp.contacts || resp.data || [];
        if (!arr.length) done = true;
        for (const c of arr) {
          const da = c.dateAdded || c.createdAt;
          const t = Date.parse(da);
          if (Number.isFinite(t)) { oldest = t; if (t < START) done = true; }
        }
        pages++;
        const last = arr[arr.length - 1];
        startAfter = last?.dateAdded ? Date.parse(last.dateAdded) : undefined;
        startAfterId = last?.id;
        return arr;
      },
      nextCursor: (resp, items) => {
        if (done || items.length < 100 || resp._err) return null;
        return { startAfter, startAfterId };
      },
      maxPages: 200,
    })) {
      const da = c.dateAdded || c.createdAt;
      const t = Date.parse(da);
      if (Number.isFinite(t) && t >= START && t <= NOW) count++;
    }
    if (pages === 0) return metric('Leads', null, { blocked: true, blocker: 'contacts read failed' });
    return metric('Leads', count, { note: `new contacts · ${pages} page(s) scanned` });
  }

  // ── BOOKINGS + SHOW RATE ──
  // I-2 truncation cap: GHL's /calendars/events has no pagination cursor.
  // If a calendar returns >= CAP events it is likely truncated (silently under-reports).
  // Full fix = date-window splitting; tracked as follow-up. Cheap mitigation: warn + degrade.
  const EVENTS_CAP = 100;
  async function bookings() {
    // Get calendar list from the CRM model if available; fall back to live fetch.
    // Use _snapshotModelLoaded already loaded above — no second ensureModel call.
    let cals = null;
    if (_snapshotModelLoaded?.entities?.calendars && !_snapshotModelLoaded.entities.calendars.blocked && !_snapshotModelLoaded.entities.calendars.networkError) {
      cals = _snapshotModelLoaded.entities.calendars.items ?? [];
    } else if (!_snapshotModelLoaded && ctx.ensureModel) {
      try {
        const model = await ctx.ensureModel();
        if (model?.entities?.calendars && !model.entities.calendars.blocked && !model.entities.calendars.networkError) {
          cals = model.entities.calendars.items ?? [];
        }
      } catch { /* fall through to live fetch */ }
    }
    if (cals === null) {
      const cr = await ctx.http.get('/calendars/', { query: { locationId: LOC }, version: '2021-04-15' });
      if (!cr.ok) return [
        metric('Bookings', null, { blocked: true, blocker: `calendars list HTTP ${cr.code}` }),
        metric('Show rate', null, { blocked: true, blocker: 'no calendars' }),
      ];
      cals = cr.j.calendars || [];
    }
    let booked = 0, showed = 0, noshow = 0, calsHit = 0, skippedCalendars = 0;
    // Parallel fan-out, capped at 5 concurrent (GHL rate-limit-safe: 100 req/10s; 5 concurrent is well under).
    // ONLY the independent per-calendar fetches are parallelized — pagination pages stay sequential.
    const evResults = await mapLimit(cals, 5, async (cal) => {
      const ev = await ctx.http.get('/calendars/events', {
        query: { locationId: LOC, calendarId: cal.id, startTime: String(START), endTime: String(NOW) },
        version: '2021-04-15',
      });
      return { cal, ev };
    });
    for (const { cal, ev } of evResults) {
      if (!ev.ok) {
        skippedCalendars++;
        ctx.out.warn(`calendar "${cal.name || cal.id}" events unreadable (HTTP ${ev.code})`, { degraded: true });
        continue;
      }
      const evList = ev.j.events || ev.j.appointments || [];
      // I-2: truncation mitigation — no cursor available; warn if at cap
      if (evList.length >= EVENTS_CAP) {
        ctx.out.warn(`calendar "${cal.name || cal.id}" returned ${evList.length} events — may be truncated (no pagination cursor available); counts for this calendar may under-report`, { degraded: true });
      }
      calsHit++;
      for (const e of evList) {
        const st = e.startTime || e.startTimeISO || e.appointmentStartTime;
        if (!inWindow(st)) continue;
        booked++;
        const s = (e.appointmentStatus || e.status || '').toLowerCase();
        if (s === 'showed' || s === 'shown') showed++;
        else if (s === 'noshow' || s === 'no-show' || s === 'no_show') noshow++;
      }
    }
    const rated = showed + noshow;
    const showRate = rated > 0 ? Math.round(showed / rated * 100) : null;
    return [
      metric('Bookings', booked, { note: `appointments · ${calsHit}/${cals.length} calendars${skippedCalendars > 0 ? ` · ${skippedCalendars} skipped` : ''}`, ...(skippedCalendars > 0 && { skippedCalendars }) }),
      showRate == null
        ? metric('Show rate', null, { blocked: true, blocker: 'no completed (showed/noshow) appts in window yet' })
        : metric('Show rate', showRate + '%', { note: `${showed} showed / ${rated} completed` }),
    ];
  }

  // ── REVENUE: paginate transactions to completion (trust-fix #2), per-currency (trust-fix #3) ──
  async function revenue() {
    const byCur = {}; // { PHP: { sum, n }, ... }
    let firstErr = null, totalScanned = 0;
    for await (const t of paginate({
      fetchPage: async (offset = 0) => {
        const r = await ctx.http.get('/payments/transactions', {
          query: { altId: LOC, altType: 'location', limit: 100, offset },
        });
        if (!r.ok) return { _err: r.code, data: [] };
        return r.j;
      },
      getItems: (resp) => {
        if (resp._err) { firstErr = resp._err; return []; }
        return resp.data || resp.transactions || [];
      },
      nextCursor: (resp, items, offset = 0) => {
        if (resp._err || items.length < 100) return null;
        return offset + 100;
      },
      maxPages: 200,
      startCursor: 0,
    })) {
      totalScanned++;
      const when = t.createdAt || t.created_at || t.dateAdded;
      const ok = (t.status || t.paymentStatus || '').toLowerCase();
      if (inWindow(when) && (ok === 'succeeded' || ok === 'success' || ok === 'paid' || ok === 'completed' || ok === 'captured')) {
        const cur = (t.currency || locationCurrency).toUpperCase();
        byCur[cur] = byCur[cur] || { sum: 0, n: 0 };
        byCur[cur].sum += Number(t.amount) || 0;
        byCur[cur].n++;
      }
    }
    if (firstErr && totalScanned === 0)
      return metric('Collected', null, { blocked: true, blocker: `transactions HTTP ${firstErr}` });
    // If only one currency, match original format; multi-currency → list all
    const entries = Object.entries(byCur);
    if (entries.length === 0)
      return metric('Collected', money(0, locationCurrency), { note: `0 payment(s) · ${totalScanned} txns scanned` });
    if (entries.length === 1) {
      const [cur, { sum, n }] = entries[0];
      return metric('Collected', money(sum, cur), { note: `${n} payment(s) · ${totalScanned} txns scanned` });
    }
    const summary = entries.map(([c, { sum, n }]) => `${money(sum, c)} (${n})`).join(' + ');
    const totalN = entries.reduce((s, [, { n }]) => s + n, 0);
    return metric('Collected', summary, { note: `${totalN} payment(s) · ${totalScanned} txns scanned · multi-currency` });
  }

  // ── PIPELINE VALUE ──
  async function pipelineValue() {
    let sum = 0, n = 0;
    for await (const o of paginate({
      fetchPage: async (page = 1) => {
        const r = await ctx.http.get('/opportunities/search', {
          query: { location_id: LOC, status: 'open', limit: 100, page },
        });
        if (!r.ok) return { _err: r.code, opportunities: [] };
        return r.j;
      },
      getItems: (resp) => resp._err ? [] : (resp.opportunities || resp.data || []),
      nextCursor: (resp, items, page = 1) => {
        if (resp._err || items.length < 100) return null;
        return page + 1;
      },
      maxPages: 20,
      startCursor: 1,
    })) {
      sum += Number(o.monetaryValue || o.monetary_value || 0) || 0;
      n++;
    }
    return metric('Pipeline value', money(sum, locationCurrency), { note: `${n} open deal(s)` });
  }

  // ── REPLY RATE ──
  async function replyRate() {
    const r = await ctx.http.get('/conversations/search', { query: { locationId: LOC, limit: 100 } });
    if (!r.ok)
      return metric('Reply rate', null, { blocked: true, blocker: `conversations HTTP ${r.code}` });
    const convos = r.j.conversations || r.j.data || [];
    let waiting = 0, total = 0;
    for (const c of convos) {
      const when = c.lastMessageDate || c.dateUpdated;
      if (!inWindow(when)) continue;
      total++;
      if ((c.unreadCount || 0) > 0) waiting++;
    }
    if (total === 0)
      return metric('Reply rate', null, { blocked: true, blocker: 'no conversation activity in window' });
    const replied = total - waiting;
    return metric('Reply rate', Math.round(replied / total * 100) + '%', { note: `${waiting} thread(s) still waiting on you` });
  }

  const [bk, sr] = await bookings();
  const rows = await Promise.all([leads(), Promise.resolve(bk), Promise.resolve(sr), revenue(), replyRate(), pipelineValue()]);
  return {
    location: LOC,
    window: { days: DAYS, startISO, endISO: new Date(NOW).toISOString() },
    metrics: rows,
    ...(modelMeta ? { modelMeta } : {}),
  };
}

export async function run(args, ctx) {
  const data = await collect(args, ctx);
  ctx.out.data(data);

  const DAYS = args.days != null ? args.days : (Number(args._?.[0]) || 7);
  const NOW = ctx.now;
  const START = NOW - DAYS * 24 * 60 * 60 * 1000;
  ctx.out.card(() => {
    const W = 58;
    const winLabel = `${fmtManila(START)} – ${fmtManila(NOW)} (last ${DAYS}d, Manila)`;
    const line = (l, v) => '│ ' + l.padEnd(16) + ' ' + String(v).padEnd(W - 20) + '│';
    ctx.out.line('┌' + '─'.repeat(W - 2) + '┐');
    ctx.out.line(line('SNAPSHOT', winLabel.slice(0, W - 20)));
    // C2: model staleness note
    if (data.modelMeta) {
      const mm = data.modelMeta;
      if (mm.offline) {
        ctx.out.line(line('· model', 'OFFLINE — calendar list from cache'));
      } else if (mm.stale) {
        const ageD = Math.round(mm.ageMs / 86400000);
        ctx.out.line(line('· model', `${ageD}d old — run sizmo sync`));
      }
    }
    ctx.out.line('├' + '─'.repeat(W - 2) + '┤');
    for (const m of data.metrics) {
      if (m.blocked) {
        ctx.out.line(line(m.label, "⚠ can't see"));
        ctx.out.line('│ ' + ' '.repeat(16) + ' ' + ('→ ' + m.blocker).slice(0, W - 20).padEnd(W - 20) + '│');
      } else {
        ctx.out.line(line(m.label, m.value));
        if (m.note) ctx.out.line('│ ' + ' '.repeat(16) + ' ' + ('· ' + m.note).slice(0, W - 20).padEnd(W - 20) + '│');
      }
    }
    ctx.out.line('└' + '─'.repeat(W - 2) + '┘');
    ctx.out.line('loc ' + data.location + '  ·  read-only  ·  numbers are counts, never fabricated');
  });
  return 0;
}

// commands/booked-not-paid.mjs — Money-leak detector: sessions × invoices × payments.
// Trust-fix #1: LOC from ctx.cfg.loc.
// Trust-fix #2 (critical): transactions paginate to completion — fixes false-accusation bug
//   where single-page limit:100 missed paid contacts → now exhausts all pages.
// READ-ONLY. Never messages, invoices, or charges.
import { paginate } from '../lib/paginate.mjs';

export const meta = {
  name: 'booked-not-paid',
  summary: 'Sessions with no invoice or payment — the money leak',
  flags: [
    { name: '--days', type: 'int', default: 30, desc: 'session lookback window' },
    { name: '--top', type: 'int', default: 15, desc: 'max rows to show per bucket' },
  ],
  readOnly: true,
};

const SYM = { PHP: '₱', USD: '$', EUR: '€', GBP: '£' };
const money = (n, c = 'PHP') => (SYM[c] || c + ' ') + Number(n || 0).toLocaleString('en-PH', { maximumFractionDigits: 0 });
const UNPAID = new Set(['sent', 'overdue', 'partially_paid', 'partially paid', 'payment_processing', 'viewed', 'due']);
// Must match reconcile.mjs SUCCESS set exactly — any status in this set means the contact paid.
const SUCCESS = new Set(['succeeded', 'success', 'paid', 'completed', 'captured']);

// I-2 truncation cap: GHL's /calendars/events has no pagination cursor.
// If a calendar returns >= CAP events it is likely truncated (silently under-reports).
// Full fix = date-window splitting; tracked as follow-up. Cheap mitigation: warn + degrade.
const EVENTS_CAP = 100;

export async function collect(args, ctx) {
  const DAYS = args.days ?? 30;
  const TOP = args.top ?? 15;
  const LOC = ctx.cfg.loc;
  const NOW = ctx.now;
  const START = NOW - DAYS * 86400000;
  const PAY_LOOKBACK = START - 60 * 86400000;

  // ── 1. CALENDARS: who had a session in the window ──
  const cr = await ctx.http.get('/calendars/', { query: { locationId: LOC }, version: '2021-04-15' });
  if (!cr.ok) {
    ctx.out.warn(`can't see calendars → HTTP ${cr.code}`, { degraded: true });
    return { location: LOC, days: DAYS, calendars: 0, contactsWithSessions: 0, neverBilled: [], billedUnpaid: [], billedUnpaidTotal: 0, currency: 'PHP', settled: 0, caveat: 'calendars blocked' };
  }
  const cals = cr.j.calendars || [];
  const byContact = new Map();
  let skippedCalendars = 0;
  for (const cal of cals) {
    const ev = await ctx.http.get('/calendars/events', {
      query: { locationId: LOC, calendarId: cal.id, startTime: String(START), endTime: String(NOW) },
      version: '2021-04-15',
    });
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
    for (const e of evList) {
      const s = (e.appointmentStatus || e.status || '').toLowerCase();
      if (['noshow', 'no-show', 'no_show', 'cancelled', 'canceled', 'invalid'].includes(s)) continue;
      const t = Date.parse(e.startTime || e.startTimeISO || e.appointmentStartTime) || 0;
      if (t > NOW) continue;
      if (!e.contactId) continue;
      const rec = byContact.get(e.contactId) ?? { name: e.title || e.contactName || '(unknown)', sessions: [] };
      rec.sessions.push({ when: t, status: s === 'showed' ? 'showed' : 'unmarked', cal: cal.name });
      byContact.set(e.contactId, rec);
    }
  }

  if (!byContact.size) {
    return {
      location: LOC, days: DAYS, calendars: cals.length,
      ...(skippedCalendars > 0 && { skippedCalendars }),
      contactsWithSessions: 0, invoicesScanned: 0, neverBilled: [], billedUnpaid: [],
      billedUnpaidTotal: 0, currency: 'PHP', settled: 0,
      caveat: 'contact-level matching; payments lookback window+60d; prepaid clients older than that may flag falsely',
    };
  }

  // ── 2. INVOICES: who got billed ──
  const inv = [];
  let invBlocked = null;
  for await (const item of paginate({
    fetchPage: async (offset = 0) => {
      const r = await ctx.http.get('/invoices/', {
        query: { altId: LOC, altType: 'location', limit: 100, offset },
      });
      if (!r.ok) return { _err: r.code, invoices: [] };
      return r.j;
    },
    getItems: (resp) => {
      if (resp._err) { invBlocked = `HTTP ${resp._err}`; return []; }
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

  const billing = new Map();
  for (const i of inv) {
    const cid = i.contactDetails?.id || i.contactDetails?._id || i.contactId;
    if (!cid) continue;
    const st = String(i.status || '').toLowerCase();
    if (st === 'draft' || st === 'void' || st === 'cancelled' || st === 'canceled') continue;
    const b = billing.get(cid) ?? { billed: false, due: 0, cur: (i.currency || 'PHP').toUpperCase() };
    b.billed = true;
    if (UNPAID.has(st)) {
      const due = Number(i.total ?? i.amount ?? 0) - Number(i.amountPaid ?? i.totalPaid ?? 0);
      if (due > 0.0001) b.due += due;
    }
    billing.set(cid, b);
  }

  // ── 3. PAYMENTS: paginate to completion (trust-fix #2 — the false-accusation fix) ──
  const paidContacts = new Set();
  let payBlocked = null;
  for await (const t of paginate({
    fetchPage: async (offset = 0) => {
      const r = await ctx.http.get('/payments/transactions', {
        query: {
          altId: LOC, altType: 'location', limit: 100, offset,
          startAt: new Date(PAY_LOOKBACK).toISOString().slice(0, 10),
        },
      });
      if (!r.ok) return { _err: r.code, data: [] };
      return r.j;
    },
    getItems: (resp) => {
      if (resp._err) { payBlocked = `HTTP ${resp._err}`; return []; }
      return resp.data || resp.transactions || [];
    },
    nextCursor: (resp, items, offset = 0) => {
      if (resp._err || items.length < 100) return null;
      return offset + 100;
    },
    maxPages: 500,
    startCursor: 0,
  })) {
    if (!SUCCESS.has(String(t.status || '').toLowerCase())) continue;
    const cid = t.contactId || t.contactDetails?.id;
    if (cid) paidContacts.add(cid);
  }

  // Emit machine-readable degraded warnings for blocked sources (visible in --json, not just TTY).
  // invBlocked: can't tell billed from not → neverBilled bucket unreliable.
  // payBlocked: can't see outside-invoice payments → neverBilled bucket unreliable (may over-accuse).
  if (invBlocked) ctx.out.warn(`can't see invoices (${invBlocked}) — NEVER-BILLED bucket suppressed, can't tell billed from not`, { degraded: true });
  if (payBlocked) ctx.out.warn(`can't see payments (${payBlocked}) — outside-invoice payments invisible; NEVER-BILLED bucket suppressed to avoid false accusations`, { degraded: true });

  // ── 4. Cross-check ──
  const neverBilled = [], billedUnpaid = [];
  let settled = 0;
  for (const [cid, rec] of byContact) {
    const b = billing.get(cid);
    const paidAnyRoute = paidContacts.has(cid);
    const last = Math.max(...rec.sessions.map(s => s.when));
    const row = {
      name: rec.name, contactId: cid, sessions: rec.sessions.length,
      lastSession: new Date(last).toISOString(), lastSessionTs: last,
      attended: rec.sessions.some(s => s.status === 'showed') ? 'showed' : 'unmarked',
    };
    if (b?.due > 0.0001) billedUnpaid.push({ ...row, due: b.due, cur: b.cur });
    // neverBilled suppressed when invBlocked (can't see invoices) OR payBlocked (can't see all payments)
    else if (!b?.billed && !paidAnyRoute && !invBlocked && !payBlocked) neverBilled.push(row);
    else settled++;
  }
  neverBilled.sort((a, b) => b.lastSessionTs - a.lastSessionTs);
  billedUnpaid.sort((a, b) => b.due - a.due);
  const dueSum = billedUnpaid.reduce((s, x) => s + x.due, 0);
  const cur = billedUnpaid[0]?.cur || 'PHP';

  return {
    location: LOC,
    days: DAYS,
    calendars: cals.length,
    ...(skippedCalendars > 0 && { skippedCalendars }),
    contactsWithSessions: byContact.size,
    invoicesScanned: inv.length,
    ...(invBlocked && { invoicesBlocked: invBlocked }),
    ...(payBlocked && { paymentsBlocked: payBlocked }),
    neverBilled: neverBilled.slice(0, TOP),
    billedUnpaid: billedUnpaid.slice(0, TOP),
    billedUnpaidTotal: dueSum,
    currency: cur,
    settled,
    caveat: 'contact-level matching; payments lookback window+60d; prepaid clients older than that may flag falsely',
  };
}

export async function run(args, ctx) {
  const data = await collect(args, ctx);
  ctx.out.data(data);

  const DAYS = args.days ?? 30;
  const TOP = args.top ?? 15;
  const cur = data.currency;
  const fmt = (t) =>
    new Date(t).toLocaleString('en-US', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric' });

  ctx.out.card(() => {
    ctx.out.line(`\n  BOOKED-NOT-PAID — last ${DAYS}d · ${data.contactsWithSessions} contact(s) with sessions · loc ${data.location}`);
    ctx.out.line('  ' + '─'.repeat(72));
    if (data.invoicesBlocked) ctx.out.line(`  ⚠ can't see invoices (${data.invoicesBlocked}) — NEVER-BILLED bucket suppressed, can't tell billed from not`);
    if (data.paymentsBlocked) ctx.out.line(`  ⚠ can't see payments (${data.paymentsBlocked}) — outside-invoice payments invisible, may over-flag`);
    if (!data.neverBilled?.length && !data.billedUnpaid?.length) {
      ctx.out.line(`  No leaks — every session contact is billed or settled (${data.settled} clean). ✅\n`);
      return;
    }
    if (data.neverBilled?.length) {
      ctx.out.line(`  NEVER BILLED — ${data.neverBilled.length} contact(s) had sessions, zero invoice, zero payment on file:`);
      data.neverBilled.slice(0, TOP).forEach((x, i) => {
        ctx.out.line(`  ${String(i + 1).padStart(2)}. ${(x.name || '?').slice(0, 26).padEnd(26)} ${String(x.sessions) + ' session(s)'} · last ${fmt(x.lastSessionTs)} · ${x.attended}`);
        ctx.out.line(`      contact ${x.contactId}`);
      });
      if (data.neverBilled.length > TOP) ctx.out.line(`  … +${data.neverBilled.length - TOP} more`);
      ctx.out.line('');
    }
    if (data.billedUnpaid?.length) {
      ctx.out.line(`  BILLED, UNPAID — ${money(data.billedUnpaidTotal, cur)} due from ${data.billedUnpaid.length} session contact(s):`);
      data.billedUnpaid.slice(0, TOP).forEach((x, i) => {
        ctx.out.line(`  ${String(i + 1).padStart(2)}. ${(x.name || '?').slice(0, 26).padEnd(26)} ${money(x.due, x.cur).padStart(11)} · ${x.sessions} session(s) · last ${fmt(x.lastSessionTs)}`);
        ctx.out.line(`      contact ${x.contactId}`);
      });
      if (data.billedUnpaid.length > TOP) ctx.out.line(`  … +${data.billedUnpaid.length - TOP} more`);
      ctx.out.line('');
    }
    ctx.out.line('  ' + '─'.repeat(72));
    ctx.out.line(`  ${data.settled} contact(s) billed/settled — skipped. Matching is contact-level (v1); prepaid >${DAYS + 60}d ago may flag.`);
    ctx.out.line('  → never-billed: ghl-invoices drafts the invoice · unpaid: ghl-conversations drafts the nudge.');
    ctx.out.line('  You approve every invoice and every message. Money stays you, always.\n');
  });
  return 0;
}

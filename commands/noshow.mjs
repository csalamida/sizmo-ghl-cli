// commands/noshow.mjs — No-show recovery: surfaces who no-showed to re-book.
// Trust-fix #1: LOC from ctx.cfg.loc (no baked default).
// READ-ONLY. Never messages, never books.
import { mapLimit } from '../lib/pool.mjs';
export const meta = {
  name: 'noshow',
  summary: 'No-show recovery — who to re-book',
  flags: [
    { name: '--days', type: 'int', default: 30, desc: 'lookback window' },
    { name: '--top', type: 'int', default: 15, desc: 'max results' },
  ],
  readOnly: true,
};

// I-2 truncation cap: GHL's /calendars/events has no pagination cursor.
// If a calendar returns >= CAP events it is likely truncated (silently under-reports).
// Full fix = date-window splitting; tracked as follow-up. Cheap mitigation: warn + degrade.
const EVENTS_CAP = 100;

export async function collect(args, ctx) {
  const DAYS = args.days ?? 30;
  const TOP = args.top ?? 15;
  const LOC = ctx.cfg.loc;
  const NOW = ctx.now;
  const START = NOW - DAYS * 24 * 60 * 60 * 1000;

  const cr = await ctx.http.get('/calendars/', { query: { locationId: LOC }, version: '2021-04-15' });
  if (!cr.ok) {
    ctx.out.warn(`can't see calendars → HTTP ${cr.code}`, { degraded: true });
    return { location: LOC, calendars: 0, noshows: 0, shown: 0, list: [] };
  }
  const cals = cr.j.calendars || [];
  const noshows = [];
  let skippedCalendars = 0;
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
    for (const e of evList) {
      const s = (e.appointmentStatus || e.status || '').toLowerCase();
      if (s !== 'noshow' && s !== 'no-show' && s !== 'no_show') continue;
      const t = Date.parse(e.startTime || e.startTimeISO || e.appointmentStartTime) || 0;
      noshows.push({
        name: e.title || e.contactName || '(unknown)',
        contactId: e.contactId,
        apptId: e.id,
        when: t,
        cal: cal.name,
        calId: cal.id,
      });
    }
  }
  noshows.sort((a, b) => b.when - a.when);
  const top = noshows.slice(0, TOP);

  return {
    location: LOC,
    calendars: cals.length,
    ...(skippedCalendars > 0 && { skippedCalendars }),
    noshows: noshows.length,
    shown: top.length,
    list: top.map(n => ({
      name: n.name,
      contactId: n.contactId,
      apptId: n.apptId,
      when: new Date(n.when).toISOString(),
      calendar: n.cal,
    })),
  };
}

export async function run(args, ctx) {
  const data = await collect(args, ctx);
  ctx.out.data(data);

  const DAYS = args.days ?? 30;
  const NOW = ctx.now;
  const ago = (t) => {
    const d = Math.floor((NOW - t) / 86400000);
    return d >= 1 ? d + 'd' : Math.max(1, Math.floor((NOW - t) / 3600000)) + 'h';
  };
  const fmt = (t) =>
    new Date(t).toLocaleString('en-US', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  ctx.out.card(() => {
    ctx.out.line(`\n  NO-SHOW RECOVERY — ${data.noshows} no-show(s) · last ${DAYS}d · ${data.calendars} calendars · loc ${data.location}`);
    ctx.out.line('  ' + '─'.repeat(70));
    if (!data.list.length) {
      ctx.out.line('  No no-shows in window. ✅\n');
      return;
    }
    data.list.forEach((n, i) => {
      const ts = new Date(n.when).getTime();
      ctx.out.line(`  ${String(i + 1).padStart(2)}. ${(n.name || '(unknown)').slice(0, 24).padEnd(24)} ${fmt(ts).padEnd(20)} (${ago(ts)} ago)`);
      ctx.out.line(`      ${n.calendar} · contact ${n.contactId || '—'} · appt ${n.apptId}`);
    });
    ctx.out.line('  ' + '─'.repeat(70));
    ctx.out.line('  → hand to ghl-conversations: draft a warm re-book message per contact; you approve each send (L2).\n');
  });
  return 0;
}

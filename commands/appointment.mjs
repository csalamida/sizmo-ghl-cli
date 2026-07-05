// commands/appointment.mjs — book or cancel a calendar appointment.
// Scope required: calendars.write
// Calendar name resolved to ID via CRM model, falling back to a live fetch on a cache miss —
// verified live 2026-07-05: booking on a calendar created earlier in the same session failed
// with "unknown calendar" because the model hadn't re-synced yet. Same gap `sizmo ask` had for
// field/calendar/business, just in this direct (non-ask) command path too.
// NEVER fires without --confirm. No-confirm → exit 5 (CONFIRM) + envelope.
// 401/403 → exit 3 with scope guidance.
import { requireConfirm } from '../lib/confirm.mjs';
import { GhlError, EXIT } from '../lib/errors.mjs';
import { fetchLiveEntity } from '../lib/model.mjs';

export const meta = {
  name: 'appointment',
  summary: 'book or cancel a calendar appointment',
  flags: [
    { name: '--calendar', type: 'string', desc: 'calendar name (book)' },
    { name: '--contact',  type: 'string', desc: 'contact id (book)' },
    { name: '--start',    type: 'string', desc: 'ISO 8601 start datetime (book)' },
  ],
  readOnly: false,
};

function resolveCalendarByName(name, model) {
  const cals = model?.entities?.calendars;
  if (!cals || cals.blocked || !Array.isArray(cals.items)) return null;
  return cals.items.find(c => c.name === name) ?? null;
}

function calendarAgeNote(model, now) {
  const ent = model?.entities?.calendars;
  if (!ent || typeof ent.fetchedAt !== 'number') return null;
  const h = Math.round((now - ent.fetchedAt) / 3_600_000);
  return h > 0 ? `CRM model synced ${h}h ago — sizmo sync to refresh` : null;
}

export async function run(args, ctx) {
  const sub = args._?.[0]; // 'book' | 'cancel'
  if (!sub || !['book', 'cancel'].includes(sub)) {
    throw new GhlError(
      'usage: sizmo appointment book --calendar <name> --contact <id> --start <iso>\n' +
      '       sizmo appointment cancel <apptId>',
      EXIT.USAGE, 'sizmo schema'
    );
  }

  const now = typeof ctx.now === 'function' ? ctx.now() : ctx.now;

  // ── book ─────────────────────────────────────────────────────────────────────
  if (sub === 'book') {
    const calName = args.calendar;
    const contact = args.contact;
    const start   = args.start;

    if (!calName) throw new GhlError('appointment book requires --calendar', EXIT.USAGE);
    if (!contact) throw new GhlError('appointment book requires --contact',  EXIT.USAGE);
    if (!start)   throw new GhlError('appointment book requires --start',    EXIT.USAGE);

    // Validate ISO date roughly (must be parseable)
    const startMs = Date.parse(start);
    if (isNaN(startMs)) {
      throw new GhlError(`appointment book: invalid --start '${start}' — must be ISO 8601 (e.g. 2026-06-15T10:00:00Z)`, EXIT.USAGE);
    }

    // Resolve calendar name → id via model, falling back to a live fetch on a miss (the model
    // may simply not have caught up yet with a calendar created earlier in this same session).
    const model = await ctx.ensureModel();
    let cal = resolveCalendarByName(calName, model);
    if (!cal) {
      const live = await fetchLiveEntity('calendars', ctx, new Map());
      if (!live.error) cal = live.items.find(c => c.name === calName) ?? null;
    }
    if (!cal) {
      throw new GhlError(
        `unknown calendar '${calName}' — run sizmo crm calendars`,
        EXIT.NOTFOUND,
        'sizmo crm calendars to list available calendars'
      );
    }

    const staleNote = calendarAgeNote(model, now);
    const changes = [
      `Book appointment on calendar '${calName}' (id: ${cal.id})`,
      `  contact: ${contact}`,
      `  start:   ${start}`,
      ...(staleNote ? [`  (${staleNote})`] : []),
    ];
    const rerunCommand = `sizmo appointment book --calendar "${calName}" --contact ${contact} --start "${start}" --confirm`;

    const gate = requireConfirm({ command: 'appointment book', changes, rerunCommand }, ctx);
    if (!gate.proceed) return gate.code;

    // Execute
    // GHL requires locationId in the body (verified live: 400 "Location ID is required" without it).
    const r = await ctx.http.post('/calendars/events/appointments', {
      calendarId: cal.id,
      locationId: ctx.cfg.loc,
      contactId: contact,
      startTime: start,
    });

    if (r.code === 401 || r.code === 403) {
      throw new GhlError(
        `HTTP ${r.code} — your PIT lacks calendars.write — add it in GoHighLevel → Private Integrations`,
        EXIT.AUTH,
        'GoHighLevel → Settings → Private Integrations → edit your PIT → add calendars.write scope'
      );
    }
    if (!r.ok) {
      throw new GhlError(`appointment book failed — HTTP ${r.code}: ${(r.txt || '').slice(0, 200)}`, EXIT.API);
    }

    ctx.out.data({ status: 'ok', command: 'appointment book', appointmentId: r.j?.id ?? null, calendarId: cal.id });
    ctx.out.line(`  appointment booked on '${calName}' for contact ${contact} at ${start}`);
    return EXIT.OK;
  }

  // ── cancel ────────────────────────────────────────────────────────────────────
  if (sub === 'cancel') {
    const apptId = args._?.[1];
    if (!apptId) {
      throw new GhlError('usage: sizmo appointment cancel <apptId>', EXIT.USAGE);
    }

    const changes = [`Cancel appointment ${apptId}`];
    const rerunCommand = `sizmo appointment cancel ${apptId} --confirm`;

    const gate = requireConfirm({ command: 'appointment cancel', changes, rerunCommand }, ctx);
    if (!gate.proceed) return gate.code;

    // Execute
    const r = await ctx.http.delete(`/calendars/events/appointments/${encodeURIComponent(apptId)}`, {});

    if (r.code === 401 || r.code === 403) {
      throw new GhlError(
        `HTTP ${r.code} — your PIT lacks calendars.write — add it in GoHighLevel → Private Integrations`,
        EXIT.AUTH,
        'GoHighLevel → Settings → Private Integrations → edit your PIT → add calendars.write scope'
      );
    }
    if (!r.ok) {
      throw new GhlError(`appointment cancel failed — HTTP ${r.code}: ${(r.txt || '').slice(0, 200)}`, EXIT.API);
    }

    ctx.out.data({ status: 'ok', command: 'appointment cancel', appointmentId: apptId });
    ctx.out.line(`  appointment ${apptId} cancelled`);
    return EXIT.OK;
  }
}

// commands/appointment.mjs — book, cancel, or note a calendar appointment.
// Scope required: calendars.write
// Calendar name resolved to ID via CRM model, falling back to a live fetch on a cache miss —
// verified live 2026-07-05: booking on a calendar created earlier in the same session failed
// with "unknown calendar" because the model hadn't re-synced yet. Same gap `sizmo ask` had for
// field/calendar/business, just in this direct (non-ask) command path too.
// NEVER fires without --confirm. No-confirm → exit 5 (CONFIRM) + envelope.
// 401/403 → exit 3 with scope guidance.
//
// `note` added 2026-07-08 — found via the new LeadConnector Anthropic MCP's search_operations
// (POST /calendars/appointments/{id}/notes), a real gap: sizmo had zero way to note an
// appointment. Scoped to create-only, matching commands/note.mjs's existing contact-note
// precedent exactly — GHL supports list/update/delete for both contact AND appointment notes,
// sizmo deliberately ships neither surface beyond create. Consistency over completeness.
import { requireConfirm } from '../lib/confirm.mjs';
import { GhlError, EXIT } from '../lib/errors.mjs';
import { fetchLiveEntity } from '../lib/model.mjs';
import { mapLimit } from '../lib/pool.mjs';

// The subcommand list, declared once so `sizmo schema` and the dispatch below cannot
// disagree. test/client/schema-subcommands.test.mjs extracts the verbs this file actually
// dispatches on and fails if they differ from this array.
const SUBCOMMANDS = ['list', 'book', 'update', 'cancel', 'note'];

export const meta = {
  name: 'appointment',
  summary: 'list upcoming appointments, or book, update, cancel or note one',
  subcommands: SUBCOMMANDS,
  flags: [
    { name: '--calendar', type: 'string', desc: 'calendar name (book)' },
    { name: '--contact',  type: 'string', desc: 'contact id (book)' },
    { name: '--start',    type: 'string', desc: 'ISO 8601 start datetime (book)' },
    { name: '--end',      type: 'string', desc: 'ISO 8601 end datetime (book) — omit to use the calendar slot duration' },
    { name: '--title',    type: 'string', desc: 'appointment title (book) — omit and GHL names it for you' },
    { name: '--assigned-user', type: 'string', desc: 'user id to assign (book) — `sizmo list users` for ids' },
    { name: '--address',  type: 'string', desc: 'meeting location (book) — e.g. "Zoom" or a street address' },
    { name: '--no-notify', type: 'bool',  desc: 'book WITHOUT firing the location\'s automations (default: they fire)' },
    { name: '--text',     type: 'string', desc: 'note body text (note)' },
    { name: '--status',   type: 'string', desc: 'update: confirmed | showed | noshow | cancelled | invalid' },
    { name: '--days',     type: 'int',    desc: 'how far AHEAD to look (list, default 14)' },
    { name: '--top',      type: 'int',    desc: 'max rows to show (list, default 20)' },
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
  const sub = args._?.[0]; // 'list' | 'book' | 'update' | 'cancel' | 'note'
  if (sub === 'list') return listAppointments(args, ctx);
  if (!sub || !SUBCOMMANDS.includes(sub)) {
    throw new GhlError(
      'usage: sizmo appointment list [--days 14]\n' +
      '       sizmo appointment book --calendar <name> --contact <id> --start <iso>\n' +
      '       sizmo appointment update <apptId> [--start] [--end] [--status]\n' +
      '       sizmo appointment cancel <apptId>\n' +
      '       sizmo appointment note <apptId> --text "..."',
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

    const end          = args.end;
    const title        = args.title;
    const assignedUser = args['assigned-user'];
    const address      = args.address;
    const noNotify     = !!args['no-notify'];

    // Validate ISO date roughly (must be parseable)
    const startMs = Date.parse(start);
    if (isNaN(startMs)) {
      throw new GhlError(`appointment book: invalid --start '${start}' — must be ISO 8601 (e.g. 2026-06-15T10:00:00Z)`, EXIT.USAGE);
    }
    // --end gets the same validation as --start, plus ordering. Catching this locally beats a
    // raw GHL 4xx, and an end-before-start booking is a mistake worth refusing rather than sending.
    let endMs = null;
    if (end != null) {
      endMs = Date.parse(end);
      if (isNaN(endMs)) {
        throw new GhlError(`appointment book: invalid --end '${end}' — must be ISO 8601 (e.g. 2026-06-15T11:00:00Z)`, EXIT.USAGE);
      }
      if (endMs <= startMs) {
        throw new GhlError(`appointment book: --end (${end}) must be after --start (${start})`, EXIT.USAGE);
      }
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
      ...(end          ? [`  end:     ${end}`]                : [`  end:     (calendar slot duration)`]),
      ...(title        ? [`  title:   ${title}`]              : []),
      ...(assignedUser ? [`  assigned: ${assignedUser}`]      : []),
      ...(address      ? [`  location: ${address}`]           : []),
      // Automations are the invisible side effect of booking: GHL defaults toNotify to true, so a
      // confirm that only lists calendar/contact/time understates what is about to happen — the
      // contact may get an SMS/email and workflows may fire. Say so before the human approves.
      noNotify
        ? `  ⚠ automations SUPPRESSED (--no-notify) — no confirmation message will be sent`
        : `  ⚠ this will fire the location's automations (confirmation SMS/email, workflows) — use --no-notify to suppress`,
      ...(staleNote ? [`  (${staleNote})`] : []),
    ];
    const rerunParts = [
      `sizmo appointment book --calendar "${calName}" --contact ${contact} --start "${start}"`,
      ...(end          ? [`--end "${end}"`]                    : []),
      ...(title        ? [`--title "${title.replace(/"/g, '\\"')}"`] : []),
      ...(assignedUser ? [`--assigned-user ${assignedUser}`]   : []),
      ...(address      ? [`--address "${address.replace(/"/g, '\\"')}"`] : []),
      ...(noNotify     ? ['--no-notify']                       : []),
      '--confirm',
    ];
    const rerunCommand = rerunParts.join(' ');

    const gate = requireConfirm({ command: 'appointment book', changes, rerunCommand }, ctx);
    if (!gate.proceed) return gate.code;

    // Execute
    // GHL requires locationId in the body (verified live: 400 "Location ID is required" without it).
    // Optional fields are OMITTED when not passed rather than sent as null/empty — GHL treats an
    // explicit null differently from an absent key on several of these (notably title, which it
    // auto-generates only when the key is missing).
    const r = await ctx.http.post('/calendars/events/appointments', {
      calendarId: cal.id,
      locationId: ctx.cfg.loc,
      contactId: contact,
      startTime: start,
      ...(end          && { endTime: end }),
      ...(title        && { title }),
      ...(assignedUser && { assignedUserId: assignedUser }),
      ...(address      && { address }),
      ...(noNotify     && { toNotify: false }),
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

  // ── update (reschedule / mark outcome) ───────────────────────────────────────
  // PUT /calendars/events/appointments/{eventId}. sizmo could BOOK and CANCEL but not MOVE a
  // booking — the single most common calendar action a coach takes was a UI trip. It also could
  // not mark an outcome: `sizmo noshow` REPORTS no-shows by reading appointmentStatus, while
  // nothing could set it. You could see who no-showed and not record that you had seen it.
  if (sub === 'update') {
    const apptId = args._?.[1];
    if (!apptId) {
      throw new GhlError('usage: sizmo appointment update <apptId> [--start ISO] [--end ISO] [--status ...]',
        EXIT.USAGE, 'sizmo noshow   # to find appointment ids');
    }

    // Spellings sizmo's own reader already accepts from real GHL data (noshow.mjs), normalised to
    // one canonical form. HONEST LIMIT: which spelling GHL accepts on WRITE is unverified — its
    // read-side data carries all three, and confirming would mean mutating a real booking. If a
    // no-show write is ever rejected, this normalisation is the first thing to check.
    const STATUS_ALIASES = {
      confirmed: 'confirmed', showed: 'showed', cancelled: 'cancelled', canceled: 'cancelled',
      invalid: 'invalid', noshow: 'noshow', 'no-show': 'noshow', 'no_show': 'noshow',
    };
    let apptStatus = null;
    if (args.status != null) {
      const key = String(args.status).toLowerCase();
      apptStatus = STATUS_ALIASES[key] ?? null;
      if (!apptStatus) {
        throw new GhlError(
          `appointment update: unknown --status '${args.status}' — one of: ${[...new Set(Object.values(STATUS_ALIASES))].join(' | ')}`,
          EXIT.USAGE);
      }
    }

    const start = args.start ?? null;
    const end   = args.end ?? null;
    for (const [flag, v] of [['--start', start], ['--end', end]]) {
      if (v != null && isNaN(Date.parse(v))) {
        throw new GhlError(`appointment update: invalid ${flag} '${v}' — must be ISO 8601`, EXIT.USAGE);
      }
    }
    if (start != null && end != null && Date.parse(end) <= Date.parse(start)) {
      throw new GhlError(`appointment update: --end (${end}) must be after --start (${start})`, EXIT.USAGE);
    }

    const EDITABLE = { title: 'title', address: 'address', 'assigned-user': 'assignedUserId' };
    const body = {
      ...(start ? { startTime: start } : {}),
      ...(end ? { endTime: end } : {}),
      ...(apptStatus ? { appointmentStatus: apptStatus } : {}),
      ...(args['no-notify'] ? { toNotify: false } : {}),
    };
    for (const [flag, api] of Object.entries(EDITABLE)) {
      if (args[flag] != null) body[api] = String(args[flag]);
    }
    if (Object.keys(body).length === 0) {
      throw new GhlError(
        'appointment update requires at least one of --start, --end, --status, --title, --address, --assigned-user',
        EXIT.USAGE);
    }

    // Fetch first: proves the id exists before writing and lets the preview show what time the
    // booking is moving FROM, which is the whole point of a reschedule confirmation.
    const got = await ctx.http.get(`/calendars/events/appointments/${encodeURIComponent(apptId)}`);
    if (got.code === 401 || got.code === 403) {
      throw new GhlError(`HTTP ${got.code} — your PIT lacks calendars.write`, EXIT.AUTH,
        'GoHighLevel → Settings → Private Integrations → edit your PIT → add calendars.write scope');
    }
    if (got.code === 404) throw new GhlError(`no appointment with id ${apptId} — nothing changed`, EXIT.NOTFOUND);
    if (!got.ok) throw new GhlError(`could not read appointment ${apptId} — HTTP ${got.code}`, EXIT.API);
    const cur = got.j?.appointment ?? got.j?.event ?? got.j ?? {};

    const changes = [`Update appointment ${apptId}${cur.title ? ` ("${cur.title}")` : ''}`];
    if (start) changes.push(`  start:  ${cur.startTime ? `${cur.startTime}  →  ` : ''}${start}`);
    if (end)   changes.push(`  end:    ${cur.endTime ? `${cur.endTime}  →  ` : ''}${end}`);
    if (start && !end) {
      changes.push('  ⚠ moving --start without --end: the booking\'s duration is decided by GHL, not preserved here');
    }
    if (apptStatus) changes.push(`  status: ${cur.appointmentStatus ?? '?'}  →  ${apptStatus}`);
    for (const [flag, api] of Object.entries(EDITABLE)) {
      if (args[flag] != null) changes.push(`  ${api}: ${args[flag]}`);
    }
    changes.push(args['no-notify']
      ? '  ⚠ automations SUPPRESSED (--no-notify) — the contact will NOT be told it moved'
      : '  ⚠ this fires the location\'s automations — the contact is notified of the change');

    const parts = [`sizmo appointment update ${apptId}`];
    if (start) parts.push(`--start "${start}"`);
    if (end)   parts.push(`--end "${end}"`);
    if (args.status != null) parts.push(`--status ${apptStatus}`);
    for (const flag of Object.keys(EDITABLE)) {
      if (args[flag] != null) parts.push(`--${flag} "${String(args[flag]).replace(/"/g, '\\"')}"`);
    }
    if (args['no-notify']) parts.push('--no-notify');
    const rerunCommand = parts.join(' ') + ' --confirm';

    const gate = requireConfirm({ command: 'appointment update', changes, rerunCommand }, ctx);
    if (!gate.proceed) return gate.code;

    const r = await ctx.http.put(`/calendars/events/appointments/${encodeURIComponent(apptId)}`, body);
    if (r.code === 401 || r.code === 403) {
      throw new GhlError(`HTTP ${r.code} — your PIT lacks calendars.write`, EXIT.AUTH,
        'GoHighLevel → Settings → Private Integrations → edit your PIT → add calendars.write scope');
    }
    if (r.code === 404) throw new GhlError(`no appointment with id ${apptId} — nothing changed`, EXIT.NOTFOUND);
    if (!r.ok) throw new GhlError(`appointment update failed — HTTP ${r.code}: ${(r.txt || '').slice(0, 200)}`, EXIT.API);

    ctx.out.data({ status: 'ok', command: 'appointment update', appointmentId: apptId, changed: Object.keys(body) });
    ctx.out.line(`  appointment ${apptId} updated — ${Object.keys(body).length} field(s)`);
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

  // ── note ──────────────────────────────────────────────────────────────────────
  if (sub === 'note') {
    const apptId = args._?.[1];
    const text = args.text || null;
    if (!apptId) throw new GhlError('usage: sizmo appointment note <apptId> --text "..."', EXIT.USAGE);
    if (!text || !text.trim()) throw new GhlError('appointment note requires --text "..."', EXIT.USAGE, 'sizmo appointment note <apptId> --text "your note"');

    const preview = text.length > 80 ? text.slice(0, 80) + '…' : text;
    const changes = [`Add note to appointment ${apptId}: "${preview}"`];
    const rerunCommand = `sizmo appointment note ${apptId} --text "${text.replace(/"/g, '\\"')}" --confirm`;

    const gate = requireConfirm({ command: 'appointment note', changes, rerunCommand }, ctx);
    if (!gate.proceed) return gate.code;

    // Body field is `body`, matching GHL's own naming here (contact notes use the same field
    // name at the top level, not nested) — verified via describe_operation, not guessed.
    const r = await ctx.http.post(`/calendars/appointments/${encodeURIComponent(apptId)}/notes`, { body: text });

    if (r.code === 401 || r.code === 403) {
      throw new GhlError(
        `HTTP ${r.code} — your PIT lacks calendars.write — add it in GoHighLevel → Private Integrations`,
        EXIT.AUTH,
        'GoHighLevel → Settings → Private Integrations → edit your PIT → add calendars.write scope'
      );
    }
    if (!r.ok) {
      throw new GhlError(`appointment note failed — HTTP ${r.code}: ${(r.txt || '').slice(0, 200)}`, EXIT.API);
    }

    // Response nesting is unverified against the live API (describe_operation covers request
    // shape, not response) — defensive lookup rather than assuming flat, since the contact-note
    // equivalent (commands/note.mjs) was nested under a "note" key and a flat assumption there
    // silently returned null for months. Live-verified once at ship time either way.
    const noteId = r.j?.id ?? r.j?.note?.id ?? null;
    ctx.out.data({ status: 'ok', command: 'appointment note', appointmentId: apptId, noteId });
    ctx.out.line(`  note added to appointment ${apptId}`);
    return EXIT.OK;
  }
}

// ── list ─────────────────────────────────────────────────────────────────────
//
// WHY THIS EXISTS
// Every calendar read in this tool ended its window at NOW. `noshow` and `booked-not-paid` both ask
// /calendars/events for `endTime: NOW`, because both are looking backwards at what already happened.
// The consequence was that NO command could return an appointment in the future: you could book one
// with `sizmo appointment book` and then have no way to see it. The tool was forward-blind.
//
// The endpoint supports a forward window fine — nothing was blocked, the query was just never asked.
// This uses the identical request noshow makes, with the window pointed the other way.
//
// READ-ONLY.
const LIST_DAYS_DEFAULT = 14;
const LIST_TOP_DEFAULT = 20;
// Same cap noshow documents: /calendars/events has no pagination cursor, so a calendar at the cap may
// be truncated and there is no way to page past it. Say so rather than under-report silently.
const LIST_EVENTS_CAP = 100;
// Statuses that mean the appointment is no longer going to happen. Same vocabulary noshow filters on.
const DEAD_STATUSES = new Set(['cancelled', 'canceled', 'invalid']);

async function listAppointments(args, ctx) {
  const LOC = ctx.cfg.loc;
  const NOW = typeof ctx.now === 'function' ? ctx.now() : ctx.now;
  const DAYS = args.days ?? LIST_DAYS_DEFAULT;
  const TOP = args.top ?? LIST_TOP_DEFAULT;
  if (!Number.isInteger(DAYS) || DAYS < 1) {
    throw new GhlError(`--days must be a positive integer (got ${JSON.stringify(args.days)})`, EXIT.USAGE,
      'example: sizmo appointment list --days 30');
  }
  if (!Number.isInteger(TOP) || TOP < 1) {
    throw new GhlError(`--top must be a positive integer (got ${JSON.stringify(args.top)})`, EXIT.USAGE,
      'example: sizmo appointment list --top 50');
  }
  const END = NOW + DAYS * 86400000;

  // Calendars come from the synced model when available, exactly as noshow resolves them.
  let cals = null;
  if (ctx.ensureModel) {
    try {
      const model = await ctx.ensureModel();
      const ent = model?.entities?.calendars;
      if (ent && !ent.blocked && !ent.networkError) cals = ent.items ?? [];
    } catch { /* fall through to a live fetch */ }
  }
  if (cals === null) {
    const cr = await ctx.http.get('/calendars/', { query: { locationId: LOC }, version: '2021-04-15' });
    if (cr.code === 401 || cr.code === 403) {
      throw new GhlError(`HTTP ${cr.code} — your PIT lacks calendars.readonly`, EXIT.AUTH,
        'GoHighLevel → Settings → Private Integrations → edit your PIT → add calendars.readonly scope');
    }
    if (!cr.ok) throw new GhlError(`could not read calendars — HTTP ${cr.code}`, EXIT.API);
    cals = cr.j?.calendars ?? [];
  }
  if (!cals.length) {
    ctx.out.data({ location: LOC, days: DAYS, calendars: 0, upcoming: 0, shown: 0, appointments: [] });
    ctx.out.card(() => ctx.out.line('\n  No calendars in this location — nothing can be booked yet.\n'));
    return EXIT.OK;
  }

  // Fan out at the shared cap of 5, the same policy noshow and booked-not-paid use.
  const results = await mapLimit(cals, 5, async (cal) => ({
    cal,
    ev: await ctx.http.get('/calendars/events', {
      query: { locationId: LOC, calendarId: cal.id, startTime: String(NOW), endTime: String(END) },
      version: '2021-04-15',
    }),
  }));

  const appts = [];
  let unreadable = 0, cappedCalendars = 0;
  for (const { cal, ev } of results) {
    if (!ev.ok) {
      unreadable++;
      // A calendar we cannot read is UNKNOWN, not empty. Counting it as "no appointments" would tell
      // someone their week is clear when it may not be.
      ctx.out.warn(`calendar "${cal.name || cal.id}" events unreadable (HTTP ${ev.code}) — its appointments are NOT included`,
        { degraded: true });
      continue;
    }
    const evList = ev.j?.events || ev.j?.appointments || [];
    if (evList.length >= LIST_EVENTS_CAP) {
      cappedCalendars++;
      ctx.out.warn(`calendar "${cal.name || cal.id}" returned ${evList.length} events — /calendars/events has no pagination cursor, so later appointments may be missing`,
        { degraded: true });
    }
    for (const e of evList) {
      const status = String(e.appointmentStatus || e.status || '').toLowerCase();
      if (DEAD_STATUSES.has(status)) continue;      // cancelled is not upcoming
      const start = Date.parse(e.startTime || e.startTimeISO || e.appointmentStartTime) || 0;
      // The server window is trusted but not relied on: the local check is authoritative, the same
      // way reconcile keeps its own millisecond filter over a server date range.
      if (!start || start < NOW || start > END) continue;
      appts.push({
        id: e.id || e._id || null,
        title: e.title || null,
        calendar: cal.name || cal.id,
        calendarId: cal.id,
        contactId: e.contactId ?? null,
        contactName: e.contactName ?? null,
        status: status || null,
        startTime: new Date(start).toISOString(),
        endTime: e.endTime ? new Date(Date.parse(e.endTime)).toISOString() : null,
        inDays: Math.floor((start - NOW) / 86400000),
      });
    }
  }

  // Soonest first — the only ordering that answers "what is next?"
  appts.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  const shown = appts.slice(0, TOP);
  const incomplete = unreadable > 0 || cappedCalendars > 0;

  ctx.out.data({
    location: LOC,
    days: DAYS,
    windowEndISO: new Date(END).toISOString(),
    calendars: cals.length,
    ...(unreadable ? { unreadableCalendars: unreadable } : {}),
    upcoming: appts.length,
    shown: shown.length,
    ...(incomplete ? { truncated: true } : {}),
    appointments: shown,
  });

  ctx.out.card(() => {
    const floor = incomplete ? 'at least ' : '';
    ctx.out.line(`\n  UPCOMING — ${floor}${appts.length} appointment(s) in the next ${DAYS}d  ·  ${cals.length} calendar(s)  ·  loc ${LOC}`);
    ctx.out.line('  ' + '─'.repeat(76));
    if (!appts.length) {
      ctx.out.line(incomplete
        ? '  Nothing found, but at least one calendar could not be read — this is not a clear week.'
        : `  Nothing booked in the next ${DAYS}d.`);
      ctx.out.line('');
      return;
    }
    for (const a of shown) {
      const when = a.startTime.replace('T', ' ').slice(0, 16);
      const rel = a.inDays === 0 ? 'today' : a.inDays === 1 ? 'tomorrow' : `in ${a.inDays}d`;
      ctx.out.line(`  ${when}  ${String(rel).padEnd(9)} ${(a.contactName || a.title || '(untitled)').slice(0, 24).padEnd(24)} ${String(a.calendar).slice(0, 18)}`);
      ctx.out.line(`      id ${a.id ?? '(none)'}${a.status ? ` · ${a.status}` : ''}`);
    }
    if (appts.length > shown.length) ctx.out.line(`  … +${appts.length - shown.length} more — raise --top`);
    ctx.out.line('  ' + '─'.repeat(76));
    ctx.out.line('  Copy an id → sizmo appointment cancel <id> --confirm  ·  sizmo appointment update <id> --start <iso> --confirm\n');
  });
  return EXIT.OK;
}

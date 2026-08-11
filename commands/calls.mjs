// commands/calls.mjs — what your Voice AI agents actually did. READ-ONLY.
//
// WHY THIS EXISTS
// Every other surface in this tool reports what HUMANS did — messages, bookings, deals, invoices. If
// an AI receptionist answers the phone, none of it sees that. The question a coach with Voice AI
// actually asks on a Monday is "how many calls did it take, and did any of them turn into a booking",
// and sizmo had no way to answer it.
//
// The interesting number is not the call count. It is what the agent DID: an appointment booked is
// revenue, a transfer is a human interrupted, and a call that produced neither is a call that cost
// money and returned nothing. So actions are counted first and the raw total second.
//
// VERIFICATION BOUNDARY — read this before trusting field names.
// The REQUEST is documented: describe_operation on `get-call-logs` gives every parameter, its type
// and its constraints, and those are pinned by tests. The RESPONSE shape is NOT documented and has
// not been observed against a live account with Voice AI configured — sizmo's own rule is that MCP
// is for introspection only, never execute_operation. So every field is read defensively through a
// list of plausible spellings, and anything unreadable renders as unknown rather than zero. If a
// real account shows different field names, extend the accessor lists; do not assume a zero.
import { GhlError, EXIT } from '../lib/errors.mjs';
import { fmtShortDate } from '../lib/dates.mjs';
import { timezoneFromModel } from '../lib/model.mjs';
import { mapLimit } from '../lib/pool.mjs';

const DAYS_DEFAULT = 7;
const TOP_DEFAULT = 20;
// The API caps pageSize at 50 (documented in describe_operation). Asking for more is a 4xx, not a
// bigger page, so this is a hard ceiling rather than a preference.
const PAGE_SIZE = 50;
// Paging is 1-based page numbers with no cursor, so there is no way to prove we reached the end
// other than a short page. This cap bounds a runaway; hitting it means the answer is a FLOOR.
const MAX_PAGES = 40;

const SCOPE_FIX = (scope) =>
  `GoHighLevel → Settings → Private Integrations → edit your PIT → add ${scope} scope`;

export const meta = {
  name: 'calls',
  summary: 'what your Voice AI agents did — calls handled, bookings made, transfers to a human',
  flags: [
    { name: '--days',  type: 'int',    desc: 'window to look back (default 7)' },
    { name: '--top',   type: 'int',    desc: 'max calls to list (default 20)' },
    { name: '--agent', type: 'string', desc: 'only this agent id — `sizmo calls` lists the ids' },
    { name: '--type',  type: 'string', desc: 'live | trial — TRIAL calls are tests, not real traffic' },
  ],
  readOnly: true,
};

// The response shape is unverified, so every read goes through one of these. First hit wins; a miss
// yields null, which renders as unknown. Never default to 0 — a field we cannot read is not a zero.
const pick = (obj, keys) => {
  for (const k of keys) {
    const v = k.split('.').reduce((o, part) => (o == null ? o : o[part]), obj);
    if (v !== undefined && v !== null) return v;
  }
  return null;
};

// ACTION_TYPE values are documented as an enum on the request filter, so these names are real even
// though we have not seen a response carrying them.
const ACTION_LABELS = {
  APPOINTMENT_BOOKING: 'appointments booked',
  CALL_TRANSFER: 'transferred to a human',
  SMS: 'texts sent',
  WORKFLOW_TRIGGER: 'workflows fired',
  DATA_EXTRACTION: 'data captured',
  IN_CALL_DATA_EXTRACTION: 'data captured in-call',
  CUSTOM_ACTION: 'custom actions',
  KNOWLEDGE_BASE: 'knowledge-base lookups',
};
// The two that mean money or a human's time. Surfaced above the rest.
const HEADLINE_ACTIONS = ['APPOINTMENT_BOOKING', 'CALL_TRANSFER'];

const fmtDuration = (sec) => {
  if (sec == null || !Number.isFinite(Number(sec))) return '—';
  const s = Math.round(Number(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

export async function run(args, ctx) {
  const LOC = ctx.cfg.loc;
  const NOW = typeof ctx.now === 'function' ? ctx.now() : ctx.now;
  const DAYS = args.days ?? DAYS_DEFAULT;
  const TOP = args.top ?? TOP_DEFAULT;
  if (!Number.isInteger(DAYS) || DAYS < 1) {
    throw new GhlError(`--days must be a positive integer (got ${JSON.stringify(args.days)})`, EXIT.USAGE,
      'example: sizmo calls --days 30');
  }
  if (!Number.isInteger(TOP) || TOP < 1) {
    throw new GhlError(`--top must be a positive integer (got ${JSON.stringify(args.top)})`, EXIT.USAGE,
      'example: sizmo calls --top 50');
  }
  let callType = null;
  if (args.type != null) {
    const t = String(args.type).trim().toUpperCase();
    if (t !== 'LIVE' && t !== 'TRIAL') {
      throw new GhlError(`--type must be live or trial (got ${JSON.stringify(args.type)})`, EXIT.USAGE,
        'TRIAL calls are your own tests; LIVE calls are real traffic');
    }
    callType = t;
  }

  const START = NOW - DAYS * 86400000;

  // Agent names, so the report says "Reception" and not an ObjectId. A failure here is cosmetic —
  // the call log still reports, ids just stay ids — so it degrades rather than throwing.
  const agentNames = new Map();
  let agentsBlocked = null;
  const ar = await ctx.http.get('/voice-ai/agents', { query: { page: 1, pageSize: PAGE_SIZE } });
  if (ar.ok) {
    for (const a of (ar.j?.agents ?? ar.j?.data ?? ar.j?.items ?? [])) {
      const id = pick(a, ['id', '_id', 'agentId']);
      const nm = pick(a, ['name', 'agentName', 'title']);
      if (id) agentNames.set(String(id), nm ? String(nm) : null);
    }
  } else {
    agentsBlocked = ar.code;
    ctx.out.warn(`agent names unreadable (HTTP ${ar.code}) — calls are still reported, by id`,
      { degraded: true });
  }

  // startDate and endDate must be sent TOGETHER — documented, and a lone bound is rejected.
  const baseQuery = {
    startDate: START, endDate: NOW, pageSize: PAGE_SIZE,
    ...(callType ? { callType } : {}),
    ...(args.agent ? { agentId: String(args.agent) } : {}),
  };

  const calls = [];
  let firstErr = null;
  let truncated = false;
  let page = 1;
  for (; page <= MAX_PAGES; page++) {
    const r = await ctx.http.get('/voice-ai/dashboard/call-logs', { query: { ...baseQuery, page } });
    if (!r.ok) { firstErr ??= r.code; break; }
    const batch = r.j?.callLogs ?? r.j?.logs ?? r.j?.calls ?? r.j?.data ?? r.j?.items ?? [];
    calls.push(...batch);
    // No cursor: a short page is the only end-of-data signal available.
    if (batch.length < PAGE_SIZE) break;
    if (page === MAX_PAGES) truncated = true;
  }

  // Nothing at all came back AND the source errored: UNKNOWN, never "no calls". Telling someone
  // their AI handled zero calls when the dashboard was unreadable is the worst way to be wrong here.
  if (firstErr && calls.length === 0) {
    if (firstErr === 401 || firstErr === 403) {
      throw new GhlError(`HTTP ${firstErr} — your PIT lacks voice-ai-dashboard.readonly`, EXIT.AUTH,
        SCOPE_FIX('voice-ai-dashboard.readonly'));
    }
    if (firstErr === 404) {
      throw new GhlError('Voice AI call logs are not available on this location — no agents configured, or the feature is not enabled',
        EXIT.NOTFOUND, 'this is not an error in sizmo: the location has no Voice AI dashboard to read');
    }
    throw new GhlError(`could not read Voice AI call logs — HTTP ${firstErr}`, EXIT.API);
  }
  const partial = Boolean(firstErr) || truncated;
  if (firstErr && calls.length) {
    ctx.out.warn(`call log page ${page} failed with HTTP ${firstErr} after ${calls.length} call(s) — this is a FLOOR, not a total`,
      { degraded: true });
  }
  if (truncated) {
    ctx.out.warn(`stopped at ${MAX_PAGES} pages (${calls.length} calls) — more exist`, { degraded: true });
  }

  const rows = calls.map((c) => {
    const agentId = pick(c, ['agentId', 'agent.id', 'agent._id']);
    const startedRaw = pick(c, ['createdAt', 'startedAt', 'callStartedAt', 'dateAdded']);
    const started = startedRaw == null ? null : (Number.isFinite(Number(startedRaw)) ? Number(startedRaw) : Date.parse(startedRaw));
    const acts = pick(c, ['actions', 'actionTypes', 'triggeredActions']) ?? [];
    const actionTypes = (Array.isArray(acts) ? acts : [acts])
      .map(a => String(pick(a, ['type', 'actionType']) ?? a ?? '').toUpperCase())
      .filter(Boolean);
    return {
      id: pick(c, ['id', '_id', 'callId']),
      agentId: agentId ? String(agentId) : null,
      agent: agentId ? (agentNames.get(String(agentId)) ?? String(agentId)) : null,
      contactId: pick(c, ['contactId', 'contact.id']),
      contactName: pick(c, ['contactName', 'contact.name']),
      callType: pick(c, ['callType', 'type']),
      // `d == null` is checked FIRST and separately: pick() returns null for a missing field, and
      // Number(null) is 0, which is finite. Without the null check a call whose duration could not
      // be read counts as a zero-second call and drags the average down — the same
      // unreadable-is-not-zero trap this codebase has fixed on money surfaces, here on time.
      durationSec: (() => {
        const d = pick(c, ['duration', 'durationSec', 'callDuration']);
        if (d == null) return null;
        const n = Number(d);
        return Number.isFinite(n) ? n : null;
      })(),
      startedAt: Number.isFinite(started) ? new Date(started).toISOString() : null,
      actionTypes,
    };
  });

  // Counted per CALL, not per action: one call that books twice is one booking outcome. The question
  // is "how many calls produced a booking", not "how many booking events fired".
  const actionCounts = {};
  for (const r of rows) for (const t of new Set(r.actionTypes)) actionCounts[t] = (actionCounts[t] ?? 0) + 1;

  const byAgent = {};
  for (const r of rows) {
    const k = r.agent ?? '(unattributed)';
    byAgent[k] = byAgent[k] ?? { calls: 0, booked: 0, transferred: 0, durationSec: 0, durationKnown: 0 };
    byAgent[k].calls++;
    if (r.actionTypes.includes('APPOINTMENT_BOOKING')) byAgent[k].booked++;
    if (r.actionTypes.includes('CALL_TRANSFER')) byAgent[k].transferred++;
    if (r.durationSec != null) { byAgent[k].durationSec += r.durationSec; byAgent[k].durationKnown++; }
  }

  const withDuration = rows.filter(r => r.durationSec != null);
  const totalDuration = withDuration.reduce((s, r) => s + r.durationSec, 0);
  const booked = rows.filter(r => r.actionTypes.includes('APPOINTMENT_BOOKING')).length;
  const transferred = rows.filter(r => r.actionTypes.includes('CALL_TRANSFER')).length;

  rows.sort((a, b) => (Date.parse(b.startedAt ?? 0) || 0) - (Date.parse(a.startedAt ?? 0) || 0));
  const shown = rows.slice(0, TOP);

  ctx.out.data({
    location: LOC,
    days: DAYS,
    windowStartISO: new Date(START).toISOString(),
    windowEndISO: new Date(NOW).toISOString(),
    ...(callType ? { callType } : {}),
    ...(args.agent ? { agentFilter: String(args.agent) } : {}),
    calls: rows.length,
    booked,
    transferred,
    // Duration is reported with its own denominator: averaging over calls whose duration we could
    // not read would quietly understate it.
    durationKnownFor: withDuration.length,
    totalDurationSec: withDuration.length ? totalDuration : null,
    actionCounts,
    byAgent,
    ...(agentsBlocked ? { agentNamesBlocked: agentsBlocked } : {}),
    ...(partial ? { truncated: true, ...(firstErr ? { partialScanError: firstErr } : {}) } : {}),
    shown: shown.length,
    callsList: shown,
  });

  ctx.out.card(() => {
    const tz = timezoneFromModel(ctx.model);
    const floor = partial ? 'at least ' : '';
    ctx.out.line(`\n  VOICE AI — ${floor}${rows.length} call(s) in the last ${DAYS}d  ·  loc ${LOC}`);
    ctx.out.line('  ' + '─'.repeat(72));
    if (!rows.length) {
      ctx.out.line(partial
        ? '  No calls readable — this is NOT the same as no calls happening.'
        : `  No Voice AI calls in the last ${DAYS}d.`);
      ctx.out.line('');
      return;
    }
    // Outcomes first: these are the reason anyone runs this.
    ctx.out.line(`  booked an appointment    ${String(booked).padStart(4)}   ${rows.length ? Math.round(booked / rows.length * 100) : 0}% of calls`);
    ctx.out.line(`  transferred to a human   ${String(transferred).padStart(4)}   ${rows.length ? Math.round(transferred / rows.length * 100) : 0}% of calls`);
    const others = Object.entries(actionCounts)
      .filter(([t]) => !HEADLINE_ACTIONS.includes(t))
      .sort((a, b) => b[1] - a[1]);
    for (const [t, n] of others) {
      ctx.out.line(`  ${(ACTION_LABELS[t] ?? t.toLowerCase().replace(/_/g, ' ')).padEnd(24)} ${String(n).padStart(4)}`);
    }
    if (withDuration.length) {
      const avg = totalDuration / withDuration.length;
      const caveat = withDuration.length < rows.length ? `  (of ${withDuration.length}/${rows.length} with a readable duration)` : '';
      ctx.out.line(`  total time on calls      ${fmtDuration(totalDuration).padStart(4)}   avg ${fmtDuration(avg)}${caveat}`);
    } else {
      ctx.out.line('  total time on calls        —   (no readable durations)');
    }
    ctx.out.line('  ' + '─'.repeat(72));
    const agents = Object.entries(byAgent).sort((a, b) => b[1].calls - a[1].calls);
    if (agents.length > 1) {
      for (const [name, s] of agents) {
        ctx.out.line(`  ${name.slice(0, 22).padEnd(22)} ${String(s.calls).padStart(4)} calls · ${String(s.booked).padStart(3)} booked · ${String(s.transferred).padStart(3)} transferred`);
      }
      ctx.out.line('  ' + '─'.repeat(72));
    }
    for (const c of shown) {
      const when = c.startedAt ? fmtShortDate(Date.parse(c.startedAt), tz) : '—';
      const who = (c.contactName || c.contactId || '(unknown)').slice(0, 20).padEnd(20);
      const marks = [
        c.actionTypes.includes('APPOINTMENT_BOOKING') ? 'booked' : null,
        c.actionTypes.includes('CALL_TRANSFER') ? 'transferred' : null,
      ].filter(Boolean).join(' · ');
      ctx.out.line(`  ${when.padEnd(7)} ${who} ${fmtDuration(c.durationSec).padStart(7)}  ${marks}`);
    }
    if (rows.length > shown.length) ctx.out.line(`  … +${rows.length - shown.length} more — raise --top`);
    ctx.out.line('  ' + '─'.repeat(72));
    ctx.out.line('  Read-only. TRIAL calls are your own tests — filter with --type live.\n');
  });

  return EXIT.OK;
}

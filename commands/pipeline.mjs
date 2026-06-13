// commands/pipeline.mjs — Pipeline health: value by stage + stuck sweep.
// Trust-fix #1: LOC from ctx.cfg.loc.
// Trust-fix #2: opps paginate to completion.
// READ-ONLY.
import { paginate } from '../lib/paginate.mjs';

export const meta = {
  name: 'pipeline',
  summary: 'Pipeline health — value by stage + stuck deal sweep',
  flags: [
    { name: '--stuck-days', type: 'int', default: 7, desc: 'idle threshold in days' },
    { name: '--top', type: 'int', default: 100, desc: 'max stuck deals to show' },
  ],
  readOnly: true,
};

// NOTE: GHL opportunity monetaryValue carries no currency field — it inherits pipeline config.
// Hardcoding ₱ here is a known GHL API limitation; no currency param available per-opportunity.
const money = (n) => !Number.isFinite(Number(n)) ? '—' : '₱' + Number(n || 0).toLocaleString('en-PH', { maximumFractionDigits: 0 });
const touchedAt = (o) =>
  Date.parse(o.lastStatusChangeAt || o.lastStageChangeAt || o.updatedAt || o.dateUpdated || o.dateAdded || 0) || 0;

export async function collect(args, ctx) {
  const STUCK_DAYS = args['stuck-days'] ?? 7;
  const TOP = args.top ?? 100;
  const LOC = ctx.cfg.loc;
  const NOW = ctx.now;
  const STUCK_MS = STUCK_DAYS * 24 * 60 * 60 * 1000;
  const ago = (t) => {
    const d = Math.floor((NOW - t) / 86400000);
    return d >= 1 ? d + 'd' : Math.max(1, Math.floor((NOW - t) / 3600000)) + 'h';
  };

  // pipelines → stage id→name map
  const p = await ctx.http.get('/opportunities/pipelines', { query: { locationId: LOC } });
  if (!p.ok) {
    ctx.out.warn(`can't see pipelines → HTTP ${p.code}`, { degraded: true });
    return { location: LOC, totalValue: 0, openCount: 0, pipelines: [], stuck: [] };
  }
  const pipelines = p.j.pipelines || [];
  const stageName = {}, pipeName = {}, stageOrder = {};
  for (const pl of pipelines) {
    pipeName[pl.id] = pl.name;
    (pl.stages || []).forEach((s, i) => { stageName[s.id] = s.name; stageOrder[s.id] = i; });
  }

  // all open opps paginated to completion (trust-fix #2)
  const opps = [];
  let firstOppErr = null;
  for await (const o of paginate({
    fetchPage: async (page = 1) => {
      const r = await ctx.http.get('/opportunities/search', {
        query: { location_id: LOC, status: 'open', limit: 100, page },
      });
      if (!r.ok) return { _err: r.code, opportunities: [] };
      return r.j;
    },
    getItems: (resp) => {
      if (resp._err) { firstOppErr = resp._err; return []; }
      return resp.opportunities || resp.data || [];
    },
    nextCursor: (resp, items, page = 1) => {
      if (resp._err || items.length < 100) return null;
      return page + 1;
    },
    maxPages: 20,
    startCursor: 1,
  })) {
    opps.push(o);
  }

  if (firstOppErr && opps.length === 0) {
    ctx.out.warn(`can't see opportunities → HTTP ${firstOppErr}`, { degraded: true });
    return { location: LOC, totalValue: 0, openCount: 0, pipelines: [], stuck: [] };
  }

  // group by pipeline→stage
  const byPipe = {};
  let total = 0;
  for (const o of opps) {
    const pid = o.pipelineId, sid = o.pipelineStageId || o.stageId;
    const val = Number(o.monetaryValue || o.monetary_value || 0) || 0;
    total += val;
    (byPipe[pid] ??= {})[sid] ??= { count: 0, value: 0 };
    byPipe[pid][sid].count++;
    byPipe[pid][sid].value += val;
  }

  // stuck = open, untouched >= STUCK_DAYS
  const stuck = opps
    .map(o => ({ o, t: touchedAt(o) }))
    .filter(x => x.t > 0 && (NOW - x.t) >= STUCK_MS)
    .sort((a, b) => a.t - b.t)
    .slice(0, TOP);

  return {
    location: LOC,
    totalValue: total,
    openCount: opps.length,
    pipelines: Object.entries(byPipe).map(([pid, stages]) => ({
      pipeline: pipeName[pid] || pid,
      stages: Object.entries(stages)
        .map(([sid, v]) => ({ stage: stageName[sid] || sid, ...v }))
        .sort((a, b) => (stageOrder[a.sid] || 0) - (stageOrder[b.sid] || 0)),
    })),
    stuck: stuck.map(x => ({
      name: x.o.name,
      value: x.o.monetaryValue,
      stage: stageName[x.o.pipelineStageId] || '',
      idle: ago(x.t),
      oppId: x.o.id,
      contactId: x.o.contactId,
    })),
  };
}

export async function run(args, ctx) {
  const data = await collect(args, ctx);
  ctx.out.data(data);

  const STUCK_DAYS = args['stuck-days'] ?? 7;
  const TOP = args.top ?? 100;
  const money2 = (n) => '₱' + Number(n || 0).toLocaleString('en-PH', { maximumFractionDigits: 0 });

  ctx.out.card(() => {
    ctx.out.line(`\n  PIPELINE HEALTH  ·  ${money2(data.totalValue)} across ${data.openCount} open deal(s)  ·  loc ${data.location}`);
    for (const pl of data.pipelines) {
      ctx.out.line(`\n  ${pl.pipeline}`);
      for (const s of pl.stages) {
        ctx.out.line(`    ${(s.stage || '').slice(0, 28).padEnd(28)} ${String(s.count).padStart(3)} deal  ${money2(s.value).padStart(12)}`);
      }
    }
    ctx.out.line(`\n  STUCK — open + untouched ≥ ${STUCK_DAYS}d (oldest first, top ${TOP})`);
    ctx.out.line('  ' + '─'.repeat(70));
    if (!data.stuck.length) {
      ctx.out.line('  Nothing stuck. Pipeline moving. ✅');
    } else {
      data.stuck.forEach((x, i) => {
        ctx.out.line(`  ${String(i + 1).padStart(2)}. ${(x.name || '(no name)').slice(0, 26).padEnd(26)} ${money2(x.value).padStart(11)}  idle ${(x.idle || '?').padEnd(5)} ${x.stage}`);
        ctx.out.line(`      opp ${x.oppId} · contact ${x.contactId}`);
      });
    }
    ctx.out.line('  ' + '─'.repeat(70));
    ctx.out.line('  → nudge list = the stuck deals; I can move a stage / set lost-reason on your say-so (L2, one at a time).\n');
  });
  return 0;
}

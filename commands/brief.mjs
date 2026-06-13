// commands/brief.mjs — Morning brief orchestrator. In-process: calls the 5 sub-collect()s on the
// SAME shared ctx. One http client, one rate budget, zero child-process spawning.
// NEEDS YOU TODAY uses rankActions from lib/prioritize.mjs — same ranker as ghl focus.
// READ-ONLY. Never writes, never sends, never charges.
import { collect as snapCollect } from './snapshot.mjs';
import { collect as triageCollect } from './triage.mjs';
import { collect as noshowCollect } from './noshow.mjs';
import { collect as pipeCollect } from './pipeline.mjs';
import { collect as arCollect } from './receivables.mjs';
import { rankActions, hasMixedCurrencies } from '../lib/prioritize.mjs';

export const meta = {
  name: 'brief',
  summary: 'morning brief — numbers + NEEDS YOU TODAY',
  flags: [
    { name: '--days',    type: 'int',  default: 7,     desc: 'snapshot window in days' },
    { name: '--verbose', type: 'bool', default: false, desc: 'include raw sources blob in JSON output' },
  ],
  readOnly: true,
};

// ── helpers ──────────────────────────────────────────────────────────────────
const SYM = { PHP: '₱', USD: '$', EUR: '€', GBP: '£' };
const m = (n, c = 'PHP') => !Number.isFinite(Number(n)) ? '—' : (SYM[c] || c + ' ') + Number(n || 0).toLocaleString('en-PH', { maximumFractionDigits: 0 });

// Parse an age string like "21d", "3h", "5m" back to ageDays
function parseAgeDays(str) {
  if (typeof str === 'number') return str;
  if (!str) return 0;
  const match = String(str).match(/^(\d+(?:\.\d+)?)(d|h|m)$/i);
  if (!match) return 0;
  const n = Number(match[1]);
  if (match[2] === 'd') return n;
  if (match[2] === 'h') return Math.ceil(n / 24);
  return Math.max(0, Math.ceil(n / 1440));
}

// Shape the 4 lane sources into rankActions input format.
// Called by both collect() (for the JSON envelope) and run() (for the TTY card).
function shapeLanes(sources, now) {
  const { triage, noshow, pipeline: pipe, receivables: ar, bnp } = sources;

  const deals = pipe?.__error ? [] : (pipe?.stuck || []).map(d => ({
    contactId:     d.contactId,
    name:          d.name || '(unknown)',
    monetaryValue: Number(d.value) || 0,
    ageDays:       parseAgeDays(d.idle),
  }));

  const invoices = ar?.__error ? [] : (ar?.list || []).map(i => ({
    contactId: i.id,
    name:      i.name || '(unknown)',
    due:       Number(i.due) || 0,
    cur:       i.cur || 'PHP',
    ageDays:   Number(i.age) || 0,
  }));

  const threads = triage?.__error ? [] : (triage?.threads || []).map(t => ({
    contactId: t.contactId,
    name:      t.name || '(unknown)',
    ageDays:   parseAgeDays(t.waiting),
  }));

  const noshows = noshow?.__error ? [] : (noshow?.list || []).map(n => ({
    contactId: n.contactId,
    name:      n.name || '(unknown)',
    ageDays:   Math.floor((now - new Date(n.when).getTime()) / 86400000),
  }));

  const neverBilled = bnp?.__error ? [] : (bnp?.neverBilled || []).map(b => ({
    contactId: b.contactId,
    name:      b.name || '(unknown)',
    estValue:  0,
    ageDays:   Math.floor((now - (b.lastSessionTs || 0)) / 86400000),
  }));

  return { deals, invoices, threads, noshows, neverBilled };
}

// Wrap a collect() so a throw → degraded sentinel instead of crashing the brief.
async function safe(name, fn, ctx) {
  try {
    return await fn();
  } catch (err) {
    const msg = `${name} failed — ${(err?.message || String(err)).split('\n')[0]}`;
    ctx.out.warn(msg, { degraded: true });
    return { __error: msg };
  }
}

// Build what actually gets passed to ctx.out.data() — strips the internal _sources
// property and applies --concise trimming when ctx.concise is set.
function buildEmitData(data, ctx) {
  // data._sources is an internal-only ref (set when --verbose is NOT passed).
  // If --verbose was passed, data.sources is already set and _sources absent.
  const { _sources, ...rest } = data;

  if (ctx.concise) {
    // --concise: snapshot metrics values-only array + action count+recipe (no prose, no inputs)
    const snap = rest.snapshot;
    const conciseSnapshot = snap?.__error
      ? { __error: snap.__error }
      : { metrics: (snap?.metrics || []).map(m => ({ label: m.label, value: m.blocked ? null : m.value, blocked: m.blocked || undefined })) };

    return {
      snapshot: conciseSnapshot,
      actions: (rest.actions || []).map(a => ({
        kind:   a.kind,
        recipe: a.recipe,
        money:  a.money ?? undefined,
        age:    a.age ?? undefined,
      })),
      ...(rest.sources && { sources: rest.sources }),
    };
  }

  return rest;
}

// ── collect: the composable data layer ───────────────────────────────────────
export async function collect(args, ctx) {
  const DAYS = args.days != null ? args.days : 7;

  // Fan-out all 5 sub-collects in parallel on the same ctx.
  // Each uses ctx.cfg.loc / ctx.http / ctx.now — no creds duplication.
  const [snap, triage, noshow, pipe, ar] = await Promise.all([
    safe('snapshot',   () => snapCollect({ days: DAYS }, ctx), ctx),
    safe('triage',     () => triageCollect({ days: 30, top: 100 }, ctx), ctx),
    safe('noshow',     () => noshowCollect({ days: 30, top: 100 }, ctx), ctx),
    safe('pipeline',   () => pipeCollect({ 'stuck-days': 7, top: 100 }, ctx), ctx),
    safe('receivables',() => arCollect({ top: 100 }, ctx), ctx),
  ]);

  const loc = snap.location || triage.location || ctx.cfg.loc;

  // Build the prioritised action list using rankActions (same ranker as ghl focus).
  // Additive: keep count + recipe for backward compat; add money + age fields.
  const lanes = shapeLanes({ triage, noshow, pipeline: pipe, receivables: ar }, ctx.now);
  const { ranked, unknownValue } = rankActions(lanes);

  // Build the actions array: ranked items first (money-ordered), then unknownValue items.
  // Keep backward-compat fields (count, kind, recipe) — add money + age.
  const actions = [];
  for (const item of ranked) {
    const recipeMap = { deal: 'pipeline', invoice: 'receivables', 'never-billed': 'booked-not-paid' };
    actions.push({
      count: 1,
      kind:  item.kind === 'deal' ? 'stuck-deals' : item.kind === 'invoice' ? 'receivables' : item.kind,
      recipe: recipeMap[item.kind] || item.action.replace('ghl ', ''),
      money:  item.money,
      cur:    item.cur,
      age:    item.age,
      inputs: item.inputs,
      contact: item.contact,
      name:    item.name,
    });
  }
  for (const item of unknownValue) {
    const recipeMap = { 'waiting-reply': 'triage', noshow: 'noshow', 'never-billed': 'booked-not-paid' };
    actions.push({
      count: 1,
      kind:  item.kind,
      recipe: recipeMap[item.kind] || item.action.replace('ghl ', ''),
      money:  null,
      age:    item.age,
      inputs: item.inputs,
      contact: item.contact,
      name:    item.name,
    });
  }

  const base = {
    location: loc,
    days: DAYS,
    snapshot: snap,
    actions,
  };

  // sources is always computed (TTY render reads _sources below).
  // Only included in the returned data when --verbose is passed.
  const fullSources = { triage, noshow, pipeline: pipe, receivables: ar };
  return args.verbose
    ? { ...base, sources: fullSources }
    : { ...base, _sources: fullSources }; // _sources = internal, stripped before emit
}

// ── run: bimodal output (JSON envelope OR TTY morning card) ──────────────────
export async function run(args, ctx) {
  const DAYS = args.days != null ? args.days : 7;
  const data = await collect(args, ctx);

  // Machine mode: emit lean or verbose data via buildEmitData.
  // --concise (global ctx.concise) trims to numbers + action counts only.
  ctx.out.data(buildEmitData(data, ctx));

  // TTY mode: render the MORNING BRIEF card
  // _sources is the internal ref (non-verbose path); sources is the verbose path.
  const sources = data.sources || data._sources || {};
  ctx.out.card(() => {
    const today = new Date().toLocaleDateString('en-US', {
      timeZone: 'Asia/Manila', weekday: 'long', month: 'short', day: 'numeric',
    });
    const W = 64;
    const bar = (ch = '─') => ch.repeat(W);
    const pad = (s) => { const str = String(s); return str.length >= W ? str.slice(0, W) : str + ' '.repeat(W - str.length); };

    ctx.out.line('\n╔' + bar('═') + '╗');
    ctx.out.line('║' + pad('  MORNING BRIEF — ' + today) + '║');
    ctx.out.line('║' + pad('  loc ' + data.location + '  ·  read-only') + '║');
    ctx.out.line('╚' + bar('═') + '╝');

    // THE NUMBERS
    ctx.out.line('\n  THE NUMBERS (last ' + DAYS + 'd)');
    ctx.out.line('  ' + bar());
    const snap = data.snapshot;
    if (snap.__error) {
      ctx.out.line('  ⚠ snapshot — ' + snap.__error);
    } else {
      for (const metric of (snap.metrics || [])) {
        const v = metric.blocked ? "⚠ can't see (" + metric.blocker + ')' : metric.value;
        ctx.out.line('  ' + String(metric.label).padEnd(16) + ' ' + v);
      }
    }

    // NEEDS YOU TODAY — ordered by rankActions (same ranker as ghl focus)
    const { triage, noshow, pipeline: pipe, receivables: ar } = sources;

    ctx.out.line('\n  NEEDS YOU TODAY');
    ctx.out.line('  ' + bar());

    // Surface blocked sources honestly — never fake a number
    for (const [name, obj] of [['triage', triage], ['no-show', noshow], ['pipeline', pipe], ['receivables', ar]]) {
      if (obj?.__error) ctx.out.line(`  ⚠ ${name} — ${obj.__error}`);
    }

    const actions = data.actions || [];
    if (!actions.length) {
      ctx.out.line('  All clear — nobody waiting, nothing stuck, nothing owed. ✅');
    } else {
      actions.forEach((action, i) => {
        const label = action.inputs || action.name || action.kind;
        const recipe = `ghl ${action.recipe}`;
        ctx.out.line(`  ${i + 1}. ${label.padEnd(48)} → ${recipe}`);
      });
    }

    ctx.out.line('  ' + bar());
    ctx.out.line('  Ranked by money at stake (deal value, invoice amount due). Value-unknown items below.');
    ctx.out.line('  Drill into any line with its recipe. Segment/tag on demand: ghl segment.');
    ctx.out.line('  I draft + you approve every outward action. Money stays you, always.\n');
  });

  return 0;
}

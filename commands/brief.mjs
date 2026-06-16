// commands/brief.mjs — Morning brief orchestrator. In-process: calls the 5 sub-collect()s on the
// SAME shared ctx. One http client, one rate budget, zero child-process spawning.
// NEEDS YOU TODAY uses rankActions from lib/prioritize.mjs — same ranker as ghl focus.
// READ-ONLY. Never writes, never sends, never charges.
// Memory: deltas (vs last run, honest baseline) + ack/snooze filtering. All local-only.
import { collect as snapCollect } from './snapshot.mjs';
import { collect as triageCollect } from './triage.mjs';
import { collect as noshowCollect } from './noshow.mjs';
import { collect as pipeCollect } from './pipeline.mjs';
import { collect as arCollect } from './receivables.mjs';
import { rankActions, hasMixedCurrencies } from '../lib/prioritize.mjs';
import { SYM } from '../lib/money.mjs';
import {
  loadLast, recordRun, diff, filterSnoozed,
  snapshotFromMetrics, formatDelta,
} from '../lib/memory.mjs';

export const meta = {
  name: 'brief',
  summary: 'morning brief — numbers + NEEDS YOU TODAY',
  flags: [
    { name: '--days',       type: 'int',  default: 7,     desc: 'snapshot window in days' },
    { name: '--verbose',    type: 'bool', default: false, desc: 'include raw sources blob in JSON output' },
    { name: '--no-memory',  type: 'bool', default: false, desc: 'skip memory read+record (pure stateless run)' },
    { name: '--show-acked', type: 'bool', default: false, desc: 'include snoozed/acked items in output' },
    { name: '--format',     type: 'str',  default: 'pretty', desc: 'human render: pretty (default) | slack | md — affects human output only, never --json' },
  ],
  readOnly: true,
};

// ── helpers ──────────────────────────────────────────────────────────────────
// SYM is imported from lib/money.mjs — the single source so the headline symbol and the
// ranker's `inputs` string can never disagree on the same currency (the old AUD A$/AUD drift).

// resolveCurrency(ctx) → { code, symbol } from the CRM model's location, NEVER hardcoded ₱.
// Falls back: model location → ctx.cfg.currency → neutral (no symbol, no assumed PHP).
// Returns symbol:'' + code:'' when truly unknown so the headline can use a neutral label.
function resolveCurrency(ctx) {
  // Model is loaded by snapshot.collect() during the brief's fan-out (ctx.ensureModel).
  const item = ctx?.model?.entities?.location?.item;
  const fromModel = item?.business?.currency || item?.currency || null;
  const cur = (fromModel || ctx?.cfg?.currency || '').toUpperCase();
  if (!cur) return { code: null, symbol: null };
  return { code: cur, symbol: SYM[cur] || (cur + ' ') };
}

// computeLeaks(actions) → { total, byCur, items, blocked } — KNOWN money leaks only.
// KNOWN = ranked money actions of kind 'invoice' (overdue receivables) + 'never-billed'
// (booked-not-paid with a real est value). Items with money===null are value-UNKNOWN and
// excluded from the headline number (footnoted instead). NEVER fabricates a figure.
function computeLeaks(actions) {
  const items = [];
  const byCur = {};
  for (const a of actions || []) {
    const isLeakKind = a.kind === 'receivables' || a.kind === 'invoice' || a.kind === 'never-billed';
    if (!isLeakKind) continue;
    if (typeof a.money === 'number' && a.money > 0) {
      const cur = (a.cur || 'PHP').toUpperCase();
      byCur[cur] = (byCur[cur] || 0) + a.money;
      items.push(a);
    }
  }
  const currencies = Object.keys(byCur);
  const total = currencies.reduce((s, c) => s + byCur[c], 0);
  return { total, byCur, currencies, items };
}

// Format a money amount with a resolved currency. If currency is unknown, label neutrally
// (the raw number + a "(currency unknown)" note) — never assume ₱.
function fmtMoney(n, currency) {
  const num = Number(n || 0).toLocaleString('en-PH', { maximumFractionDigits: 0 });
  if (currency.symbol) return currency.symbol + num;
  return num + ' (currency unknown)';
}

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
//
// NOTE: never-billed (booked-not-paid) is intentionally NOT a brief lane. Wiring it would
// mean collecting the heavy booked-not-paid source (full transaction pagination) on every
// fast-path brief run AND deriving a real est value — a deliberate feature for a later cut,
// not correctness cleanup. rankActions defaults neverBilled to [] when omitted.
function shapeLanes(sources, now) {
  const { triage, noshow, pipeline: pipe, receivables: ar } = sources;

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

  const noshows = noshow?.__error ? [] : (noshow?.list || []).map(n => {
    // Guard a missing/unparseable n.when — getTime() → NaN would poison rankActions'
    // age sort (NaN comparisons) and render as "NaNd". Unknown age → 0, not NaN.
    const t = new Date(n.when).getTime();
    return {
      contactId: n.contactId,
      name:      n.name || '(unknown)',
      ageDays:   Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 86400000)) : 0,
    };
  });

  return { deals, invoices, threads, noshows };
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
      // delta + snoozedCount stay even in concise mode — agents need them for branching
      ...(rest.delta !== undefined && { delta: rest.delta }),
      ...(rest.snoozedCount !== undefined && { snoozedCount: rest.snoozedCount }),
    };
  }

  return rest;
}

// ── collect: the composable data layer ───────────────────────────────────────
export async function collect(args, ctx) {
  const DAYS = args.days != null ? args.days : 7;
  const noMemory = !!(args['no-memory'] || ctx.noMemory);
  const showAcked = !!(args['show-acked'] || ctx.showAcked);
  const loc = ctx.cfg.loc;
  const memDir = ctx.memoryDir; // injectable for tests; undefined → default

  // ── Memory: load last run BEFORE collecting (so we can diff after) ────────
  // HONESTY: null → firstRun. Never treat as "no change".
  const lastRun = noMemory ? null : loadLast(loc, memDir);

  // Fan-out all 5 sub-collects in parallel on the same ctx.
  // Each uses ctx.cfg.loc / ctx.http / ctx.now — no creds duplication.
  const [snap, triage, noshow, pipe, ar] = await Promise.all([
    safe('snapshot',   () => snapCollect({ days: DAYS }, ctx), ctx),
    safe('triage',     () => triageCollect({ days: 30, top: 100 }, ctx), ctx),
    safe('noshow',     () => noshowCollect({ days: 30, top: 100 }, ctx), ctx),
    safe('pipeline',   () => pipeCollect({ 'stuck-days': 7, top: 100 }, ctx), ctx),
    safe('receivables',() => arCollect({ top: 100 }, ctx), ctx),
  ]);

  const resolvedLoc = snap.location || triage.location || loc;

  // Build the prioritised action list using rankActions (same ranker as ghl focus).
  // Additive: keep count + recipe for backward compat; add money + age fields.
  const lanes = shapeLanes({ triage, noshow, pipeline: pipe, receivables: ar }, ctx.now);
  const { ranked, unknownValue } = rankActions(lanes);

  // Build the actions array: ranked items first (money-ordered), then unknownValue items.
  // Keep backward-compat fields (count, kind, recipe) — add money + age.
  const allActions = [];
  for (const item of ranked) {
    const recipeMap = { deal: 'pipeline', invoice: 'receivables', 'never-billed': 'booked-not-paid' };
    allActions.push({
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
    allActions.push({
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

  // ── Memory: compute delta vs last run ──────────────────────────────────────
  let delta = null;
  if (!noMemory) {
    const currSnapshot = snapshotFromMetrics(snap?.metrics);
    delta = diff(lastRun, currSnapshot, allActions, ctx.now);
    // Record new baseline AFTER computing diff (so diff sees the OLD baseline)
    try {
      recordRun(resolvedLoc, { snapshot: currSnapshot, actions: allActions }, ctx.now, memDir);
    } catch { /* non-fatal — never crash brief for a memory write failure */ }
  }

  // ── Ack/snooze: filter out snoozed items unless --show-acked ──────────────
  let actions = allActions;
  let snoozedCount = 0;
  if (!noMemory && !showAcked) {
    const filtered = filterSnoozed(resolvedLoc, allActions, ctx.now, memDir);
    actions = filtered.visible;
    snoozedCount = filtered.snoozedCount;
  }

  const base = {
    location: resolvedLoc,
    days: DAYS,
    snapshot: snap,
    actions,
    ...(snoozedCount > 0 && { snoozedCount }),
    ...(delta !== null && { delta }),
  };

  // sources is always computed (TTY render reads _sources below).
  // Only included in the returned data when --verbose is passed.
  const fullSources = { triage, noshow, pipeline: pipe, receivables: ar };
  return args.verbose
    ? { ...base, sources: fullSources }
    : { ...base, _sources: fullSources }; // _sources = internal, stripped before emit
}

// ── share-worthy render model — built once, consumed by every --format ────────
// Pure derivation from `data` + `sources` + resolved currency. No I/O. No fabrication:
// the headline number sums ONLY known money leaks; blocked/unknown sources are footnoted.
function buildRenderModel(data, sources, ctx) {
  const currency = resolveCurrency(ctx);
  const leaks = computeLeaks(data.actions);
  const { triage, noshow, pipeline: pipe, receivables: ar } = sources;

  // Footnotes: money sources that are blocked/unknown and therefore EXCLUDED from the headline.
  const footnotes = [];
  const snap = data.snapshot;
  if (ar?.__error) footnotes.push(`receivables blocked (${ar.__error}) — overdue $ not counted`);
  if (snap?.__error) footnotes.push(`snapshot blocked (${snap.__error})`);
  // A degraded source that returned an EMPTY list (e.g. a 403 the sub-collect swallowed into [])
  // means a money source may be silently excluded. Surface it — never let a blocked source
  // masquerade as "no leaks". (ctx.out.degraded is set by the sub-collect warn path.)
  if (ctx?.out?.degraded && !ar?.__error && !snap?.__error) {
    footnotes.push('a data source was degraded — some money may be excluded (run `sizmo doctor`)');
  }
  // value-unknown leak-class actions (invoices with no balance shown) — excluded from the
  // headline total honestly. (never-billed is not a brief lane — see shapeLanes note.)
  const unknownLeaks = (data.actions || []).filter(
    a => a.kind === 'invoice' && a.money == null
  ).length;
  if (unknownLeaks > 0) footnotes.push(`${unknownLeaks} leak(s) with unknown value — not in the total`);
  // mixed currency caveat — raw-number sum across currencies is not meaningful
  if (leaks.currencies.length > 1) footnotes.push(`mixed currencies (${leaks.currencies.join(', ')}) — summed as raw numbers`);

  const N = (data.actions || []).length;

  // Headline: "<sym>X found · N need you today" — honest when zero leaks.
  // The headline currency MUST match the summed amount's REAL currency — never the model's.
  // computeLeaks buckets every amount under its own a.cur, so leaks.currencies holds the
  // currencies actually present. Single currency → use it (symbol can never mismatch the sum).
  // Mixed → neutral symbol (the raw cross-currency sum is footnoted as not-one-currency, so a
  // single symbol would lie). Zero leaks → no number shown, model currency is moot.
  const headlineCur = leaks.currencies.length === 1
    ? { code: leaks.currencies[0], symbol: SYM[leaks.currencies[0]] || (leaks.currencies[0] + ' ') }
    : leaks.currencies.length > 1
      ? { code: null, symbol: null }
      : currency;
  let headline;
  if (leaks.total > 0) {
    headline = `${fmtMoney(leaks.total, headlineCur)} found · ${N} need you today`;
  } else {
    headline = `No leaks found · ${N} need you today`;
  }

  // Money-leak line items (the itemized known leaks)
  const moneyLeakLines = leaks.items.map(a => {
    const who = a.name || a.contact || a.kind;
    const cur = { code: a.cur || currency.code, symbol: SYM[(a.cur || currency.code || '').toUpperCase()] || currency.symbol };
    const amt = cur.symbol ? cur.symbol + Number(a.money).toLocaleString('en-PH', { maximumFractionDigits: 0 }) : String(a.money);
    const kindLabel = a.kind === 'never-billed' ? 'never billed' : 'overdue';
    return `${amt} · ${who} · ${kindLabel}${a.age != null ? ` · ${a.age}d` : ''}`;
  });

  return { currency, leaks, headline, moneyLeakLines, footnotes, N, snap, sources };
}

// ── format renderers — human only; none touch ctx.out.data() ─────────────────
function renderPretty(rm, data, DAYS, ctx) {
  const W = 64;
  const bar = (ch = '─') => ch.repeat(W);
  const pad = (s) => { const str = String(s); return str.length >= W ? str.slice(0, W) : str + ' '.repeat(W - str.length); };
  const today = new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Manila', weekday: 'long', month: 'short', day: 'numeric' });

  ctx.out.line('\n╔' + bar('═') + '╗');
  ctx.out.line('║' + pad('  ' + rm.headline) + '║');
  ctx.out.line('╚' + bar('═') + '╝');
  ctx.out.line('  ' + today + '  ·  loc ' + data.location + '  ·  read-only');

  if (data.delta) {
    const deltaLine = formatDelta(data.delta);
    if (deltaLine) ctx.out.line('\n  ' + deltaLine);
  }

  // Money leaks
  ctx.out.line('\n  Money leaks');
  ctx.out.line('  ' + bar());
  if (!rm.moneyLeakLines.length) {
    ctx.out.line('  None known. ✅');
  } else {
    rm.moneyLeakLines.forEach((l, i) => ctx.out.line(`  ${i + 1}. ${l}`));
  }
  for (const fn of rm.footnotes) ctx.out.line(`  · ${fn}`);

  // Needs you today
  ctx.out.line('\n  Needs you today');
  ctx.out.line('  ' + bar());
  const actions = data.actions || [];
  if (!actions.length) {
    ctx.out.line('  All clear — nobody waiting, nothing stuck, nothing owed. ✅');
  } else {
    actions.forEach((action, i) => {
      const label = action.inputs || action.name || action.kind;
      ctx.out.line(`  ${i + 1}. ${String(label).padEnd(48)} → ghl ${action.recipe}`);
    });
  }

  // vs yesterday (delta repeated compactly only if present and not first run)
  if (data.delta && !data.delta.firstRun) {
    ctx.out.line('\n  vs yesterday');
    ctx.out.line('  ' + bar());
    ctx.out.line('  ' + (formatDelta(data.delta) || 'no change'));
  }

  if (data.snoozedCount > 0) {
    ctx.out.line(`\n  ${data.snoozedCount} snoozed (sizmo ack --list · --show-acked to reveal)`);
  }

  ctx.out.line('  ' + bar());
  ctx.out.line(`  sizmo brief · ${data.profileName || data.location} · ${today}`);
  ctx.out.line('');
}

function renderSlack(rm, data, DAYS, ctx) {
  const today = new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Manila', weekday: 'long', month: 'short', day: 'numeric' });
  const actions = data.actions || [];
  ctx.out.line(`*${rm.headline}*`);
  ctx.out.line('');
  ctx.out.line('*Money leaks*');
  if (!rm.moneyLeakLines.length) ctx.out.line('• none known :white_check_mark:');
  else for (const l of rm.moneyLeakLines) ctx.out.line(`• ${l}`);
  for (const fn of rm.footnotes) ctx.out.line(`_${fn}_`);
  ctx.out.line('');
  ctx.out.line('*Needs you today*');
  if (!actions.length) ctx.out.line('• all clear :white_check_mark:');
  else actions.forEach(a => ctx.out.line(`• ${a.inputs || a.name || a.kind}  →  \`ghl ${a.recipe}\``));
  if (data.delta && !data.delta.firstRun) {
    ctx.out.line('');
    ctx.out.line('*vs yesterday*');
    ctx.out.line(`_${formatDelta(data.delta) || 'no change'}_`);
  }
  ctx.out.line('');
  ctx.out.line(`_sizmo brief · ${data.profileName || data.location} · ${today}_`);
}

function renderMd(rm, data, DAYS, ctx) {
  const today = new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Manila', weekday: 'long', month: 'short', day: 'numeric' });
  const actions = data.actions || [];
  ctx.out.line(`# ${rm.headline}`);
  ctx.out.line('');
  ctx.out.line('## Money leaks');
  ctx.out.line('');
  if (!rm.moneyLeakLines.length) ctx.out.line('- None known.');
  else for (const l of rm.moneyLeakLines) ctx.out.line(`- ${l}`);
  for (const fn of rm.footnotes) ctx.out.line(`- _${fn}_`);
  ctx.out.line('');
  ctx.out.line('## Needs you today');
  ctx.out.line('');
  if (!actions.length) ctx.out.line('- All clear.');
  else actions.forEach(a => ctx.out.line(`- ${a.inputs || a.name || a.kind} → \`ghl ${a.recipe}\``));
  if (data.delta && !data.delta.firstRun) {
    ctx.out.line('');
    ctx.out.line('## vs yesterday');
    ctx.out.line('');
    ctx.out.line(`${formatDelta(data.delta) || 'no change'}`);
  }
  ctx.out.line('');
  ctx.out.line('---');
  ctx.out.line(`sizmo brief · ${data.profileName || data.location} · ${today}`);
}

// ── run: bimodal output (JSON envelope OR human share-block) ─────────────────
export async function run(args, ctx) {
  const DAYS = args.days != null ? args.days : 7;
  const data = await collect(args, ctx);

  // Machine mode: emit lean or verbose data via buildEmitData — UNCHANGED (golden-sacred).
  // --concise (global ctx.concise) trims to numbers + action counts only.
  ctx.out.data(buildEmitData(data, ctx));

  // Human render: --format chooses the surface; never affects the --json envelope above.
  const sources = data.sources || data._sources || {};
  // expose profile name to the render footer (added to data object, NOT emitted — emit happened above)
  data.profileName = ctx?.cfg?.profileName ?? null;
  ctx.out.card(() => {
    const rm = buildRenderModel(data, sources, ctx);
    const fmt = (args.format || 'pretty').toLowerCase();
    if (fmt === 'slack') renderSlack(rm, data, DAYS, ctx);
    else if (fmt === 'md' || fmt === 'markdown') renderMd(rm, data, DAYS, ctx);
    else renderPretty(rm, data, DAYS, ctx);
  });

  return 0;
}

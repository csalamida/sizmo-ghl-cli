// commands/crm.mjs — query surface for the local CRM model.
// Overview counts + per-entity lists. Honest staleness on every read.
// Missing model → auto-sync once (first run). Stale → serve + banner, no auto-sync.
// READ-ONLY. No writes to GoHighLevel.
import { loadModel, syncModel, isStale, ageMs, ENTITY_SPECS, DEFAULT_MODEL_DIR } from '../lib/model.mjs';

export const meta = {
  name: 'crm',
  summary: 'Query the local CRM model — counts, lists, staleness',
  flags: [
    { name: '--all', type: 'bool', desc: 'show all items (overrides high-cardinality truncation)' },
  ],
  readOnly: true,
};

const TRUNCATE_ABOVE = 20; // default max items for high-cardinality entities (tags, fields)

// Alias map for subcommands
const ALIAS = { fields: 'customFields' };
const VALID_SUBS = ['pipelines', 'calendars', 'tags', 'fields', 'users', 'location'];

export async function run(args, ctx) {
  const dir = ctx._modelDir ?? DEFAULT_MODEL_DIR;
  const loc = ctx.cfg.loc;
  const nowMs = typeof ctx.now === 'function' ? ctx.now() : ctx.now;
  const showAll = !!(args.all || args['--all']);

  // Sub-command from positional args
  const sub = args._?.[0] || null;

  // 1. Load model (auto-sync if missing)
  let model = loadModel(loc, dir);
  if (!model) {
    // First run — auto-sync. syncModel throws if cold+offline.
    ctx.out.warn('model not found — running first-time sync...');
    try {
      model = await syncModel({ http: ctx.http, loc, dir, now: typeof ctx.now === 'function' ? ctx.now : () => ctx.now });
    } catch (e) {
      if (e.offline) {
        ctx.out.warn("⚠ OFFLINE — can't reach GoHighLevel — check your connection; run `sizmo sync` when online");
        return 1;
      }
      throw e;
    }
  }

  // 2. Build overall model meta
  const modelAgeMs = nowMs - model.syncedAt;
  // Determine overall staleness: any entity past its TTL
  const specMap = Object.fromEntries(ENTITY_SPECS.map(s => [s.name, s]));
  let anyStale = false;
  for (const [name, ent] of Object.entries(model.entities)) {
    if (!ent.blocked && !ent.networkError && specMap[name] && isStale(ent, nowMs, specMap[name].ttlMs)) {
      anyStale = true;
    }
  }

  // Determine offline: model was last sync'd while offline, OR the model itself has the offline flag.
  // Also detect if a model exists but a refresh just failed (model.offline = true from the last sync).
  const offline = !!(model.offline);
  const meta = { source: 'cache', syncedAt: model.syncedAt, ageMs: modelAgeMs, stale: anyStale, offline };

  // 3. Warn if offline (showing stale/cached data) or just stale
  if (offline) {
    const cacheAge = fmtAge(modelAgeMs);
    ctx.out.warn(`⚠ OFFLINE — showing cache from ${new Date(model.syncedAt).toISOString()} (${cacheAge} old) — run \`sizmo sync\` when online`);
  } else if (anyStale) {
    ctx.out.warn(`⚠ model is stale (${fmtAge(modelAgeMs)} old) — run sizmo sync to refresh`);
  }

  // 4. Dispatch sub-command or overview
  if (!sub) {
    return overview(model, meta, nowMs, specMap, ctx);
  }

  const resolved = ALIAS[sub] ?? sub;
  if (!VALID_SUBS.includes(sub) && !VALID_SUBS.includes(resolved)) {
    ctx.out.warn(`unknown crm subcommand "${sub}" — valid: ${VALID_SUBS.join(', ')}`);
    return 1;
  }

  if (resolved === 'location') return locationCmd(model, meta, ctx);
  return entityList(resolved, model, meta, nowMs, specMap, showAll, ctx);
}

// ── overview ──────────────────────────────────────────────────────────────────

function overview(model, modelMeta, nowMs, specMap, ctx) {
  const counts = {};
  const blocked = {};
  const networkErrors = {};
  for (const spec of ENTITY_SPECS) {
    const ent = model.entities[spec.name];
    if (!ent) { counts[spec.name] = 0; continue; }
    if (ent.networkError) {
      counts[spec.name] = null;
      networkErrors[spec.name] = ent.error ?? 'network error';
    } else if (ent.blocked) {
      counts[spec.name] = null;
      blocked[spec.name] = ent.scope;
    } else if (spec.name === 'location') {
      counts[spec.name] = ent.item ? 1 : 0;
    } else {
      counts[spec.name] = Array.isArray(ent.items) ? ent.items.length : 0;
    }
  }

  // Build human-friendly output structure
  const data = {
    pipelines: counts.pipelines,
    calendars: counts.calendars,
    tags: counts.tags,
    customFields: counts.customFields,
    users: counts.users,
    location: counts.location,
    _meta: modelMeta,
  };
  // Add blocked/networkError flags so agents can branch
  for (const [name, scope] of Object.entries(blocked)) {
    data[`${name}Blocked`] = true;
    data[`${name}Scope`] = scope;
  }
  for (const [name] of Object.entries(networkErrors)) {
    data[`${name}NetworkError`] = true;
  }

  ctx.out.data(data);

  ctx.out.card(() => {
    const age = fmtAge(modelMeta.ageMs);
    const staleNote = modelMeta.offline ? ` ⚠ OFFLINE` : (modelMeta.stale ? ` ⚠ STALE — run sizmo sync` : '');
    ctx.out.line(`\n  CRM MODEL  ·  loc ${model.locationId}  ·  synced ${age}${staleNote}`);
    ctx.out.line('  ' + '─'.repeat(50));
    for (const spec of ENTITY_SPECS) {
      if (spec.name === 'location') continue; // shown separately
      const ent = model.entities[spec.name];
      if (!ent) { ctx.out.line(`  ${spec.name.padEnd(16)} 0`); continue; }
      if (ent.networkError) {
        ctx.out.line(`  ${spec.name.padEnd(16)} ⚠ couldn't reach GHL`);
      } else if (ent.blocked) {
        ctx.out.line(`  ${spec.name.padEnd(16)} ✖ needs ${ent.scope}`);
      } else {
        const count = Array.isArray(ent.items) ? ent.items.length : 0;
        const entAge = ageMs(ent, nowMs);
        const entStale = isStale(ent, nowMs, specMap[spec.name]?.ttlMs ?? Infinity);
        const ageNote = entAge !== null ? ` · ${fmtAge(entAge)}${entStale ? ' ⚠' : ''}` : '';
        ctx.out.line(`  ${spec.name.padEnd(16)} ${count}${ageNote}`);
      }
    }
    // Location line
    const locEnt = model.entities.location;
    if (locEnt && !locEnt.blocked && locEnt.item) {
      const loc = locEnt.item;
      const cur = loc.business?.currency || loc.currency || 'PHP';
      ctx.out.line(`  ${'location'.padEnd(16)} ${loc.name || model.locationId}  ·  ${cur}  ·  ${loc.timezone || ''}`);
    }
    ctx.out.line('  ' + '─'.repeat(50));
    ctx.out.line('  sizmo crm <pipelines|calendars|tags|fields|users|location>  for details\n');
  });

  return 0;
}

// ── entity list ───────────────────────────────────────────────────────────────

function entityList(entityName, model, modelMeta, nowMs, specMap, showAll, ctx) {
  const ent = model.entities[entityName];
  const spec = specMap[entityName];

  if (ent?.networkError) {
    ctx.out.warn(`⚠ ${entityName} — couldn't reach GHL during last sync`);
    ctx.out.data({ entity: entityName, networkError: true, _meta: modelMeta });
    return 1;
  }

  if (!ent || ent.blocked) {
    const scope = ent?.scope ?? 'unknown';
    ctx.out.warn(`✖ ${entityName} blocked — needs ${scope}`);
    ctx.out.data({ entity: entityName, blocked: true, scope, _meta: modelMeta });
    return 1;
  }

  const items = Array.isArray(ent.items) ? ent.items : [];
  const entAge = ageMs(ent, nowMs);
  const stale = spec ? isStale(ent, nowMs, spec.ttlMs) : false;
  const entMeta = { ...modelMeta, entityFetchedAt: ent.fetchedAt, entityAgeMs: entAge, entityStale: stale };

  // High-cardinality truncation (tags, customFields)
  const highCard = entityName === 'tags' || entityName === 'customFields';
  const shown = (highCard && !showAll) ? items.slice(0, TRUNCATE_ABOVE) : items;
  const truncated = shown.length < items.length;

  ctx.out.data({ entity: entityName, items: shown, total: items.length, truncated, _meta: entMeta });

  ctx.out.card(() => {
    const ageNote = entAge !== null ? `synced ${fmtAge(entAge)} ago` : '';
    const staleNote = stale ? ' ⚠ STALE' : '';
    ctx.out.line(`\n  ${entityName.toUpperCase()}  ·  ${items.length} item(s)  ·  ${ageNote}${staleNote}`);
    ctx.out.line('  ' + '─'.repeat(50));
    if (entityName === 'pipelines') {
      for (const pl of shown) {
        ctx.out.line(`  ${(pl.name || pl.id).slice(0, 40)}`);
        for (const s of (pl.stages || [])) {
          ctx.out.line(`    [${String(s.position ?? '').padStart(2)}] ${(s.name || s.id).slice(0, 36)}`);
        }
      }
    } else if (entityName === 'users') {
      for (const u of shown) {
        const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.name || u.id;
        ctx.out.line(`  ${name.slice(0, 30).padEnd(30)} ${(u.email || '').slice(0, 36)}`);
      }
    } else {
      for (const item of shown) {
        const label = item.name || item.id;
        const extra = item.fieldKey ? `  key: ${item.fieldKey}` : (item.calendarType ? `  ${item.calendarType}` : '');
        ctx.out.line(`  ${label.slice(0, 40)}${extra}`);
      }
    }
    if (truncated) ctx.out.line(`  … ${items.length - shown.length} more — --all to show all`);
    ctx.out.line('  ' + '─'.repeat(50) + '\n');
  });

  return 0;
}

// ── location subcommand ───────────────────────────────────────────────────────

function locationCmd(model, modelMeta, ctx) {
  const ent = model.entities.location;
  if (!ent || ent.blocked) {
    const scope = ent?.scope ?? 'locations.readonly';
    ctx.out.warn(`✖ location blocked — needs ${scope}`);
    ctx.out.data({ blocked: true, scope, _meta: modelMeta });
    return 1;
  }
  const item = ent.item ?? {};
  ctx.out.data({ item, location: item, _meta: modelMeta });
  ctx.out.card(() => {
    ctx.out.line(`\n  LOCATION  ·  ${item.name || model.locationId}`);
    ctx.out.line('  ' + '─'.repeat(40));
    ctx.out.line(`  id        ${item.id || model.locationId}`);
    ctx.out.line(`  timezone  ${item.timezone || '—'}`);
    ctx.out.line(`  currency  ${item.business?.currency || item.currency || '—'}`);
    ctx.out.line(`  country   ${item.country || '—'}`);
    ctx.out.line('  ' + '─'.repeat(40) + '\n');
  });
  return 0;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function fmtAge(ms) {
  if (ms == null || ms < 0) return '?';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

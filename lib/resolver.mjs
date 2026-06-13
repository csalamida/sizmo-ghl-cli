// lib/resolver.mjs — id→name maps from the CRM model. Never fabricates a name.
// makeResolver(model, {now}) → resolver with .resolve(kind, id) and .label(kind, id).
//
// resolve(kind, id) → { name: string|null, status: 'hit'|'miss'|'stale', pipelineId?, pipelineName? }
//   hit   — found in model, entity is fresh
//   stale — found in model, but entity is past its TTL
//   miss  — not found (never fabricated; name=null)
//
// label(kind, id) → string suitable for human display:
//   hit/stale → name (stale callers should add age note separately)
//   miss      → '<unknown:<id> — run sizmo sync>'
//
// Kind mapping:
//   'pipeline'    → pipelines entity (id→name)
//   'stage'       → stages nested in pipelines (id→{name,pipelineId,pipelineName,position})
//   'calendar'    → calendars entity
//   'tag'         → tags entity
//   'customField' → customFields entity
//   'user'        → users entity
import { isStale, ENTITY_SPECS } from './model.mjs';

const TTL_MAP = Object.fromEntries(ENTITY_SPECS.map(s => [s.name, s.ttlMs]));

/**
 * makeResolver — build maps from a model blob; return resolver.
 * @param {object|null} model   the loaded model blob (or null if missing)
 * @param {object} opts
 * @param {Function} opts.now   injectable clock () => ms
 */
export function makeResolver(model, { now = Date.now } = {}) {
  // Materialized maps — built once on construction
  const maps = buildMaps(model);

  function resolveKind(kind, id) {
    const { entityName, map } = kindMeta(kind, maps);
    if (!map) return { name: null, status: 'miss' };

    const entry = map.get(id);
    if (!entry) return { name: null, status: 'miss' };

    // Check staleness of the source entity
    const entity = model?.entities?.[entityName];
    const ttl = TTL_MAP[entityName];
    const stale = entity && ttl ? isStale(entity, now(), ttl) : false;

    const result = { name: entry.name, status: stale ? 'stale' : 'hit' };
    if (entry.pipelineId !== undefined) result.pipelineId = entry.pipelineId;
    if (entry.pipelineName !== undefined) result.pipelineName = entry.pipelineName;
    if (entry.position !== undefined) result.position = entry.position;
    return result;
  }

  return {
    /**
     * resolve(kind, id) → { name, status, ...extras }
     * Never throws; miss returns { name: null, status: 'miss' }.
     */
    resolve(kind, id) {
      try { return resolveKind(kind, id); }
      catch { return { name: null, status: 'miss' }; }
    },

    /**
     * label(kind, id) → human string.
     * hit/stale → name; miss → '<unknown:<id> — run sizmo sync>'
     */
    label(kind, id) {
      const r = resolveKind(kind, id);
      if (r.name !== null) return r.name;
      return `<unknown:${id} — run sizmo sync>`;
    },
  };
}

// ── internal ──────────────────────────────────────────────────────────────────

function buildMaps(model) {
  const empty = () => new Map();
  if (!model || !model.entities) {
    return { pipeline: empty(), stage: empty(), calendar: empty(), tag: empty(), customField: empty(), user: empty() };
  }
  const e = model.entities;

  // pipelines + stages
  const pipelineMap = new Map();
  const stageMap = new Map();
  if (e.pipelines && !e.pipelines.blocked && Array.isArray(e.pipelines.items)) {
    for (const pl of e.pipelines.items) {
      pipelineMap.set(pl.id, { name: pl.name });
      for (const s of (pl.stages || [])) {
        stageMap.set(s.id, { name: s.name, pipelineId: pl.id, pipelineName: pl.name, position: s.position ?? 0 });
      }
    }
  }

  // calendars
  const calMap = new Map();
  if (e.calendars && !e.calendars.blocked && Array.isArray(e.calendars.items)) {
    for (const c of e.calendars.items) calMap.set(c.id, { name: c.name });
  }

  // tags
  const tagMap = new Map();
  if (e.tags && !e.tags.blocked && Array.isArray(e.tags.items)) {
    for (const t of e.tags.items) tagMap.set(t.id, { name: t.name });
  }

  // customFields
  const fieldMap = new Map();
  if (e.customFields && !e.customFields.blocked && Array.isArray(e.customFields.items)) {
    for (const f of e.customFields.items) fieldMap.set(f.id, { name: f.name, key: f.fieldKey });
  }

  // users
  const userMap = new Map();
  if (e.users && !e.users.blocked && Array.isArray(e.users.items)) {
    for (const u of e.users.items) {
      const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.name || u.email || u.id;
      userMap.set(u.id, { name });
    }
  }

  return { pipeline: pipelineMap, stage: stageMap, calendar: calMap, tag: tagMap, customField: fieldMap, user: userMap };
}

// Which entity-name and map corresponds to each public kind string
function kindMeta(kind, maps) {
  switch (kind) {
    case 'pipeline':    return { entityName: 'pipelines',    map: maps.pipeline };
    case 'stage':       return { entityName: 'pipelines',    map: maps.stage };
    case 'calendar':    return { entityName: 'calendars',    map: maps.calendar };
    case 'tag':         return { entityName: 'tags',         map: maps.tag };
    case 'customField': return { entityName: 'customFields', map: maps.customField };
    case 'user':        return { entityName: 'users',        map: maps.user };
    default:            return { entityName: null,           map: null };
  }
}

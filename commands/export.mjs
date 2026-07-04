// commands/export.mjs — dump a GHL location's structure to one deterministic, diffable document.
// READ-ONLY. The foundation of the location-as-file wedge (Phase 1): export → diff → (later) apply.
//
// Design invariants:
//   · DETERMINISTIC — sorted resources + recursively sorted keys + NO timestamps, so two exports of
//     an unchanged location are byte-identical. That property is what makes `sizmo diff` meaningful.
//   · HONEST — a blocked/unreachable resource is written as { blocked: <scope> } / { unavailable },
//     never as an empty list. The degrade signal rides INSIDE the file (like the ndjson meta line),
//     so a downstream `apply` can never mistake "blocked" for "empty".
//   · SECRET-FREE — ids/names/structure only. No PIT, no integration credentials (they aren't in
//     the API anyway). Users carry id/name/email, nothing more.
import { writeFileSync } from 'node:fs';
import { GhlError, EXIT } from '../lib/errors.mjs';

export const meta = {
  name: 'export',
  summary: 'dump the location structure to a deterministic, diffable document (location-as-file)',
  flags: [
    { name: '--out', type: 'string', desc: 'write the document to a file (default: print to stdout)' },
  ],
  readOnly: true,
};

export const SPEC_VERSION = 1;

// recursively sort object keys so serialization is stable; arrays are pre-sorted by the builder.
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}
export function canonicalJSON(doc) { return JSON.stringify(sortKeys(doc), null, 2); }

const byId = (a, b) => String(a.id ?? '').localeCompare(String(b.id ?? ''));
const byName = (a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''));

// entityGroup — map a model entity to either a sorted clean array, or a { blocked } / { unavailable }
// marker. Pushes a warning + flips degraded when a resource can't be read.
function entityGroup(ent, scope, mapFn, sort, warnings) {
  if (!ent) { warnings.push(`${scope}: not synced (run sizmo sync)`); return { unavailable: 'not synced' }; }
  if (ent.networkError) { warnings.push(`${scope}: could not reach GoHighLevel`); return { unavailable: 'network' }; }
  if (ent.blocked) {
    // httpCode present = a real (non-401/403) API error reached the PIT — not a missing scope,
    // even though the model marks it "blocked" the same way.
    if (ent.httpCode) { warnings.push(`${scope}: API error ${ent.httpCode} (not a scope issue)`); return { blocked: ent.scope || scope, httpCode: ent.httpCode }; }
    warnings.push(`${scope}: blocked (missing scope)`);
    return { blocked: ent.scope || scope };
  }
  return (ent.items || []).map(mapFn).sort(sort);
}

// buildExportDoc — assemble the canonical location document from the model + a live custom-values fetch.
// Exported for tests. Returns { doc, degraded, warnings }.
export async function buildExportDoc(ctx) {
  const loc = ctx.cfg.loc;
  const model = ctx.ensureModel ? await ctx.ensureModel() : null;
  const E = model?.entities || {};
  const warnings = [];

  const locItem = E.location?.item || {};
  const location = {
    id: locItem.id || loc,
    name: locItem.name || null,
    timezone: locItem.timezone || null,
    currency: (locItem.business?.currency || locItem.currency || null),
    country: locItem.country || null,
  };
  if (E.location?.blocked) {
    warnings.push(E.location.httpCode
      ? `locations.readonly: API error ${E.location.httpCode} (not a scope issue)`
      : 'locations.readonly: blocked (missing scope)');
  }

  const pipelines = entityGroup(E.pipelines, 'opportunities.readonly',
    p => ({ id: p.id, name: p.name ?? null,
            stages: (p.stages || []).map(s => ({ id: s.id, name: s.name ?? null, position: s.position ?? null }))
                      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || byId(a, b)) }),
    byId, warnings);

  const calendars = entityGroup(E.calendars, 'calendars.readonly',
    c => ({ id: c.id, name: c.name ?? null }), byId, warnings);

  const customFields = entityGroup(E.customFields, 'locations/customFields.readonly',
    f => ({ id: f.id, name: f.name ?? null, dataType: f.dataType ?? null, fieldKey: f.fieldKey ?? null }), byId, warnings);

  const tags = entityGroup(E.tags, 'locations/tags.readonly',
    t => ({ id: t.id ?? null, name: t.name ?? null }), byName, warnings);

  const users = entityGroup(E.users, 'users.readonly',
    u => ({ id: u.id, name: (u.name || [u.firstName, u.lastName].filter(Boolean).join(' ') || null),
            email: u.email ?? null }), byId, warnings);

  // Custom VALUES are not part of the synced model (only 6 entities) — fetch live.
  let customValues;
  const cv = await ctx.http.get(`/locations/${encodeURIComponent(loc)}/customValues`);
  if (cv.code === 401 || cv.code === 403) { warnings.push('locations/customValues.readonly: blocked (missing scope)'); customValues = { blocked: 'locations/customValues.readonly' }; }
  else if (cv.code === 0) { warnings.push('locations/customValues.readonly: could not reach GoHighLevel'); customValues = { unavailable: 'network' }; }
  else if (!cv.ok) { warnings.push(`locations/customValues.readonly: HTTP ${cv.code}`); customValues = { unavailable: `http ${cv.code}` }; }
  else { customValues = (cv.j?.customValues || []).map(v => ({ id: v.id, name: v.name ?? null, value: v.value ?? null })).sort(byId); }

  const degraded = warnings.length > 0;
  const doc = {
    specVersion: SPEC_VERSION,
    location,
    pipelines, calendars, customFields, customValues, tags, users,
    degraded,
    warnings: warnings.sort(),
  };
  return { doc, degraded, warnings };
}

const groupCount = (g) => Array.isArray(g) ? `${g.length}` : (g.blocked ? '✖ blocked' : '⚠ unavailable');

export async function run(args, ctx) {
  const { doc, degraded, warnings } = await buildExportDoc(ctx);
  for (const w of warnings) ctx.out.warn(w, { degraded: true });

  ctx.out.data(doc); // agent path: --json emits the standard envelope around the doc

  const serialized = canonicalJSON(doc);
  if (args.out) {
    try { writeFileSync(args.out, serialized + '\n'); }
    catch (e) { throw new GhlError(`export: could not write ${args.out} — ${e.message}`, EXIT.API); }
    // summary to the human; the file holds the canonical doc
    ctx.out.card(() => {
      ctx.out.line(`\n  EXPORT · loc ${doc.location.id}${degraded ? '  ·  ⚠ partial (see warnings)' : ''}`);
      ctx.out.line('  ' + '─'.repeat(52));
      ctx.out.line(`  pipelines     ${groupCount(doc.pipelines)}`);
      ctx.out.line(`  calendars     ${groupCount(doc.calendars)}`);
      ctx.out.line(`  customFields  ${groupCount(doc.customFields)}`);
      ctx.out.line(`  customValues  ${groupCount(doc.customValues)}`);
      ctx.out.line(`  tags          ${groupCount(doc.tags)}`);
      ctx.out.line(`  users         ${groupCount(doc.users)}`);
      ctx.out.line('  ' + '─'.repeat(52));
      ctx.out.line(`  → wrote ${serialized.length} bytes to ${args.out}${degraded ? '  (partial — a source was blocked; not safe to apply as complete)' : ''}\n`);
    });
  } else {
    // no --out, human mode: print the canonical document to stdout (pipeable: sizmo export > loc.json)
    ctx.out.card(() => ctx.out.line(serialized));
  }
  return EXIT.OK;
}

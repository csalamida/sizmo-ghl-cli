// commands/diff.mjs — diff a location export against LIVE, or against another export.
// READ-ONLY. Phase 2 of location-as-file. Answers the ecosystem's loudest fear ("what changed / what
// would this push break") — a thing snapshots structurally cannot do.
//   sizmo diff <file>          → <file> vs the live location
//   sizmo diff <a> <b>         → export A vs export B
import { readFileSync } from 'node:fs';
import { GhlError, EXIT } from '../lib/errors.mjs';
import { buildExportDoc, canonicalJSON } from './export.mjs';

export const meta = {
  name: 'diff',
  summary: 'diff a location export against live (or against another export) — see exactly what changed',
  flags: [],
  readOnly: true,
};

const GROUPS = ['pipelines', 'calendars', 'customFields', 'customValues', 'tags', 'users'];
const GROUP_LABELS = { pipelines: 'Pipelines', calendars: 'Calendars', customFields: 'Custom Fields', customValues: 'Custom Values', tags: 'Tags', users: 'Users' };
const keyOf = (item) => item.id ?? item.name ?? JSON.stringify(item);

function fieldDiffs(a = {}, b = {}) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const out = [];
  for (const k of keys) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push({ field: k, from: a[k] ?? null, to: b[k] ?? null });
  }
  return out;
}

function diffGroup(a, b) {
  // Either side a marker ({blocked}/{unavailable}) → not comparable (never guess a delta on unknown data).
  if (!Array.isArray(a) || !Array.isArray(b)) {
    const side = !Array.isArray(a) ? 'A' : 'B';
    const marker = !Array.isArray(a) ? a : b;
    const blockedNote = marker?.httpCode ? `API error ${marker.httpCode} — not a scope issue` : `blocked (${marker?.blocked})`;
    return { comparable: false, reason: `not comparable — ${side} is ${marker?.blocked ? blockedNote : 'unavailable'}` };
  }
  const aMap = new Map(a.map(x => [keyOf(x), x]));
  const bMap = new Map(b.map(x => [keyOf(x), x]));
  const added = [], removed = [], changed = [];
  for (const [k, x] of bMap) if (!aMap.has(k)) added.push({ id: x.id ?? null, name: x.name ?? null });
  for (const [k, x] of aMap) if (!bMap.has(k)) removed.push({ id: x.id ?? null, name: x.name ?? null });
  for (const [k, x] of aMap) {
    if (!bMap.has(k)) continue;
    const y = bMap.get(k);
    if (JSON.stringify(x) !== JSON.stringify(y)) changed.push({ id: x.id ?? null, name: y.name ?? x.name ?? null, fields: fieldDiffs(x, y) });
  }
  return { comparable: true, added, removed, changed };
}

// diffDocs — pure. Two export docs → a structured, deterministic diff. Exported for tests.
// Both sides are run through canonicalJSON first so key ORDER never registers as a change —
// a saved export has recursively-sorted keys, a freshly-built live doc does not. Same data,
// different key order = identical, not "changed".
export function diffDocs(rawA, rawB) {
  const docA = JSON.parse(canonicalJSON(rawA));
  const docB = JSON.parse(canonicalJSON(rawB));
  const groups = {};
  let added = 0, removed = 0, changed = 0, notComparable = 0;
  for (const g of GROUPS) {
    const r = diffGroup(docA[g], docB[g]);
    groups[g] = r;
    if (r.comparable) { added += r.added.length; removed += r.removed.length; changed += r.changed.length; }
    else notComparable++;
  }
  const locationFields = fieldDiffs(docA.location, docB.location);
  if (locationFields.length) changed += 1;
  const summary = { added, removed, changed, notComparable };
  return {
    specVersion: docA.specVersion ?? 1,
    identical: added === 0 && removed === 0 && changed === 0,
    summary,
    location: { fields: locationFields },
    groups,
  };
}

function loadDoc(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (e) { throw new GhlError(`diff: cannot read ${path} — ${e.code === 'ENOENT' ? 'no such file' : e.message}`, EXIT.NOTFOUND); }
  let doc;
  try { doc = JSON.parse(raw); }
  catch { throw new GhlError(`diff: ${path} is not valid JSON — is it a sizmo export?`, EXIT.USAGE); }
  if (doc.specVersion == null) throw new GhlError(`diff: ${path} has no specVersion — not a sizmo export document`, EXIT.USAGE);
  return doc;
}

export async function run(args, ctx) {
  const positionals = (args._ || []).filter(a => a != null);
  const aPath = positionals[0];
  const bPath = positionals[1];
  if (!aPath) throw new GhlError('usage: sizmo diff <file> [file] — <file> vs live, or <a> vs <b>', EXIT.USAGE, 'sizmo diff location.json');

  const docA = loadDoc(aPath);
  let docB, bLabel;
  if (bPath) { docB = loadDoc(bPath); bLabel = bPath; }
  else { docB = (await buildExportDoc(ctx)).doc; bLabel = 'live'; }

  const result = { a: aPath, b: bLabel, ...diffDocs(docA, docB) };
  ctx.out.data(result);

  ctx.out.card(() => {
    const W = 60;
    ctx.out.line(`\n  DIFF · ${aPath}  →  ${bLabel}`);
    ctx.out.line('  ' + '─'.repeat(W));
    if (result.identical) { ctx.out.line('  ✓ identical — no differences.\n'); return; }
    const s = result.summary;
    ctx.out.line(`  ${s.added} added · ${s.removed} removed · ${s.changed} changed${s.notComparable ? ` · ${s.notComparable} not comparable` : ''}`);
    if (result.location.fields.length) {
      ctx.out.line('\n  Location');
      for (const f of result.location.fields) {
        const desc = f.field === 'name' ? `renamed to "${f.to}"` : `${f.field} updated`;
        ctx.out.line(`    ~ ${desc}`);
      }
    }
    for (const g of GROUPS) {
      const r = result.groups[g];
      const label = GROUP_LABELS[g] ?? g;
      if (!r.comparable) { ctx.out.line(`\n  ${label}\n    · ${r.reason}`); continue; }
      if (!r.added.length && !r.removed.length && !r.changed.length) continue;
      ctx.out.line(`\n  ${label}`);
      for (const x of r.added)   ctx.out.line(`    + ${x.name ?? '(unnamed)'}`);
      for (const x of r.removed) ctx.out.line(`    − ${x.name ?? '(unnamed)'}`);
      for (const x of r.changed) {
        const desc = x.fields.map(f => {
          if (f.field === 'name') return 'renamed';
          if (f.field === 'value') return 'value updated';
          if (f.field === 'stages') return 'stages updated';
          return `${f.field} updated`;
        }).join(', ') || 'changed';
        ctx.out.line(`    ~ ${x.name ?? x.id}  —  ${desc}`);
      }
    }
    ctx.out.line('');
  });
  return EXIT.OK;
}

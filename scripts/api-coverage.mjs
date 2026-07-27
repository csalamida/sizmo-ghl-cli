#!/usr/bin/env node
// scripts/api-coverage.mjs — which GoHighLevel operations does sizmo actually reach?
//
// WHY THIS EXISTS: three gaps found in a row (value update, field update, and the appointment /
// contact field gaps before them) were all the same shape — an endpoint the API offers that the
// CLI simply never calls. Finding them one command at a time is O(commands) and rediscovers the
// same shape repeatedly. This diffs the whole surface in one pass.
//
// WHAT IT IS NOT: a to-do list. Most uncovered operations are correctly uncovered — sizmo is built
// for coaches and consultants, so products/inventory/stores/blogs/social have no place in it. The
// report marks a gap as DELIBERATE when it appears in DELIBERATE_OMISSIONS below, with a reason.
// Everything else is UNREVIEWED: it needs a human decision, not automatic implementation.
//
// Run: node scripts/api-coverage.mjs          (writes docs/api-coverage.md)
//      node scripts/api-coverage.mjs --check  (exit 1 if the report is stale — for CI)
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const inventory = JSON.parse(readFileSync(join(REPO, 'docs', 'api-inventory.json'), 'utf8'));

// Operations sizmo intentionally does not implement. Each needs a REASON — an unexplained entry
// here is indistinguishable from a gap someone got tired of looking at.
const DELIBERATE_OMISSIONS = {
  'contacts.bulk-tags':          'bulk write. sizmo\'s delete/write commands are single-target by design — a bulk tag update cannot be previewed meaningfully per contact.',
  'add-an-inbound-message':      'fabricates inbound history. sizmo records what happened, it does not invent it.',
  'add-an-outbound-message':     'logs an external call sizmo did not place. Same reason as inbound.',
  'update-message-status':       'rewrites delivery state sizmo did not observe.',
  'add-message-attachments':     'Custom Call message type only — outside the SMS/email surface sizmo exposes.',
  'create-block-slot':           'calendar availability editing is a UI-shaped task; no CLI demand seen.',
  'edit-block-slot':             'same as create-block-slot.',
  'get-blocked-slots':           'same as create-block-slot.',
  'updateSchedule':              'availability rules are UI-shaped and high-blast; not a CLI surface.',
  'update-service-booking':      'service bookings are a separate product surface from appointments.',
  'update-coupon':               'promotions are e-commerce-shaped, outside the coach/consultant ICP.',
  'record-order-payment':        'order payments belong to the store surface sizmo does not expose.',
  'update-estimate-template':    'estimate templates depend on an estimates surface sizmo has not built.',
  'export-messages-by-location': 'bulk export; `sizmo triage` covers the operational read.',
  'update-opportunity-status':   'REDUNDANT, not missing. PUT /opportunities/{id} accepts `status` directly (verified via describe_operation), and `sizmo opp update --status won|lost|abandoned` already uses it. The dedicated /status route is a convenience alias for the same capability — implementing it would add a second way to do one thing.',
};

// Endpoints sizmo calls, extracted from source rather than maintained by hand — a hand-kept list
// would drift the moment a command changed, which is the bug class this whole file exists for.
function calledEndpoints() {
  const dir = join(REPO, 'commands');
  const out = new Map(); // normalisedPath+method -> Set(commands)
  const unresolved = [];
  for (const file of readdirSync(dir).filter(f => f.endsWith('.mjs'))) {
    const cmd = file.replace('.mjs', '');
    const src = readFileSync(join(dir, file), 'utf8')
      .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n'); // drop comments
    // Two passes, because a literal-only scan is wrong. Several commands build the path into a
    // variable first (`const base = \`/locations/...\`; ctx.http.get(base)`), and a literal-only
    // regex reported `tag`, `send cancel` and `field update` as UNCOVERED — three things that
    // demonstrably work. A coverage report that invents gaps is worse than none: it manufactures
    // a to-do list of already-finished work.
    // A variable may hold ONE path or several (a ternary picking an endpoint by channel), so map
    // each name to every path-shaped literal in its initialiser, not just the first.
    const vars = new Map();
    for (const v of src.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]{0,400}?);\n/g)) {
      const paths = [...v[2].matchAll(/[`'"](\/[^`'"]*)/g)].map(x => x[1]);
      if (paths.length) vars.set(v[1], paths);
    }
    const record = (method, path) => {
      const key = `${method.toUpperCase()} ${normalise(path)}`;
      if (!out.has(key)) out.set(key, new Set());
      out.get(key).add(cmd);
    };
    // literal path
    for (const m of src.matchAll(/ctx\.http\.(get|post|put|delete)\(\s*[`'"](\/[^`'"]*)/gi)) {
      record(m[1], m[2]);
    }
    // variable path, resolved against the same file
    for (const m of src.matchAll(/ctx\.http\.(get|post|put|delete)\(\s*([A-Za-z_$][\w$]*)\s*[,)]/gi)) {
      const resolved = vars.get(m[2]);
      if (resolved) resolved.forEach(pth => record(m[1], pth));
      // UNRESOLVED. Recorded rather than dropped: a silently-skipped call site inflates the gap
      // count, and this report's whole value is that its gap list can be trusted. A ternary
      // picking an endpoint by channel is what exposed this — `send cancel` was reported missing
      // while demonstrably working.
      else unresolved.push(`${cmd}: ctx.http.${m[1]}(${m[2]})`);
    }
  }
  return { out, unresolved };
}

// `/locations/${encodeURIComponent(loc)}/customValues/${id}` -> `/locations/{}/customValues/{}`
// and the inventory's `/locations/{locationId}/customValues/{id}` -> the same, so they compare.
function normalise(path) {
  return path
    .replace(/\$\{[^}]*\}/g, '{}')      // template interpolations
    .replace(/\{[a-zA-Z]+\}/g, '{}')    // inventory's named params
    .replace(/\?.*$/, '')               // query strings
    .replace(/\/+$/, '')                // trailing slash
    || '/';
}

const { out: called, unresolved } = calledEndpoints();
const calledKeys = new Set(called.keys());

const rows = inventory.operations.map(op => {
  const key = `${op.method} ${normalise(op.path)}`;
  const by = called.get(key);
  return {
    ...op,
    covered: !!by,
    by: by ? [...by].sort().join(', ') : null,
    deliberate: DELIBERATE_OMISSIONS[op.id] ?? null,
  };
});

const covered   = rows.filter(r => r.covered);
const deliberate = rows.filter(r => !r.covered && r.deliberate);
const unreviewed = rows.filter(r => !r.covered && !r.deliberate);

// Endpoints sizmo calls that the inventory does not know about. Not necessarily wrong — the
// inventory is a partial snapshot — but worth surfacing so it can be refreshed deliberately.
const unknown = [...calledKeys].filter(k => !inventory.operations.some(op => `${op.method} ${normalise(op.path)}` === k)).sort();

const pct = (n) => `${Math.round((n / rows.length) * 100)}%`;
const md = `# API coverage — what sizmo reaches, and what it does not

<!-- GENERATED by scripts/api-coverage.mjs. Do not edit by hand; edit the script or
     docs/api-inventory.json and regenerate. -->

Inventory captured **${inventory._provenance.capturedAt}** via ${inventory._provenance.source}.

> **This is not a to-do list.** Most uncovered operations *should* be uncovered — sizmo is built for
> coaches and consultants, so e-commerce, blogs and social surfaces have no place in it. Gaps are
> split into **deliberate** (decided, with a reason) and **unreviewed** (needs a human decision).
> An unreviewed gap is a question, not a defect.

| | count | share |
|---|---:|---:|
| Covered by a sizmo command | ${covered.length} | ${pct(covered.length)} |
| Deliberately not implemented | ${deliberate.length} | ${pct(deliberate.length)} |
| **Unreviewed — needs a decision** | **${unreviewed.length}** | **${pct(unreviewed.length)}** |
| Inventory total | ${rows.length} | |

## Unreviewed — needs a decision

${unreviewed.length === 0 ? '_None. Every operation in the inventory is either covered or explicitly decided against._' :
`| Operation | Method | Path | Domain |
|---|---|---|---|
${unreviewed.map(r => `| \`${r.id}\` | ${r.method} | \`${r.path}\` | ${r.domain} |`).join('\n')}`}

## Deliberately not implemented

| Operation | Reason |
|---|---|
${deliberate.map(r => `| \`${r.id}\` | ${r.deliberate} |`).join('\n')}

## Covered

| Operation | Method | Path | Reached by |
|---|---|---|---|
${covered.map(r => `| \`${r.id}\` | ${r.method} | \`${r.path}\` | ${r.by} |`).join('\n')}

${unknown.length ? `## Called by sizmo but absent from the inventory

The inventory is a partial snapshot of the domains sizmo operates in, so these are expected rather
than alarming — but refresh the inventory if one looks like it should be tracked.

${unknown.map(k => `- \`${k}\``).join('\n')}
` : ''}
## Resolver limits

${unresolved.length === 0
  ? '_Every `ctx.http.*` call site resolved to a concrete path, so the counts above have no known blind spot._'
  : `These call sites build their path in a way the extractor could not resolve, so the operations they reach may be \
under-counted as gaps. Fix the extractor or simplify the call site — do not just trust the number.

${unresolved.map(u => `- \`${u}\``).join('\n')}`}

## Scope of the inventory

${inventory._provenance.scope}

${inventory._provenance.honesty}
`;

const outPath = join(REPO, 'docs', 'api-coverage.md');
if (process.argv.includes('--check')) {
  const existing = (() => { try { return readFileSync(outPath, 'utf8'); } catch { return null; } })();
  if (existing !== md) {
    process.stderr.write('✖ docs/api-coverage.md is stale — run: node scripts/api-coverage.mjs\n');
    process.exit(1);
  }
  process.stdout.write('✓ api-coverage.md is current\n');
  process.exit(0);
}
writeFileSync(outPath, md);
process.stdout.write(
  `✓ docs/api-coverage.md written\n` +
  `  covered ${covered.length} · deliberate ${deliberate.length} · UNREVIEWED ${unreviewed.length} · total ${rows.length}\n`);

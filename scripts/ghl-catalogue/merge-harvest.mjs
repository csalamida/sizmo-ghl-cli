// scripts/ghl-catalogue/merge-harvest.mjs — fold a fresh MCP catalogue harvest into docs/api-inventory.json.
//
// WHY THIS EXISTS
// docs/api-inventory.json is a PARTIAL snapshot, captured 2026-07-27, and its own _provenance says
// so. It is the input to scripts/api-coverage.mjs, which decides what sizmo covers, what it
// deliberately skips, and what is still unreviewed. When the snapshot is stale or thin, coverage
// looks better than it is: an operation the inventory has never heard of cannot show up as a gap.
//
// So refreshing the inventory is the mechanism by which new API surface becomes visible as a
// DECISION to make, rather than silently not existing.
//
// WHY THE HARVEST IS SEPARATE FROM THIS SCRIPT
// Collection needs MCP access and credentials; this merge is pure data. Splitting them means the
// expensive credential-bound step runs occasionally by an agent, while the part that produces
// decisions runs offline, deterministically, forever. See seeds.json for the harvest procedure and
// for why the facade cannot be enumerated exhaustively.
//
// USAGE
//   node scripts/ghl-catalogue/merge-harvest.mjs <harvest.json>        # report only
//   node scripts/ghl-catalogue/merge-harvest.mjs <harvest.json> --apply
//
// The harvest file is [{operationId, domain, method, path, summary, scopes, kind, params,
// destructive, requiresApproval, idempotencyRequired}] — the shape search_operations returns.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INVENTORY = join(REPO, 'docs', 'api-inventory.json');

// Same normalisation api-coverage.mjs uses, so the two agree on what "the same endpoint" means.
// Named path params differ between sources ({contactId} vs {id}), and they are the same route.
const normalise = (p) => String(p).replace(/\{[a-zA-Z]+\}/g, '{}').replace(/\/+$/, '') || '/';
const key = (op) => `${op.method} ${normalise(op.path)}`;

const harvestPath = process.argv[2];
const apply = process.argv.includes('--apply');
if (!harvestPath) {
  console.error('usage: node scripts/ghl-catalogue/merge-harvest.mjs <harvest.json> [--apply]');
  process.exit(2);
}

const inventory = JSON.parse(readFileSync(INVENTORY, 'utf8'));
const raw = JSON.parse(readFileSync(harvestPath, 'utf8'));
const harvested = Array.isArray(raw) ? raw : (raw.operations ?? []);
if (!harvested.length) {
  console.error(`${harvestPath}: no operations found — refusing to merge an empty harvest over a real inventory`);
  process.exit(1);
}

const existing = new Map(inventory.operations.map(op => [key(op), op]));
const added = [];
const enriched = [];

for (const h of harvested) {
  if (!h?.method || !h?.path) continue;
  const k = key(h);
  const prev = existing.get(k);
  // Fields the 2026-07-27 snapshot did not carry. They are what makes safety classification
  // derivable rather than hand-maintained, so they are worth backfilling onto known operations too.
  const extra = {
    ...(h.scopes?.length ? { scopes: h.scopes } : {}),
    ...(h.params?.length ? { params: h.params } : {}),
    ...(h.destructive != null ? { destructive: h.destructive } : {}),
    ...(h.requiresApproval != null ? { requiresApproval: h.requiresApproval } : {}),
    ...(h.idempotencyRequired != null ? { idempotencyRequired: h.idempotencyRequired } : {}),
    ...(h.summary ? { summary: h.summary } : {}),
  };
  if (!prev) {
    added.push({ id: h.operationId, method: h.method, path: h.path, domain: h.domain, kind: h.kind, ...extra });
    continue;
  }
  const gained = Object.keys(extra).filter(f => prev[f] === undefined);
  if (gained.length) {
    Object.assign(prev, extra);
    enriched.push({ id: prev.id, gained });
  }
}

const byDomain = {};
for (const a of added) byDomain[a.domain] = (byDomain[a.domain] ?? 0) + 1;

console.log(`inventory before: ${inventory.operations.length} operations`);
console.log(`harvest:          ${harvested.length} operations`);
console.log(`NEW (not in inventory): ${added.length}`);
for (const [d, n] of Object.entries(byDomain).sort((a, b) => b[1] - a[1])) console.log(`   ${d.padEnd(16)} ${n}`);
console.log(`ENRICHED (known op, new fields): ${enriched.length}`);
if (added.length) {
  console.log('\nnew operations:');
  for (const a of added.sort((x, y) => (x.domain + x.path).localeCompare(y.domain + y.path))) {
    console.log(`   ${String(a.kind).padEnd(6)} ${a.method.padEnd(6)} ${a.path}`);
  }
}

if (!apply) {
  console.log('\n(report only — pass --apply to write docs/api-inventory.json)');
  process.exit(0);
}

inventory.operations = [...inventory.operations, ...added]
  .sort((a, b) => (a.domain + a.path + a.method).localeCompare(b.domain + b.path + b.method));
inventory._provenance.capturedAt = new Date().toISOString().slice(0, 10);
inventory._provenance.refreshHistory = [
  ...(inventory._provenance.refreshHistory ?? []),
  { at: new Date().toISOString().slice(0, 10), added: added.length, enriched: enriched.length, via: harvestPath.split('/').pop() },
];
// The scope note must keep saying PARTIAL. A bigger snapshot is still a floor: the MCP facade is a
// semantic search with no list-everything call, so "we harvested more" never becomes "we have it all".
writeFileSync(INVENTORY, JSON.stringify(inventory, null, 2) + '\n');
console.log(`\n✓ docs/api-inventory.json → ${inventory.operations.length} operations`);
console.log('  next: node scripts/api-coverage.mjs   (new ops surface as UNREVIEWED — each is a decision)');

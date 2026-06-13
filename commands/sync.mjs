// commands/sync.mjs — force-refresh the local CRM model.
// Fetches all 6 structure entities (or a subset) and stores the blob.
// READ-ONLY. Only writes to the local model file; never writes to GoHighLevel.
import { syncModel, ENTITY_SPECS, DEFAULT_MODEL_DIR } from '../lib/model.mjs';

export const meta = {
  name: 'sync',
  summary: 'Refresh the local CRM model (pipelines, calendars, tags, fields, users, location)',
  flags: [],
  readOnly: true,
};

export async function run(args, ctx) {
  const dir = ctx._modelDir ?? DEFAULT_MODEL_DIR;
  const loc = ctx.cfg.loc;
  const now = typeof ctx.now === 'function' ? ctx.now : () => ctx.now;

  // Optional: sync only one entity — `sizmo sync tags`
  const entityArg = args._?.[0];
  const validNames = ENTITY_SPECS.map(s => s.name);
  // Also accept 'fields' as alias for 'customFields'
  const alias = { fields: 'customFields' };
  const resolvedArg = entityArg ? (alias[entityArg] ?? entityArg) : null;
  const only = resolvedArg ? [resolvedArg] : null;

  if (resolvedArg && !validNames.includes(resolvedArg)) {
    ctx.out.warn(`unknown entity "${entityArg}" — valid: ${validNames.join(', ')}`);
    return 1;
  }

  const model = await syncModel({ http: ctx.http, loc, dir, now, only });

  // Count results
  let synced = 0, blocked = 0;
  for (const [, ent] of Object.entries(model.entities)) {
    if (ent.blocked) blocked++;
    else synced++;
  }

  ctx.out.data({ synced, blocked, locationId: loc, syncedAt: model.syncedAt, entities: Object.fromEntries(
    Object.entries(model.entities).map(([name, ent]) => [
      name,
      ent.blocked
        ? { blocked: true, scope: ent.scope }
        : { fetchedAt: ent.fetchedAt, count: ent.items ? ent.items.length : (ent.item ? 1 : 0) },
    ])
  )});

  ctx.out.card(() => {
    const blockedNote = blocked > 0 ? ` (${blocked} blocked — check sizmo auth check)` : '';
    ctx.out.line(`synced ${synced} of ${synced + blocked} entities${blockedNote} · loc ${loc}`);
    for (const [name, ent] of Object.entries(model.entities)) {
      if (ent.blocked) {
        ctx.out.line(`  ✖ ${name.padEnd(14)} needs ${ent.scope}`);
      } else {
        const count = ent.items ? ent.items.length : (ent.item ? 1 : 0);
        ctx.out.line(`  ✔ ${name.padEnd(14)} ${count} item(s)`);
      }
    }
  });

  return 0;
}

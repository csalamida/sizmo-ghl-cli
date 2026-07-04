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

  let model;
  try {
    model = await syncModel({ http: ctx.http, loc, dir, now, only });
  } catch (e) {
    if (e.offline) {
      ctx.out.warn("⚠ OFFLINE — can't reach GoHighLevel — check your connection; run `sizmo sync` when online");
      return 1;
    }
    // Write failure (disk full, permissions, etc.)
    ctx.out.warn(`sync failed — model not written: ${e.message}`);
    return 1;
  }

  // Count results
  let synced = 0, blocked = 0, networkErrors = 0;
  for (const [, ent] of Object.entries(model.entities)) {
    if (ent.networkError) networkErrors++;
    else if (ent.blocked) blocked++;
    else synced++;
  }

  ctx.out.data({ synced, blocked, networkErrors: networkErrors || undefined, offline: model.offline || undefined,
    locationId: loc, syncedAt: model.syncedAt, entities: Object.fromEntries(
    Object.entries(model.entities).map(([name, ent]) => [
      name,
      ent.networkError
        ? { networkError: true, error: ent.error }
        : ent.blocked
          // httpCode present = a real (non-401/403) API error reached the PIT — NOT a scope
          // issue, even though the entity is blocked the same way. Surface it so an agent
          // piping --json doesn't wrongly conclude the scope needs granting.
          ? (ent.httpCode ? { blocked: true, httpCode: ent.httpCode, scope: ent.scope } : { blocked: true, scope: ent.scope })
          : { fetchedAt: ent.fetchedAt, count: ent.items ? ent.items.length : (ent.item ? 1 : 0) },
    ])
  )});

  ctx.out.card(() => {
    const blockedNote = blocked > 0 ? ` (${blocked} scope-blocked)` : '';
    const netNote = networkErrors > 0 ? ` (${networkErrors} network-error — check connection)` : '';
    ctx.out.line(`synced ${synced} of ${synced + blocked + networkErrors} entities${blockedNote}${netNote} · loc ${loc}`);
    for (const [name, ent] of Object.entries(model.entities)) {
      if (ent.networkError) {
        ctx.out.line(`  ⚠ ${name.padEnd(14)} couldn't reach GHL`);
      } else if (ent.blocked && ent.httpCode) {
        // Not a scope block — the scope reached real logic and got a real API error back
        // (a bad request sizmo itself sent, a 404, a 5xx). Saying "needs <scope>" here would
        // be actively wrong if the scope is already granted — this is a sizmo/API bug, not
        // a permissions gap.
        ctx.out.line(`  ✖ ${name.padEnd(14)} API error ${ent.httpCode} (not a scope issue — please report this)`);
      } else if (ent.blocked) {
        ctx.out.line(`  ✖ ${name.padEnd(14)} needs ${ent.scope}`);
      } else {
        const count = ent.items ? ent.items.length : (ent.item ? 1 : 0);
        ctx.out.line(`  ✔ ${name.padEnd(14)} ${count} item(s)`);
      }
    }
    if (model.offline) {
      ctx.out.line('  ⚠ some entities could not be reached — model may be partially stale');
    }
  });

  return 0;
}

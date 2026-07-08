// commands/opp.mjs — create, move, update, or delete a pipeline opportunity.
// Scope required: opportunities.write
// Pipeline and stage names are resolved to IDs via the CRM model, falling back to a live fetch
// on a cache miss — verified live 2026-07-05: same gap as appointment.mjs's calendar resolution
// and sizmo ask's field/calendar/business resolution, just for pipelines/stages here.
// NEVER fires without --confirm. No-confirm → exit 5 (CONFIRM) + envelope.
// 401/403 → exit 3 with scope guidance.
//
// `delete` added 2026-07-08 — found via search_operations that DELETE /opportunities/{id}
// exists; sizmo previously had no way to remove one, meaning every SIZMO-VERIFY-* test
// opportunity created during live-fire sweeps had to be left behind permanently. Matches
// commands/contact.mjs's delete pattern exactly: fetch first (names it in the preview, a wrong
// id 404s before touching anything), single-target only, never bulk.
import { requireConfirm } from '../lib/confirm.mjs';
import { GhlError, EXIT } from '../lib/errors.mjs';
import { isStale, fetchLiveEntity } from '../lib/model.mjs';

export const meta = {
  name: 'opp',
  summary: 'create, move, update, or delete a pipeline opportunity',
  flags: [
    { name: '--name',     type: 'string', desc: 'opportunity title (create)' },
    { name: '--pipeline', type: 'string', desc: 'pipeline name (create)' },
    { name: '--stage',    type: 'string', desc: 'stage name (create / move)' },
    { name: '--value',    type: 'string', desc: 'monetary value e.g. 5000 (create / update)' },
    { name: '--contact',  type: 'string', desc: 'contact id to associate (create)' },
    { name: '--status',   type: 'string', desc: 'open|won|lost|abandoned (update)' },
  ],
  readOnly: false,
};

// Resolve a pipeline name → { pipelineId, pipelineName } using the CRM model.
// Returns null when not found. Also surfaces staleness.
function resolvePipelineByName(name, model) {
  const entities = model?.entities;
  const pls = entities?.pipelines;
  if (!pls || pls.blocked || !Array.isArray(pls.items)) return null;
  return pls.items.find(p => p.name === name) ?? null;
}

// Resolve a stage name within a given pipeline → { stageId, stageName }.
function resolveStageByName(stageName, pipelineItem) {
  if (!pipelineItem || !Array.isArray(pipelineItem.stages)) return null;
  return pipelineItem.stages.find(s => s.name === stageName) ?? null;
}

// Find any pipeline containing a stage with this name (for move without --pipeline).
function resolveStageGlobal(stageName, model) {
  const pls = model?.entities?.pipelines;
  if (!pls || pls.blocked || !Array.isArray(pls.items)) return null;
  for (const pl of pls.items) {
    const stage = resolveStageByName(stageName, pl);
    if (stage) return { pipeline: pl, stage };
  }
  return null;
}

// Age of the pipelines entity in hours (for confirm preview staleness note).
function pipelineAgeNote(model, now) {
  const ent = model?.entities?.pipelines;
  if (!ent || typeof ent.fetchedAt !== 'number') return null;
  const h = Math.round((now - ent.fetchedAt) / 3_600_000);
  return h > 0 ? `CRM model synced ${h}h ago — sizmo sync to refresh` : null;
}

export async function run(args, ctx) {
  const sub = args._?.[0]; // 'create' | 'move' | 'update' | 'delete'
  if (!sub || !['create', 'move', 'update', 'delete'].includes(sub)) {
    throw new GhlError(
      'usage: sizmo opp create --name --pipeline --stage [--value] --contact <id>\n' +
      '       sizmo opp move <oppId> --stage <name>\n' +
      '       sizmo opp update <oppId> [--value --status]\n' +
      '       sizmo opp delete <oppId>',
      EXIT.USAGE, 'sizmo schema'
    );
  }

  const now = typeof ctx.now === 'function' ? ctx.now() : ctx.now;

  // ── create ───────────────────────────────────────────────────────────────────
  if (sub === 'create') {
    const name    = args.name;
    const plName  = args.pipeline;
    const stName  = args.stage;
    const value   = args.value   ?? null;
    const contact = args.contact ?? null;

    if (!name)    throw new GhlError('opp create requires --name',     EXIT.USAGE);
    if (!plName)  throw new GhlError('opp create requires --pipeline', EXIT.USAGE);
    if (!stName)  throw new GhlError('opp create requires --stage',    EXIT.USAGE);
    if (!contact) throw new GhlError('opp create requires --contact',  EXIT.USAGE);

    // Resolve names → IDs via model, falling back to a live fetch on a miss (the pipeline/stage
    // may have been created earlier in this same session, before the model last re-synced).
    // One live cache shared across both lookups below — a stage-resolution miss right after a
    // pipeline-resolution live fetch reuses that same fetch instead of firing a second one.
    const model = await ctx.ensureModel();
    const liveCache = new Map();
    let pl = resolvePipelineByName(plName, model);
    if (!pl) {
      const live = await fetchLiveEntity('pipelines', ctx, liveCache);
      if (!live.error) pl = live.items.find(p => p.name === plName) ?? null;
    }
    if (!pl) {
      throw new GhlError(
        `unknown pipeline '${plName}' — run sizmo crm pipelines`,
        EXIT.NOTFOUND,
        'sizmo crm pipelines to list available pipelines'
      );
    }
    let stage = resolveStageByName(stName, pl);
    if (!stage) {
      // pl itself may be current but its stages stale (a new stage added after last sync) —
      // re-check against a live pipelines fetch before giving up.
      const live = await fetchLiveEntity('pipelines', ctx, liveCache);
      if (!live.error) {
        const livePl = live.items.find(p => p.name === plName);
        if (livePl) stage = resolveStageByName(stName, livePl);
      }
    }
    if (!stage) {
      throw new GhlError(
        `unknown stage '${stName}' in pipeline '${plName}' — run sizmo crm pipelines`,
        EXIT.NOTFOUND,
        'sizmo crm pipelines to list available stages'
      );
    }

    const staleNote = pipelineAgeNote(model, now);
    const changes = [
      `Create opportunity '${name}'`,
      `  pipeline: ${plName} (id: ${pl.id})`,
      `  stage:    ${stName} (id: ${stage.id})`,
      `  contact:  ${contact}`,
      ...(value   ? [`  value:    ${value}`] : []),
      ...(staleNote ? [`  (${staleNote})`] : []),
    ];
    const valuePart  = value   ? ` --value "${value}"` : '';
    const rerunCommand = `sizmo opp create --name "${name}" --pipeline "${plName}" --stage "${stName}" --contact ${contact}${valuePart} --confirm`;

    const gate = requireConfirm({ command: 'opp create', changes, rerunCommand }, ctx);
    if (!gate.proceed) return gate.code;

    // Execute
    // GHL's create endpoint requires locationId in the body (verified live: 422 "locationId
    // can't be undefined" without it) and the stage field is pipelineStageId, not stageId
    // (verified live: 422 "property stageId should not exist").
    const body = {
      name,
      locationId: ctx.cfg.loc,
      pipelineId: pl.id,
      pipelineStageId: stage.id,
      status: 'open',
      contactId: contact,
      ...(value != null ? { monetaryValue: Number(value) } : {}),
    };
    const r = await ctx.http.post('/opportunities/', body);

    if (r.code === 401 || r.code === 403) {
      throw new GhlError(
        `HTTP ${r.code} — your PIT lacks opportunities.write — add it in GoHighLevel → Private Integrations`,
        EXIT.AUTH,
        'GoHighLevel → Settings → Private Integrations → edit your PIT → add opportunities.write scope'
      );
    }
    if (!r.ok) {
      throw new GhlError(`opp create failed — HTTP ${r.code}: ${(r.txt || '').slice(0, 200)}`, EXIT.API);
    }

    ctx.out.data({ status: 'ok', command: 'opp create', opportunityId: r.j?.opportunity?.id ?? r.j?.id ?? null });
    ctx.out.line(`  opportunity '${name}' created in ${plName} / ${stName}`);
    return EXIT.OK;
  }

  // ── move ─────────────────────────────────────────────────────────────────────
  if (sub === 'move') {
    const oppId  = args._?.[1];
    const stName = args.stage;

    if (!oppId)  throw new GhlError('usage: sizmo opp move <oppId> --stage <name>', EXIT.USAGE);
    if (!stName) throw new GhlError('opp move requires --stage', EXIT.USAGE);

    const model = await ctx.ensureModel();
    let found = resolveStageGlobal(stName, model);
    if (!found) {
      const live = await fetchLiveEntity('pipelines', ctx, new Map());
      if (!live.error) {
        for (const pl of live.items) {
          const stage = resolveStageByName(stName, pl);
          if (stage) { found = { pipeline: pl, stage }; break; }
        }
      }
    }
    if (!found) {
      throw new GhlError(
        `unknown stage '${stName}' — run sizmo crm pipelines`,
        EXIT.NOTFOUND,
        'sizmo crm pipelines to list available stages'
      );
    }

    const staleNote = pipelineAgeNote(model, now);
    const changes = [
      `Move opportunity ${oppId} to stage '${stName}'`,
      `  pipeline: ${found.pipeline.name} (id: ${found.pipeline.id})`,
      `  stage id: ${found.stage.id}`,
      ...(staleNote ? [`  (${staleNote})`] : []),
    ];
    const rerunCommand = `sizmo opp move ${oppId} --stage "${stName}" --confirm`;

    const gate = requireConfirm({ command: 'opp move', changes, rerunCommand }, ctx);
    if (!gate.proceed) return gate.code;

    // Execute
    // GHL's field is pipelineStageId, not stageId (verified live against a real opportunity:
    // sending stageId returns 422 "property stageId should not exist" — the move never applies).
    const r = await ctx.http.put(`/opportunities/${encodeURIComponent(oppId)}`, { pipelineStageId: found.stage.id });

    if (r.code === 401 || r.code === 403) {
      throw new GhlError(
        `HTTP ${r.code} — your PIT lacks opportunities.write — add it in GoHighLevel → Private Integrations`,
        EXIT.AUTH,
        'GoHighLevel → Settings → Private Integrations → edit your PIT → add opportunities.write scope'
      );
    }
    if (!r.ok) {
      throw new GhlError(`opp move failed — HTTP ${r.code}: ${(r.txt || '').slice(0, 200)}`, EXIT.API);
    }

    ctx.out.data({ status: 'ok', command: 'opp move', opportunityId: oppId, stageId: found.stage.id });
    ctx.out.line(`  opportunity ${oppId} moved to stage '${stName}'`);
    return EXIT.OK;
  }

  // ── update ───────────────────────────────────────────────────────────────────
  if (sub === 'update') {
    const oppId  = args._?.[1];
    const value  = args.value  ?? null;
    const status = args.status ?? null;

    if (!oppId) throw new GhlError('usage: sizmo opp update <oppId> [--value --status]', EXIT.USAGE);
    if (!value && !status) {
      throw new GhlError('opp update requires at least one of --value or --status', EXIT.USAGE);
    }

    const VALID_STATUS = ['open', 'won', 'lost', 'abandoned'];
    if (status && !VALID_STATUS.includes(status)) {
      throw new GhlError(`opp update: invalid --status '${status}' — must be one of ${VALID_STATUS.join('|')}`, EXIT.USAGE);
    }

    const changes = [
      `Update opportunity ${oppId}`,
      ...(value  ? [`  value:  ${value}`]  : []),
      ...(status ? [`  status: ${status}`] : []),
    ];
    const valuePart  = value  ? ` --value "${value}"` : '';
    const statusPart = status ? ` --status ${status}` : '';
    const rerunCommand = `sizmo opp update ${oppId}${valuePart}${statusPart} --confirm`;

    const gate = requireConfirm({ command: 'opp update', changes, rerunCommand }, ctx);
    if (!gate.proceed) return gate.code;

    // Execute
    const body = {
      ...(value  != null ? { monetaryValue: Number(value) } : {}),
      ...(status != null ? { status } : {}),
    };
    const r = await ctx.http.put(`/opportunities/${encodeURIComponent(oppId)}`, body);

    if (r.code === 401 || r.code === 403) {
      throw new GhlError(
        `HTTP ${r.code} — your PIT lacks opportunities.write — add it in GoHighLevel → Private Integrations`,
        EXIT.AUTH,
        'GoHighLevel → Settings → Private Integrations → edit your PIT → add opportunities.write scope'
      );
    }
    if (!r.ok) {
      throw new GhlError(`opp update failed — HTTP ${r.code}: ${(r.txt || '').slice(0, 200)}`, EXIT.API);
    }

    ctx.out.data({ status: 'ok', command: 'opp update', opportunityId: oppId });
    ctx.out.line(`  opportunity ${oppId} updated`);
    return EXIT.OK;
  }

  // ── delete ───────────────────────────────────────────────────────────────────
  if (sub === 'delete') {
    const oppId = args._?.[1];
    if (!oppId || !String(oppId).trim()) {
      throw new GhlError('usage: sizmo opp delete <oppId> — exactly one id, never bulk', EXIT.USAGE, 'sizmo pipeline …  # to find the id');
    }

    // SAFETY: fetch the single opportunity first so the preview names it, and a wrong id 404s
    // here (nothing deleted) instead of touching anything — matches commands/contact.mjs.
    const got = await ctx.http.get(`/opportunities/${encodeURIComponent(oppId)}`);
    if (got.code === 401 || got.code === 403) {
      throw new GhlError(`HTTP ${got.code} — your PIT lacks opportunities.write`, EXIT.AUTH,
        'GoHighLevel → Settings → Private Integrations → edit your PIT → add opportunities.write scope');
    }
    if (got.code === 404) throw new GhlError(`no opportunity with id ${oppId} — nothing deleted`, EXIT.NOTFOUND);
    if (!got.ok) throw new GhlError(`opp delete: could not read opportunity ${oppId} — HTTP ${got.code}`, EXIT.API);
    const o = got.j?.opportunity ?? got.j ?? {};
    const who = o.name || '(unnamed)';

    const changes = [
      `Delete opportunity "${who}" (id ${oppId})`,
      '  ⚠ removes THIS ONE opportunity only — sizmo deletes a single record by id, never in bulk',
    ];
    const rerunCommand = `sizmo opp delete ${oppId} --confirm`;
    const gate = requireConfirm({ command: 'opp delete', changes, rerunCommand }, ctx);
    if (!gate.proceed) return gate.code;

    const r = await ctx.http.delete(`/opportunities/${encodeURIComponent(oppId)}`);
    if (r.code === 401 || r.code === 403) {
      throw new GhlError(`HTTP ${r.code} — your PIT lacks opportunities.write`, EXIT.AUTH,
        'GoHighLevel → Settings → Private Integrations → edit your PIT → add opportunities.write scope');
    }
    if (!r.ok) throw new GhlError(`opp delete failed — HTTP ${r.code}: ${(r.txt || '').slice(0, 200)}`, EXIT.API);

    ctx.out.data({ status: 'ok', command: 'opp delete', opportunityId: oppId, name: who });
    ctx.out.line(`  opportunity "${who}" (id ${oppId}) deleted`);
    return EXIT.OK;
  }
}

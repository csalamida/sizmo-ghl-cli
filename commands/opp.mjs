// commands/opp.mjs — create, move, or update a pipeline opportunity.
// Scope required: opportunities.write
// Pipeline and stage names are resolved to IDs via the CRM model.
// NEVER fires without --confirm. No-confirm → exit 4 + envelope.
// 401/403 → exit 3 with scope guidance.
import { requireConfirm } from '../lib/confirm.mjs';
import { GhlError, EXIT } from '../lib/errors.mjs';
import { isStale } from '../lib/model.mjs';

export const meta = {
  name: 'opp',
  summary: 'create, move, or update a pipeline opportunity',
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
  const sub = args._?.[0]; // 'create' | 'move' | 'update'
  if (!sub || !['create', 'move', 'update'].includes(sub)) {
    throw new GhlError(
      'usage: sizmo opp create --name --pipeline --stage [--value] --contact <id>\n' +
      '       sizmo opp move <oppId> --stage <name>\n' +
      '       sizmo opp update <oppId> [--value --status]',
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

    // Resolve names → IDs via model
    const model = await ctx.ensureModel();
    const pl    = resolvePipelineByName(plName, model);
    if (!pl) {
      throw new GhlError(
        `unknown pipeline '${plName}' — run sizmo crm pipelines`,
        EXIT.AUTH,
        'sizmo crm pipelines to list available pipelines'
      );
    }
    const stage = resolveStageByName(stName, pl);
    if (!stage) {
      throw new GhlError(
        `unknown stage '${stName}' in pipeline '${plName}' — run sizmo crm pipelines`,
        EXIT.AUTH,
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
    const body = {
      name,
      pipelineId: pl.id,
      stageId: stage.id,
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
    const found = resolveStageGlobal(stName, model);
    if (!found) {
      throw new GhlError(
        `unknown stage '${stName}' — run sizmo crm pipelines`,
        EXIT.AUTH,
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
    const r = await ctx.http.put(`/opportunities/${oppId}`, { stageId: found.stage.id });

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
    const r = await ctx.http.put(`/opportunities/${oppId}`, body);

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
}

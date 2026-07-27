// commands/business.mjs — B2B company (business) management.
// sizmo business list                            → list companies (from model cache)
// sizmo business create --name "Acme" [--email] [--phone] [--website] --confirm
// sizmo business delete <id> --confirm
//
// SECURITY: create/delete are confirm-gated. Money never moves here.
// Businesses link to contacts as accounts (B2B use case).

import { GhlError, EXIT } from '../lib/errors.mjs';
import { requireConfirm } from '../lib/confirm.mjs';

// Same remediation shape every other write command uses. business.mjs printed a bare line and
// RETURNED the exit code instead of throwing, which meant `--json` emitted a success-shaped
// envelope on a hard 401: degraded:false, warnings:[], no error, no remediation. An agent parsing
// the envelope saw a clean no-op; only the exit code disagreed. Throwing routes through the CLI's
// error handler, which is what produces {error, code, remediation}.
const SCOPE_FIX_W = 'GoHighLevel → Settings → Private Integrations → edit your PIT → add businesses.write scope';
const SCOPE_FIX_R = 'GoHighLevel → Settings → Private Integrations → edit your PIT → add businesses.readonly scope';

export const meta = {
  name: 'business',
  summary: 'manage B2B companies — list, create, delete',
  flags: [
    { name: '--name',    type: 'string', desc: 'company name' },
    { name: '--email',   type: 'string', desc: 'company email' },
    { name: '--phone',   type: 'string', desc: 'company phone' },
    { name: '--website', type: 'string', desc: 'company website URL' },
  ],
};

export async function run(parsed, ctx) {
  const sub = parsed._?.[0] ?? 'list';

  switch (sub) {
    case 'list':   return listBusinesses(ctx);
    case 'create': return createBusiness(parsed, ctx);
    case 'delete': return deleteBusiness(parsed, ctx);
    default:
      ctx.out.line(`unknown subcommand "${sub}"`);
      ctx.out.line('valid: list | create | delete');
      return EXIT.USAGE;
  }
}

// ── list ──────────────────────────────────────────────────────────────────────

async function listBusinesses(ctx) {
  const model = await ctx.ensureModel();
  const ents  = model?.entities ?? {};

  if (ents.businesses?.blocked) {
    // httpCode present = a real (non-401/403) API error reached the PIT — not a scope issue,
    // even though sync marks it "blocked" the same way as a real 401/403.
    if (ents.businesses.httpCode) {
      throw new GhlError(`businesses — API error ${ents.businesses.httpCode} (not a scope issue — please report this)`, EXIT.API);
    }
    throw new GhlError('businesses blocked — your PIT lacks businesses.readonly', EXIT.AUTH, SCOPE_FIX_R);
  }

  const items = ents.businesses?.items ?? [];

  ctx.out.data({ entity: 'businesses', items });

  ctx.out.line('');
  ctx.out.line(`  BUSINESSES (${items.length})`);
  ctx.out.line('  ' + '─'.repeat(82));
  ctx.out.line(`  ${'Name'.padEnd(28)}  ${'Business ID'.padEnd(26)}  Website`);
  ctx.out.line('  ' + '─'.repeat(82));

  for (const b of items) {
    ctx.out.line(`  ${pad(b.name, 28)}  ${pad(b.id, 26)}  ${b.website || '—'}`);
  }

  ctx.out.line('  ' + '─'.repeat(82));
  ctx.out.line('  Copy Business ID → sizmo business delete <id> --confirm\n');
  return EXIT.OK;
}

// ── create ────────────────────────────────────────────────────────────────────

async function createBusiness(parsed, ctx) {
  const name = parsed.name?.trim();
  if (!name) {
    ctx.out.line('--name required');
    return EXIT.USAGE;
  }

  const loc  = ctx.cfg.loc;
  const body = {
    name,
    locationId: loc,
    ...(parsed.email   && { email:   parsed.email }),
    ...(parsed.phone   && { phone:   parsed.phone }),
    ...(parsed.website && { website: parsed.website }),
  };

  const changes = [
    `Create business "${name}"`,
    ...(parsed.email   ? [`  email:   ${parsed.email}`]   : []),
    ...(parsed.phone   ? [`  phone:   ${parsed.phone}`]   : []),
    ...(parsed.website ? [`  website: ${parsed.website}`] : []),
  ];
  const rerunParts = [`sizmo business create --name "${name.replace(/"/g, '\\"')}"`];
  if (parsed.email)   rerunParts.push(`--email "${parsed.email}"`);
  if (parsed.phone)   rerunParts.push(`--phone "${parsed.phone}"`);
  if (parsed.website) rerunParts.push(`--website "${parsed.website}"`);
  rerunParts.push('--confirm');
  const gate = requireConfirm({ command: 'business create', changes, rerunCommand: rerunParts.join(' ') }, ctx);
  if (!gate.proceed) return gate.code;

  let result;
  try {
    const r = await ctx.http.post(`/businesses/`, body);
    if (r.code === 401 || r.code === 403) {
      throw new GhlError(`HTTP ${r.code} — your PIT lacks businesses.write`, EXIT.AUTH, SCOPE_FIX_W);
    }
    if (!r.ok) {
      throw new GhlError(`business create failed — HTTP ${r.code}: ${r.j?.message ?? r.j?.msg ?? 'unknown'}`, EXIT.API);
    }
    result = r.j?.business ?? r.j;
  } catch (e) {
    // Deliberate GhlErrors raised above must pass through — swallowing them here downgrades a
    // precise 401-plus-remediation into a generic API error and loses the fix line.
    if (e instanceof GhlError) throw e;
    // Transport failure (DNS, timeout, socket). Throw rather than warn-and-return so it gets the
    // same {error, code} envelope as everything else — warn alone leaves degraded:false and no
    // `error` field, which reads as success to anything parsing --json.
    throw new GhlError(`could not create business: ${e.message}`, EXIT.API);
  }

  const id = result?.id ?? result?._id;
  ctx.out.data({ created: true, id: id ?? null, name });
  if (!id) {
    ctx.out.line(`  ✓ created — run \`sizmo list businesses\` to find the new Business ID`);
  } else {
    ctx.out.line(`  ✓ created — Business ID: ${id}`);
  }
  ctx.out.line('  Run sizmo sync businesses to refresh the local cache.\n');
  return EXIT.OK;
}

// ── delete ────────────────────────────────────────────────────────────────────

async function deleteBusiness(parsed, ctx) {
  const id = parsed._?.[1];
  if (!id) {
    ctx.out.line('business ID required: sizmo business delete <id> --confirm');
    return EXIT.USAGE;
  }

  // Fetch the business first so we can show the name and confirm correctness.
  let biz;
  try {
    const r = await ctx.http.get(`/businesses/${encodeURIComponent(id)}`);
    if (r.code === 401 || r.code === 403) {
      throw new GhlError(`HTTP ${r.code} — your PIT lacks businesses.readonly`, EXIT.AUTH, SCOPE_FIX_R);
    }
    if (r.code === 404) {
      throw new GhlError(`no business with id ${id} — nothing deleted`, EXIT.NOTFOUND);
    }
    if (!r.ok) {
      throw new GhlError(`business lookup failed — HTTP ${r.code}`, EXIT.API);
    }
    biz = r.j?.business ?? r.j;
  } catch (e) {
    // Deliberate GhlErrors raised above must pass through — swallowing them here downgrades a
    // precise 401-plus-remediation into a generic API error and loses the fix line.
    if (e instanceof GhlError) throw e;
    // Transport failure (DNS, timeout, socket). Throw rather than warn-and-return so it gets the
    // same {error, code} envelope as everything else — warn alone leaves degraded:false and no
    // `error` field, which reads as success to anything parsing --json.
    throw new GhlError(`could not fetch business: ${e.message}`, EXIT.API);
  }

  const name = biz?.name ?? id;

  const changes = [
    `Delete business "${name}" (id ${id})`,
    '  ⚠  This is permanent and cannot be undone.',
  ];
  const gate = requireConfirm({ command: 'business delete', changes, rerunCommand: `sizmo business delete ${id} --confirm` }, ctx);
  if (!gate.proceed) return gate.code;

  try {
    const r = await ctx.http.delete(`/businesses/${encodeURIComponent(id)}`);
    if (r.code === 401 || r.code === 403) {
      throw new GhlError(`HTTP ${r.code} — your PIT lacks businesses.write`, EXIT.AUTH, SCOPE_FIX_W);
    }
    if (r.code === 404) {
      throw new GhlError(`no business with id ${id} (already deleted?) — nothing changed`, EXIT.NOTFOUND);
    }
    if (!r.ok) {
      throw new GhlError(`business delete failed — HTTP ${r.code}: ${r.j?.message ?? 'unknown'}`, EXIT.API);
    }
  } catch (e) {
    // Deliberate GhlErrors raised above must pass through — swallowing them here downgrades a
    // precise 401-plus-remediation into a generic API error and loses the fix line.
    if (e instanceof GhlError) throw e;
    // Transport failure (DNS, timeout, socket). Throw rather than warn-and-return so it gets the
    // same {error, code} envelope as everything else — warn alone leaves degraded:false and no
    // `error` field, which reads as success to anything parsing --json.
    throw new GhlError(`could not delete business: ${e.message}`, EXIT.API);
  }

  ctx.out.data({ deleted: true, id, name });
  ctx.out.line(`  ✓ deleted — "${name}"`);
  ctx.out.line('  Run sizmo sync businesses to refresh the local cache.\n');
  return EXIT.OK;
}

function pad(s, n) { return String(s ?? '').slice(0, n).padEnd(n); }

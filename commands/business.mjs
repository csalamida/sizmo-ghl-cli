// commands/business.mjs — B2B company (business) management.
// sizmo business list                            → list companies (from model cache)
// sizmo business create --name "Acme" [--email] [--phone] [--website] --confirm
// sizmo business delete <id> --confirm
//
// SECURITY: create/delete are confirm-gated. Money never moves here.
// Businesses link to contacts as accounts (B2B use case).

import { EXIT } from '../lib/errors.mjs';

export const meta = {
  name: 'business',
  summary: 'manage B2B companies — list, create, delete',
  flags: [
    { name: '--name',    type: 'string', desc: 'company name' },
    { name: '--email',   type: 'string', desc: 'company email' },
    { name: '--phone',   type: 'string', desc: 'company phone' },
    { name: '--website', type: 'string', desc: 'company website URL' },
    { name: '--confirm', type: 'bool',   desc: 'execute write (required for create/delete)' },
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
      ctx.out.line(`✖ businesses — API error ${ents.businesses.httpCode} (not a scope issue — please report this)`);
      return EXIT.API;
    }
    ctx.out.line('✖ businesses blocked — needs businesses.readonly scope');
    return EXIT.AUTH;
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

  ctx.out.line('');
  ctx.out.line('  CREATE BUSINESS');
  ctx.out.line('  ' + '─'.repeat(50));
  ctx.out.line(`  Name:     ${name}`);
  if (parsed.email)   ctx.out.line(`  Email:    ${parsed.email}`);
  if (parsed.phone)   ctx.out.line(`  Phone:    ${parsed.phone}`);
  if (parsed.website) ctx.out.line(`  Website:  ${parsed.website}`);
  ctx.out.line('  ' + '─'.repeat(50));

  if (!ctx.confirmed) {
    ctx.out.line(`  rerun with --confirm to create`);
    ctx.out.line('');
    return EXIT.CONFIRM;
  }

  let result;
  try {
    const r = await ctx.http.post(`/businesses/`, body);
    if (r.code === 401 || r.code === 403) {
      ctx.out.line('✖ businesses.write scope required — add in GHL Private Integrations');
      return EXIT.AUTH;
    }
    if (!r.ok) {
      ctx.out.line(`✖ API error ${r.code}: ${r.j?.message ?? r.j?.msg ?? 'unknown'}`);
      return EXIT.API;
    }
    result = r.j?.business ?? r.j;
  } catch (e) {
    ctx.out.warn(`could not create business: ${e.message}`);
    return EXIT.API;
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
      ctx.out.line('✖ businesses.readonly scope required');
      return EXIT.AUTH;
    }
    if (r.code === 404) {
      ctx.out.line(`✖ business not found: ${id}`);
      return EXIT.NOTFOUND;
    }
    if (!r.ok) {
      ctx.out.line(`✖ API error ${r.code}`);
      return EXIT.API;
    }
    biz = r.j?.business ?? r.j;
  } catch (e) {
    ctx.out.warn(`could not fetch business: ${e.message}`);
    return EXIT.API;
  }

  const name = biz?.name ?? id;

  ctx.out.line('');
  ctx.out.line('  DELETE BUSINESS');
  ctx.out.line('  ' + '─'.repeat(50));
  ctx.out.line(`  Name: ${name}`);
  ctx.out.line(`  ID:   ${id}`);
  ctx.out.line('  ' + '─'.repeat(50));
  ctx.out.line('  ⚠  This is permanent and cannot be undone.');

  if (!ctx.confirmed) {
    ctx.out.line(`  rerun with --confirm to delete`);
    ctx.out.line('');
    return EXIT.CONFIRM;
  }

  try {
    const r = await ctx.http.delete(`/businesses/${encodeURIComponent(id)}`);
    if (r.code === 401 || r.code === 403) {
      ctx.out.line('✖ businesses.write scope required');
      return EXIT.AUTH;
    }
    if (r.code === 404) {
      ctx.out.line(`✖ business not found (already deleted?): ${id}`);
      return EXIT.NOTFOUND;
    }
    if (!r.ok) {
      ctx.out.line(`✖ API error ${r.code}: ${r.j?.message ?? 'unknown'}`);
      return EXIT.API;
    }
  } catch (e) {
    ctx.out.warn(`could not delete business: ${e.message}`);
    return EXIT.API;
  }

  ctx.out.data({ deleted: true, id, name });
  ctx.out.line(`  ✓ deleted — "${name}"`);
  ctx.out.line('  Run sizmo sync businesses to refresh the local cache.\n');
  return EXIT.OK;
}

function pad(s, n) { return String(s ?? '').slice(0, n).padEnd(n); }

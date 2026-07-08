// commands/link.mjs — create OR delete a trigger link.
// Scope required: links.write
// delete is SINGLE-TARGET ONLY: resolves the exact link by id, names it in the preview, and
// DELETEs that one record — it can never bulk-delete. Matches commands/calendar.mjs's pattern.
//
// Added 2026-07-08 — found via search_operations: sizmo's `list links` was read-only even
// though GHL supports full CRUD here. describe_operation gave the real request body field names
// (name, redirectTo) before writing any code. Note the GET-single path has an unusual `/id/`
// segment (`/links/id/{linkId}`, not `/links/{linkId}`) — easy to guess wrong, verified via
// search_operations rather than assumed.
import { requireConfirm } from '../lib/confirm.mjs';
import { GhlError, EXIT } from '../lib/errors.mjs';

export const meta = {
  name: 'link',
  summary: 'create or delete a trigger link (delete is single-target, never bulk)',
  flags: [
    { name: '--name',       type: 'string', desc: 'link name (create)' },
    { name: '--redirect-to', type: 'string', desc: 'destination URL (create)' },
  ],
  readOnly: false,
};

const SCOPE_FIX = 'GoHighLevel → Settings → Private Integrations → edit your PIT → add links.write scope';

export async function run(args, ctx) {
  const sub = args._?.[0];
  if (sub === 'create') return createLink(args, ctx);
  if (sub === 'delete') return deleteLink(args, ctx);
  throw new GhlError('usage: sizmo link create --name "…" --redirect-to <url> | sizmo link delete <linkId>', EXIT.USAGE, 'sizmo link --help');
}

async function createLink(args, ctx) {
  const name = args.name;
  const redirectTo = args['redirect-to'];
  if (!name || !String(name).trim()) {
    throw new GhlError('link create needs --name', EXIT.USAGE, 'sizmo link create --name "Book a call" --redirect-to https://…');
  }
  if (!redirectTo || !String(redirectTo).trim()) {
    throw new GhlError('link create needs --redirect-to <url>', EXIT.USAGE, 'sizmo link create --name "Book a call" --redirect-to https://…');
  }

  const body = { locationId: ctx.cfg.loc, name: String(name), redirectTo: String(redirectTo) };
  const changes = [`Create trigger link "${name}"`, `  redirects to: ${redirectTo}`];
  const rerunCommand = `sizmo link create --name "${String(name).replace(/"/g, '\\"')}" --redirect-to "${redirectTo}" --confirm`;

  const gate = requireConfirm({ command: 'link create', changes, rerunCommand }, ctx);
  if (!gate.proceed) return gate.code;

  const r = await ctx.http.post('/links/', body);
  if (r.code === 401 || r.code === 403) throw new GhlError(`HTTP ${r.code} — your PIT lacks links.write`, EXIT.AUTH, SCOPE_FIX);
  if (!r.ok) throw new GhlError(`link create failed — HTTP ${r.code}: ${(r.txt || '').slice(0, 200).replace(/\s+/g, ' ')}`, EXIT.API);

  const created = r.j?.link ?? r.j ?? {};
  const id = created.id || created._id || null;
  ctx.out.data({ status: 'ok', command: 'link create', linkId: id, name: created.name ?? String(name) });
  ctx.out.line(`  link "${created.name ?? name}" created · id ${id ?? '(see response)'}`);
  return EXIT.OK;
}

async function deleteLink(args, ctx) {
  const id = args._?.[1];
  if (!id || !String(id).trim()) {
    throw new GhlError('usage: sizmo link delete <linkId> — exactly one id, never bulk', EXIT.USAGE, 'sizmo list links  # to find the id');
  }
  // SAFETY: fetch the single link first so the preview names it, and a wrong id 404s here
  // (nothing deleted) instead of touching anything. Note the unusual GET path: /links/id/{id}.
  // Unlike calendars/opportunities, this endpoint requires locationId as a query param —
  // verified live 2026-07-08: omitting it 400s "locationId is required", not a scope error.
  const got = await ctx.http.get(`/links/id/${encodeURIComponent(id)}`, { query: { locationId: ctx.cfg.loc } });
  if (got.code === 401 || got.code === 403) throw new GhlError(`HTTP ${got.code} — your PIT lacks links.write`, EXIT.AUTH, SCOPE_FIX);
  if (got.code === 404) throw new GhlError(`no link with id ${id} — nothing deleted`, EXIT.NOTFOUND);
  if (!got.ok) throw new GhlError(`link delete: could not read link ${id} — HTTP ${got.code}`, EXIT.API);
  const link = got.j?.link ?? got.j ?? {};
  const who = link.name || '(unnamed)';

  const changes = [
    `Delete trigger link "${who}" (id ${id})`,
    '  ⚠ removes THIS ONE link only — sizmo deletes a single record by id, never in bulk',
  ];
  const rerunCommand = `sizmo link delete ${id} --confirm`;
  const gate = requireConfirm({ command: 'link delete', changes, rerunCommand }, ctx);
  if (!gate.proceed) return gate.code;

  const r = await ctx.http.delete(`/links/${encodeURIComponent(id)}`);
  if (r.code === 401 || r.code === 403) throw new GhlError(`HTTP ${r.code} — your PIT lacks links.write`, EXIT.AUTH, SCOPE_FIX);
  if (!r.ok) throw new GhlError(`link delete failed — HTTP ${r.code}: ${(r.txt || '').slice(0, 200).replace(/\s+/g, ' ')}`, EXIT.API);

  ctx.out.data({ status: 'ok', command: 'link delete', linkId: id, name: who });
  ctx.out.line(`  link "${who}" (id ${id}) deleted`);
  return EXIT.OK;
}

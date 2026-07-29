// commands/value.mjs — create, update OR delete a custom value on the location.
// Scope required: locations/customValues.write
// delete is SINGLE-TARGET ONLY: resolves the exact value by id, names it in the preview, and
// DELETEs that one resource — it can never bulk-delete.
import { requireConfirm } from '../lib/confirm.mjs';
import { GhlError, EXIT } from '../lib/errors.mjs';

// The subcommand list, declared once so `sizmo schema` and the dispatch below cannot
// disagree. test/client/schema-subcommands.test.mjs extracts the verbs this file actually
// dispatches on and fails if they differ from this array.
const SUBCOMMANDS = ['create', 'update', 'delete'];

export const meta = {
  name: 'value',
  summary: 'create, update or delete a custom value (delete is single-target, never bulk)',
  subcommands: SUBCOMMANDS,
  flags: [
    { name: '--name',  type: 'string', desc: 'custom value name (create/update)' },
    { name: '--value', type: 'string', desc: 'the value (create/update)' },
  ],
  readOnly: false,
};

const SCOPE_FIX = 'GoHighLevel → Settings → Private Integrations → edit your PIT → add locations/customValues.write scope';

export async function run(args, ctx) {
  const sub = args._?.[0];
  if (sub === 'create') return createValue(args, ctx);
  if (sub === 'update') return updateValue(args, ctx);
  if (sub === 'delete') return deleteValue(args, ctx);
  throw new GhlError(
    'usage: sizmo value create … | sizmo value update <valueId> [--name] [--value] | sizmo value delete <valueId>',
    EXIT.USAGE, 'sizmo value --help');
}

async function createValue(args, ctx) {
  const name = args.name;
  const value = args.value;
  if (!name || !name.trim()) throw new GhlError('value create requires --name "<name>"', EXIT.USAGE);
  if (value == null || value === '') throw new GhlError('value create requires --value "<value>"', EXIT.USAGE);

  const body = { name, value: String(value) };
  const preview = String(value).length > 60 ? String(value).slice(0, 60) + '…' : value;
  const changes = [`Create custom value "${name}" = "${preview}"`];
  const rerunCommand = `sizmo value create --name "${name.replace(/"/g, '\\"')}" --value "${String(value).replace(/"/g, '\\"')}" --confirm`;

  const gate = requireConfirm({ command: 'value create', changes, rerunCommand }, ctx);
  if (!gate.proceed) return gate.code;

  const r = await ctx.http.post(`/locations/${encodeURIComponent(ctx.cfg.loc)}/customValues`, body);
  if (r.code === 401 || r.code === 403) throw new GhlError(`HTTP ${r.code} — your PIT lacks locations/customValues.write`, EXIT.AUTH, SCOPE_FIX);
  if (!r.ok) throw new GhlError(`value create failed — HTTP ${r.code}: ${(r.txt || '').slice(0, 200).replace(/\s+/g, ' ')}`, EXIT.API);

  const created = r.j?.customValue ?? r.j ?? {};
  const id = created.id || created._id || null;
  ctx.out.data({ status: 'ok', command: 'value create', valueId: id });
  ctx.out.line(`  custom value "${name}" created · id ${id ?? '(see response)'}`);
  return EXIT.OK;
}

// PUT /locations/{loc}/customValues/{id}. Added 2026-07-27 — sizmo had create + delete only, and
// the docs stated that as though it were an API limitation. It was not: the endpoint exists and
// needs the same locations/customValues.write scope create already requires.
//
// Why it matters more than a missing flag: a custom value IS the thing that changes — a booking
// link, a support number, an address, referenced across workflows and templates. The only way to
// edit one was delete-then-create, which mints a NEW id, breaks anything referencing the old one,
// and leaves a window where the value does not exist at all. That is a destructive workaround for
// what should be an edit.
//
// Fetch-first, like delete: the endpoint requires BOTH name and value, so changing only one still
// has to send the other. Reading current state first means `--value X` alone cannot silently blank
// the name, and the preview can show before → after rather than just the new state.
async function updateValue(args, ctx) {
  const id = args._?.[1];
  if (!id || !String(id).trim()) {
    throw new GhlError('usage: sizmo value update <valueId> [--name "..."] [--value "..."]', EXIT.USAGE,
      'sizmo list values  # to find the id');
  }
  if (args.name == null && args.value == null) {
    throw new GhlError('value update requires at least one of --name or --value', EXIT.USAGE);
  }

  const got = await ctx.http.get(`/locations/${encodeURIComponent(ctx.cfg.loc)}/customValues/${encodeURIComponent(id)}`);
  if (got.code === 401 || got.code === 403) {
    throw new GhlError(`HTTP ${got.code} — your PIT lacks locations/customValues.write`, EXIT.AUTH, SCOPE_FIX);
  }
  if (got.code === 404) throw new GhlError(`no custom value with id ${id} — nothing changed`, EXIT.NOTFOUND);
  if (!got.ok) throw new GhlError(`could not read custom value ${id} — HTTP ${got.code}`, EXIT.API);

  const current = got.j?.customValue ?? got.j ?? {};
  const oldName  = current.name ?? '';
  const oldValue = current.value ?? '';
  const name  = args.name  != null ? String(args.name)  : oldName;
  const value = args.value != null ? String(args.value) : oldValue;

  const trim = (v) => (String(v).length > 60 ? String(v).slice(0, 60) + '…' : String(v));
  const changes = [`Update custom value ${id}`];
  if (name !== oldName)   changes.push(`  name:  "${trim(oldName)}"  →  "${trim(name)}"`);
  else                    changes.push(`  name:  "${trim(oldName)}" (unchanged)`);
  if (value !== oldValue) changes.push(`  value: "${trim(oldValue)}"  →  "${trim(value)}"`);
  else                    changes.push(`  value: "${trim(oldValue)}" (unchanged)`);
  if (name === oldName && value === oldValue) {
    changes.push('  ⚠ nothing actually differs from the current value');
  }

  const parts = [`sizmo value update ${id}`];
  if (args.name  != null) parts.push(`--name "${String(args.name).replace(/"/g, '\\"')}"`);
  if (args.value != null) parts.push(`--value "${String(args.value).replace(/"/g, '\\"')}"`);
  const rerunCommand = parts.join(' ') + ' --confirm';

  const gate = requireConfirm({ command: 'value update', changes, rerunCommand }, ctx);
  if (!gate.proceed) return gate.code;

  // Both fields are required by the endpoint, so send both even when only one changed.
  const r = await ctx.http.put(
    `/locations/${encodeURIComponent(ctx.cfg.loc)}/customValues/${encodeURIComponent(id)}`,
    { name, value });
  if (r.code === 401 || r.code === 403) {
    throw new GhlError(`HTTP ${r.code} — your PIT lacks locations/customValues.write`, EXIT.AUTH, SCOPE_FIX);
  }
  if (r.code === 404) throw new GhlError(`no custom value with id ${id} — nothing changed`, EXIT.NOTFOUND);
  if (!r.ok) throw new GhlError(`value update failed — HTTP ${r.code}: ${(r.txt || '').slice(0, 200).replace(/\s+/g, ' ')}`, EXIT.API);

  ctx.out.data({ status: 'ok', command: 'value update', valueId: id, name, value });
  ctx.out.line(`  custom value ${id} updated — the id is unchanged, so anything referencing it still resolves`);
  return EXIT.OK;
}

async function deleteValue(args, ctx) {
  const id = args._?.[1];
  if (!id || !String(id).trim()) {
    throw new GhlError('usage: sizmo value delete <valueId> — exactly one id, never bulk', EXIT.USAGE, 'sizmo api "/locations/<loc>/customValues"  # to find the id');
  }
  const loc = ctx.cfg.loc;
  const list = await ctx.http.get(`/locations/${encodeURIComponent(loc)}/customValues`);
  if (list.code === 401 || list.code === 403) throw new GhlError(`HTTP ${list.code} — your PIT lacks locations/customValues.write`, EXIT.AUTH, SCOPE_FIX);
  if (!list.ok) throw new GhlError(`value delete: could not read custom values — HTTP ${list.code}`, EXIT.API);
  const values = list.j?.customValues ?? (Array.isArray(list.j) ? list.j : []);
  const target = values.find(v => (v.id || v._id) === id);
  if (!target) {
    throw new GhlError(`no custom value with id ${id} in this location — nothing deleted`, EXIT.NOTFOUND);
  }
  const name = target.name || '(unnamed)';

  const changes = [
    `Delete custom value "${name}" (id ${id})`,
    '  ⚠ removes THIS ONE value only — sizmo deletes a single resource by id, never in bulk',
  ];
  const rerunCommand = `sizmo value delete ${id} --confirm`;
  const gate = requireConfirm({ command: 'value delete', changes, rerunCommand }, ctx);
  if (!gate.proceed) return gate.code;

  const r = await ctx.http.delete(`/locations/${encodeURIComponent(loc)}/customValues/${encodeURIComponent(id)}`);
  if (r.code === 401 || r.code === 403) throw new GhlError(`HTTP ${r.code} — your PIT lacks locations/customValues.write`, EXIT.AUTH, SCOPE_FIX);
  if (!r.ok) throw new GhlError(`value delete failed — HTTP ${r.code}: ${(r.txt || '').slice(0, 200).replace(/\s+/g, ' ')}`, EXIT.API);

  ctx.out.data({ status: 'ok', command: 'value delete', valueId: id, name });
  ctx.out.line(`  custom value "${name}" (id ${id}) deleted`);
  return EXIT.OK;
}

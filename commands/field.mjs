// commands/field.mjs — create OR delete a custom field on the location.
// Scope required: locations/customFields.write
// NEVER fires without --confirm. delete is SINGLE-TARGET ONLY: it resolves the exact field by id,
// names it in the preview, and DELETEs that one resource — it can never bulk-delete.
import { requireConfirm } from '../lib/confirm.mjs';
import { GhlError, EXIT } from '../lib/errors.mjs';
import { parseNumericFlag } from '../lib/numeric.mjs';

// GHL customField dataTypes (v2). Kept as an allow-list so a typo fails locally, not after a round-trip.
const DATA_TYPES = new Set([
  'TEXT', 'LARGE_TEXT', 'NUMERICAL', 'PHONE', 'MONETORY', 'CHECKBOX',
  'SINGLE_OPTIONS', 'MULTIPLE_OPTIONS', 'DATE', 'TEXTBOX_LIST', 'FILE_UPLOAD', 'RADIO',
]);

export const meta = {
  name: 'field',
  summary: 'create or delete a custom field (delete is single-target, never bulk)',
  flags: [
    { name: '--name',  type: 'string', desc: 'field name (create)' },
    { name: '--type',  type: 'string', desc: `data type (create, default TEXT): ${[...DATA_TYPES].join(', ')}` },
    { name: '--model', type: 'string', desc: 'create: contact (default) | opportunity' },
    { name: '--placeholder', type: 'string', desc: 'placeholder text shown in the field (create)' },
    { name: '--position', type: 'number', desc: 'display order within the location (create)' },
    { name: '--textbox-option', type: 'string', desc: 'comma-separated options — REQUIRED for TEXTBOX_LIST' },
    { name: '--accept', type: 'string', desc: 'comma-separated file formats for FILE_UPLOAD, e.g. ".pdf,.docx"' },
    { name: '--multiple-files', type: 'bool', desc: 'FILE_UPLOAD: allow more than one file' },
    { name: '--max-files', type: 'number', desc: 'FILE_UPLOAD: maximum number of files' },
  ],
  readOnly: false,
};

const SCOPE_FIX = 'GoHighLevel → Settings → Private Integrations → edit your PIT → add locations/customFields.write scope';

export async function run(args, ctx) {
  const sub = args._?.[0];
  if (sub === 'create') return createField(args, ctx);
  if (sub === 'update') return updateField(args, ctx);
  if (sub === 'delete') return deleteField(args, ctx);
  throw new GhlError(
    'usage: sizmo field create … | sizmo field update <fieldId> [--name] [--placeholder] … | sizmo field delete <fieldId>',
    EXIT.USAGE, 'sizmo field --help');
}

async function createField(args, ctx) {
  const name = args.name;
  if (!name || !name.trim()) throw new GhlError('field create requires --name "<name>"', EXIT.USAGE);
  const dataType = (args.type || 'TEXT').toUpperCase();
  if (!DATA_TYPES.has(dataType)) {
    throw new GhlError(`field create: unknown --type '${args.type}' — one of: ${[...DATA_TYPES].join(', ')}`, EXIT.USAGE);
  }
  const model = (args.model || 'contact').toLowerCase();
  if (model !== 'contact' && model !== 'opportunity') {
    throw new GhlError(`field create: --model must be contact or opportunity (got '${args.model}')`, EXIT.USAGE);
  }

  // Types that are unusable without a choice list. sizmo's endpoint
  // (POST /locations/{id}/customFields) documents `textBoxListOptions` and nothing else for
  // options, so TEXTBOX_LIST can be populated but SINGLE_OPTIONS/MULTIPLE_OPTIONS/RADIO/CHECKBOX
  // cannot — the field name for their choices is not part of this endpoint's documented schema.
  //
  // Creating one anyway produced a field with NO choices: it appears in GHL, cannot be filled in,
  // and has to be repaired by hand in the UI. Refusing is more honest than shipping a broken
  // field silently. Same shape as the `calendar create --type round_robin` gap fixed in 2.4.9 —
  // a type the CLI let you pick but could not actually make work.
  const NEEDS_OPTIONS = new Set(['SINGLE_OPTIONS', 'MULTIPLE_OPTIONS', 'RADIO', 'CHECKBOX']);
  if (NEEDS_OPTIONS.has(dataType)) {
    throw new GhlError(
      `field create: ${dataType} needs a list of choices, which this endpoint does not accept from sizmo — ` +
      `creating it here would leave an empty, unusable field`,
      EXIT.USAGE,
      'create this field in GoHighLevel → Settings → Custom Fields, then `sizmo sync fields`');
  }

  const textboxOptions = args['textbox-option']
    ? String(args['textbox-option']).split(',').map(o => o.trim()).filter(Boolean)
    : null;
  if (dataType === 'TEXTBOX_LIST' && !textboxOptions?.length) {
    throw new GhlError(
      'field create: TEXTBOX_LIST requires --textbox-option "A,B,C" — without options the field is unusable',
      EXIT.USAGE,
      'sizmo field create --name "..." --type TEXTBOX_LIST --textbox-option "Small,Medium,Large" --confirm');
  }
  const accepted = args.accept
    ? String(args.accept).split(',').map(f => f.trim()).filter(Boolean)
    : null;

  // Validate BEFORE the confirm preview — Number('abc') is NaN, which JSON-serializes to null and
  // (on update) BLANKS the stored value. See lib/numeric.mjs.
  const position = args.position != null
    ? parseNumericFlag(args.position, { flag: '--position', context: 'field create', integer: true, min: 0, example: '3' })
    : null;
  const maxFiles = args['max-files'] != null
    ? parseNumericFlag(args['max-files'], { flag: '--max-files', context: 'field create', integer: true, min: 1, example: '5' })
    : null;

  const body = {
    name, dataType, model,
    ...(args.placeholder ? { placeholder: args.placeholder } : {}),
    ...(position != null ? { position } : {}),
    ...(textboxOptions ? { textBoxListOptions: textboxOptions } : {}),
    ...(accepted ? { acceptedFormat: accepted } : {}),
    ...(args['multiple-files'] ? { isMultipleFile: true } : {}),
    ...(maxFiles != null ? { maxNumberOfFiles: maxFiles } : {}),
  };
  const changes = [
    `Create custom field "${name}" (type ${dataType}, model ${model})`,
    ...(args.placeholder ? [`  placeholder: ${args.placeholder}`] : []),
    ...(textboxOptions ? [`  options:     ${textboxOptions.join(', ')}`] : []),
    ...(accepted ? [`  accepts:     ${accepted.join(', ')}`] : []),
    ...(args['multiple-files'] ? ['  multiple files: yes'] : []),
    ...(args['max-files'] != null ? [`  max files:   ${args['max-files']}`] : []),
    ...(args.position != null ? [`  position:    ${args.position}`] : []),
  ];
  const parts = [`sizmo field create --name "${name.replace(/"/g, '\\"')}" --type ${dataType} --model ${model}`];
  if (args.placeholder)         parts.push(`--placeholder "${String(args.placeholder).replace(/"/g, '\\"')}"`);
  if (args.position != null)    parts.push(`--position ${args.position}`);
  if (textboxOptions)           parts.push(`--textbox-option "${textboxOptions.join(',')}"`);
  if (accepted)                 parts.push(`--accept "${accepted.join(',')}"`);
  if (args['multiple-files'])   parts.push('--multiple-files');
  if (args['max-files'] != null) parts.push(`--max-files ${args['max-files']}`);
  const rerunCommand = parts.join(' ') + ' --confirm';

  const gate = requireConfirm({ command: 'field create', changes, rerunCommand }, ctx);
  if (!gate.proceed) return gate.code;

  const r = await ctx.http.post(`/locations/${encodeURIComponent(ctx.cfg.loc)}/customFields`, body);
  if (r.code === 401 || r.code === 403) throw new GhlError(`HTTP ${r.code} — your PIT lacks locations/customFields.write`, EXIT.AUTH, SCOPE_FIX);
  if (!r.ok) throw new GhlError(`field create failed — HTTP ${r.code}: ${(r.txt || '').slice(0, 200).replace(/\s+/g, ' ')}`, EXIT.API);

  const created = r.j?.customField ?? r.j ?? {};
  const id = created.id || created._id || null;
  ctx.out.data({ status: 'ok', command: 'field create', fieldId: id, dataType, model });
  ctx.out.line(`  custom field "${name}" created · id ${id ?? '(see response)'}`);
  return EXIT.OK;
}

// PUT /locations/{loc}/customFields/{id}. Same gap `value` had: create + delete only, so the only
// way to rename a field or fix its placeholder was delete-then-create — which mints a NEW field id
// AND DISCARDS EVERY VALUE ALREADY STORED IN IT ON EVERY CONTACT. Strictly worse than the custom
// value case: that lost references, this loses data.
//
// NOTE: dataType is deliberately absent. The update endpoint does not accept it — a field's type
// cannot be changed once created, because the stored values would no longer match it. `--type` on
// update is therefore rejected rather than silently ignored.
async function updateField(args, ctx) {
  const id = args._?.[1];
  if (!id || !String(id).trim()) {
    throw new GhlError('usage: sizmo field update <fieldId> [--name "..."] [--placeholder "..."]',
      EXIT.USAGE, 'sizmo list fields  # to find the id');
  }
  if (args.type != null) {
    throw new GhlError(
      'field update: a field\'s --type cannot be changed — the update endpoint does not accept dataType, ' +
      'because values already stored against the field would no longer match it',
      EXIT.USAGE,
      'create a new field with the type you want, migrate the values, then delete the old one');
  }

  const EDITABLE = ['name', 'placeholder', 'position', 'model', 'textbox-option', 'accept', 'multiple-files', 'max-files'];
  if (!EDITABLE.some(k => args[k] != null)) {
    throw new GhlError(`field update requires at least one of: ${EDITABLE.map(k => '--' + k).join(', ')}`, EXIT.USAGE);
  }

  // Validate numeric flags BEFORE the fetch, not merely before the confirm preview.
  // Number('abc') is NaN, which JSON-serializes to null and BLANKS the stored value on update
  // (see lib/numeric.mjs). These parsers need only `args`, so running them after the GET meant a
  // typo'd --position burned a pointless API round-trip and then reported exit 3 (AUTH) instead of
  // exit 2 (USAGE) whenever the token was also bad — the wrong cause, for a purely local mistake.
  // A local input error must never depend on, or be masked by, a network result.
  const position = args.position != null
    ? parseNumericFlag(args.position, { flag: '--position', context: 'field update', integer: true, min: 0, example: '3' })
    : null;
  const maxFiles = args['max-files'] != null
    ? parseNumericFlag(args['max-files'], { flag: '--max-files', context: 'field update', integer: true, min: 1, example: '5' })
    : null;

  const base = `/locations/${encodeURIComponent(ctx.cfg.loc)}/customFields/${encodeURIComponent(id)}`;
  const got = await ctx.http.get(base);
  if (got.code === 401 || got.code === 403) {
    throw new GhlError(`HTTP ${got.code} — your PIT lacks locations/customFields.write`, EXIT.AUTH, SCOPE_FIX);
  }
  if (got.code === 404) throw new GhlError(`no custom field with id ${id} — nothing changed`, EXIT.NOTFOUND);
  if (!got.ok) throw new GhlError(`could not read custom field ${id} — HTTP ${got.code}`, EXIT.API);

  const cur = got.j?.customField ?? got.j ?? {};
  const oldName = cur.name ?? '';
  // `name` is the endpoint's only REQUIRED body field, so it must be resent even when only the
  // placeholder is changing — otherwise the update would blank it.
  const name = args.name != null ? String(args.name) : oldName;
  if (!name.trim()) throw new GhlError('field update: resulting --name would be empty', EXIT.USAGE);

  const textboxOptions = args['textbox-option']
    ? String(args['textbox-option']).split(',').map(o => o.trim()).filter(Boolean) : null;
  const accepted = args.accept
    ? String(args.accept).split(',').map(f => f.trim()).filter(Boolean) : null;

  const body = {
    name,
    ...(args.placeholder != null ? { placeholder: String(args.placeholder) } : {}),
    ...(position != null ? { position } : {}),
    ...(args.model != null ? { model: String(args.model).toLowerCase() } : {}),
    ...(textboxOptions ? { textBoxListOptions: textboxOptions } : {}),
    ...(accepted ? { acceptedFormat: accepted } : {}),
    ...(args['multiple-files'] ? { isMultipleFile: true } : {}),
    ...(maxFiles != null ? { maxNumberOfFiles: maxFiles } : {}),
  };

  const changes = [`Update custom field ${id} (type ${cur.dataType ?? '?'} — unchanged, types cannot be edited)`];
  changes.push(args.name != null && name !== oldName
    ? `  name: "${oldName}"  →  "${name}"`
    : `  name: "${oldName}" (unchanged)`);
  if (args.placeholder != null) changes.push(`  placeholder: ${args.placeholder}`);
  if (args.position != null)    changes.push(`  position:    ${args.position}`);
  if (args.model != null)       changes.push(`  model:       ${args.model}`);
  if (textboxOptions)           changes.push(`  options:     ${textboxOptions.join(', ')}`);
  if (accepted)                 changes.push(`  accepts:     ${accepted.join(', ')}`);
  if (args['multiple-files'])   changes.push('  multiple files: yes');
  if (args['max-files'] != null) changes.push(`  max files:   ${args['max-files']}`);

  const parts = [`sizmo field update ${id}`];
  if (args.name != null)         parts.push(`--name "${String(args.name).replace(/"/g, '\\"')}"`);
  if (args.placeholder != null)  parts.push(`--placeholder "${String(args.placeholder).replace(/"/g, '\\"')}"`);
  if (args.position != null)     parts.push(`--position ${args.position}`);
  if (args.model != null)        parts.push(`--model ${args.model}`);
  if (textboxOptions)            parts.push(`--textbox-option "${textboxOptions.join(',')}"`);
  if (accepted)                  parts.push(`--accept "${accepted.join(',')}"`);
  if (args['multiple-files'])    parts.push('--multiple-files');
  if (args['max-files'] != null) parts.push(`--max-files ${args['max-files']}`);
  const rerunCommand = parts.join(' ') + ' --confirm';

  const gate = requireConfirm({ command: 'field update', changes, rerunCommand }, ctx);
  if (!gate.proceed) return gate.code;

  const r = await ctx.http.put(base, body);
  if (r.code === 401 || r.code === 403) {
    throw new GhlError(`HTTP ${r.code} — your PIT lacks locations/customFields.write`, EXIT.AUTH, SCOPE_FIX);
  }
  if (r.code === 404) throw new GhlError(`no custom field with id ${id} — nothing changed`, EXIT.NOTFOUND);
  if (!r.ok) throw new GhlError(`field update failed — HTTP ${r.code}: ${(r.txt || '').slice(0, 200).replace(/\s+/g, ' ')}`, EXIT.API);

  ctx.out.data({ status: 'ok', command: 'field update', fieldId: id, name });
  ctx.out.line(`  custom field ${id} updated — id unchanged, stored values preserved`);
  return EXIT.OK;
}

async function deleteField(args, ctx) {
  const id = args._?.[1];
  // SAFETY 1: exactly one id, required. An empty id must never reach the API (could hit the collection).
  if (!id || !String(id).trim()) {
    throw new GhlError('usage: sizmo field delete <fieldId> — exactly one id, never bulk', EXIT.USAGE, 'sizmo crm fields  # to find the id');
  }

  // SAFETY 2: resolve the EXACT field from the live list, so the preview names what you're deleting
  // and a wrong/nonexistent id stops here (NOTFOUND) instead of touching anything.
  const loc = ctx.cfg.loc;
  const list = await ctx.http.get(`/locations/${encodeURIComponent(loc)}/customFields`);
  if (list.code === 401 || list.code === 403) throw new GhlError(`HTTP ${list.code} — your PIT lacks locations/customFields.write`, EXIT.AUTH, SCOPE_FIX);
  if (!list.ok) throw new GhlError(`field delete: could not read custom fields — HTTP ${list.code}`, EXIT.API);
  const fields = list.j?.customFields ?? (Array.isArray(list.j) ? list.j : []);
  const target = fields.find(f => (f.id || f._id) === id);
  if (!target) {
    throw new GhlError(`no custom field with id ${id} in this location — nothing deleted`, EXIT.NOTFOUND, 'sizmo crm fields  # to see valid ids');
  }
  const name = target.name || '(unnamed)';

  const changes = [
    `Delete custom field "${name}" (id ${id})`,
    '  ⚠ removes THIS ONE field only — sizmo deletes a single resource by id, never in bulk',
  ];
  const rerunCommand = `sizmo field delete ${id} --confirm`;
  const gate = requireConfirm({ command: 'field delete', changes, rerunCommand }, ctx);
  if (!gate.proceed) return gate.code;

  // SAFETY 3: single-resource endpoint with the encoded id — never the collection path.
  const r = await ctx.http.delete(`/locations/${encodeURIComponent(loc)}/customFields/${encodeURIComponent(id)}`);
  if (r.code === 401 || r.code === 403) throw new GhlError(`HTTP ${r.code} — your PIT lacks locations/customFields.write`, EXIT.AUTH, SCOPE_FIX);
  if (!r.ok) throw new GhlError(`field delete failed — HTTP ${r.code}: ${(r.txt || '').slice(0, 200).replace(/\s+/g, ' ')}`, EXIT.API);

  ctx.out.data({ status: 'ok', command: 'field delete', fieldId: id, name });
  ctx.out.line(`  custom field "${name}" (id ${id}) deleted`);
  return EXIT.OK;
}

// commands/contact.mjs — create, upsert, OR delete a contact.
// Scope required: contacts.write
// upsert de-dupes on email/phone: matches an existing contact in the location and updates it, or
//   creates one if none matches — so a retrying agent can't spawn duplicate people.
// delete is SINGLE-TARGET ONLY: resolves the exact contact by id, names it in the preview, and
//   DELETEs that one record — it can never bulk-delete.
import { requireConfirm } from '../lib/confirm.mjs';
import { GhlError, EXIT } from '../lib/errors.mjs';

// The subcommand list, declared once so `sizmo schema` and the dispatch below cannot
// disagree. test/client/schema-subcommands.test.mjs extracts the verbs this file actually
// dispatches on and fails if they differ from this array.
const SUBCOMMANDS = ['create', 'upsert', 'update', 'delete'];

export const meta = {
  name: 'contact',
  summary: 'create, upsert (de-dupe on email/phone), or delete a contact (delete is single-target, never bulk)',
  subcommands: SUBCOMMANDS,
  flags: [
    { name: '--name',  type: 'string', desc: 'full name (create/upsert)' },
    { name: '--first', type: 'string', desc: 'first name (create/upsert)' },
    { name: '--last',  type: 'string', desc: 'last name (create/upsert)' },
    { name: '--email', type: 'string', desc: 'email address (create/upsert; upsert de-dupe key)' },
    { name: '--phone', type: 'string', desc: 'phone in E.164, e.g. +14155551234 (create/upsert; upsert de-dupe key)' },
    { name: '--tag',   type: 'string', desc: 'tag(s) to apply — comma-separated' },
    { name: '--source',        type: 'string', desc: 'lead provenance, e.g. "webinar-jul" (create/upsert)' },
    { name: '--assigned-user', type: 'string', desc: 'user id to own this contact — `sizmo list users`' },
    { name: '--company',       type: 'string', desc: 'company name (B2B)' },
    { name: '--timezone',      type: 'string', desc: 'IANA timezone, e.g. Asia/Manila — affects booking times' },
    { name: '--country',       type: 'string', desc: 'ISO country code, e.g. PH — affects phone normalisation' },
    { name: '--dnd',           type: 'bool',   desc: 'mark do-not-disturb: suppresses messaging to this contact' },
    { name: '--no-dnd',        type: 'bool',   desc: 'CLEAR do-not-disturb (update only) — makes the contact messageable again' },
    { name: '--website',       type: 'string', desc: 'website URL (update)' },
    { name: '--address',       type: 'string', desc: 'street address (update)' },
    { name: '--city',          type: 'string', desc: 'city (update)' },
    { name: '--state',         type: 'string', desc: 'state/region (update)' },
    { name: '--postal-code',   type: 'string', desc: 'postal code (update)' },
    { name: '--dob',           type: 'string', desc: 'date of birth YYYY-MM-DD (update)' },
  ],
  readOnly: false,
};

const SCOPE_FIX = 'GoHighLevel → Settings → Private Integrations → edit your PIT → add contacts.write scope';

export async function run(args, ctx) {
  const sub = args._?.[0];
  if (sub === 'create') return createContact(args, ctx);
  if (sub === 'upsert') return upsertContact(args, ctx);
  if (sub === 'update') return updateContact(args, ctx);
  if (sub === 'delete') return deleteContact(args, ctx);
  throw new GhlError('usage: sizmo contact create … | sizmo contact upsert --email|--phone … | sizmo contact update <contactId> … | sizmo contact delete <contactId>', EXIT.USAGE, 'sizmo contact --help');
}

// Shared so create and upsert cannot drift apart. They built identical bodies by copy-paste, which
// is how one of them would have quietly gained a field the other lacked — the same drift class the
// agent-doc guard exists for, just in code.
//
// POST /contacts/ accepts 23 body fields (verified via describe_operation); sizmo exposed 6. These
// are the ones that change what a contact IS rather than cosmetics: where it came from, who owns
// it, whether it may be contacted.
function optionalContactFields(args) {
  const dnd = !!args.dnd;
  return {
    ...(args.source        ? { source: args.source }             : {}),
    ...(args['assigned-user'] ? { assignedTo: args['assigned-user'] } : {}),
    ...(args.company       ? { companyName: args.company }       : {}),
    ...(args.timezone      ? { timezone: args.timezone }         : {}),
    ...(args.country       ? { country: args.country }           : {}),
    ...(dnd                ? { dnd: true }                       : {}),
  };
}

// Preview lines for the above. dnd gets its own wording because it is the compliance-relevant one:
// sizmo can create a contact AND message it, so importing an opted-out list with no way to mark
// do-not-disturb means those people get contacted.
function optionalContactChanges(args) {
  const out = [];
  if (args.source)             out.push(`  source:   ${args.source}`);
  if (args['assigned-user'])   out.push(`  assigned: ${args['assigned-user']}`);
  if (args.company)            out.push(`  company:  ${args.company}`);
  if (args.timezone)           out.push(`  timezone: ${args.timezone}`);
  if (args.country)            out.push(`  country:  ${args.country}`);
  if (args.dnd)                out.push(`  ⚠ DND ON — contact marked do-not-disturb, messaging suppressed`);
  return out;
}

const OPTIONAL_FLAG_PAIRS = (args) => [
  ['--source', args.source], ['--assigned-user', args['assigned-user']],
  ['--company', args.company], ['--timezone', args.timezone], ['--country', args.country],
];

async function createContact(args, ctx) {
  const { name, first, last, email, phone } = args;
  if (!email && !phone && !name && !first && !last) {
    throw new GhlError('contact create needs at least one of --email / --phone / --name / --first / --last', EXIT.USAGE);
  }
  const tags = args.tag ? String(args.tag).split(',').map(s => s.trim()).filter(Boolean) : undefined;

  const body = {
    locationId: ctx.cfg.loc,
    ...(name  ? { name } : {}),
    ...(first ? { firstName: first } : {}),
    ...(last  ? { lastName: last } : {}),
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(tags  ? { tags } : {}),
    ...optionalContactFields(args),
  };

  const who = [email, phone, name || [first, last].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
  const changes = [
    `Create contact: ${who || '(no identifying field)'}`,
    ...(tags ? [`  tags: ${tags.join(', ')}`] : []),
    ...optionalContactChanges(args),
  ];
  const parts = ['sizmo contact create'];
  for (const [flag, v] of [['--name', name], ['--first', first], ['--last', last], ['--email', email], ['--phone', phone], ['--tag', args.tag], ...OPTIONAL_FLAG_PAIRS(args)]) {
    if (v) parts.push(`${flag} "${String(v).replace(/"/g, '\\"')}"`);
  }
  if (args.dnd) parts.push('--dnd');
  const rerunCommand = parts.join(' ') + ' --confirm';

  const gate = requireConfirm({ command: 'contact create', changes, rerunCommand }, ctx);
  if (!gate.proceed) return gate.code;

  const r = await ctx.http.post('/contacts/', body);
  if (r.code === 401 || r.code === 403) throw new GhlError(`HTTP ${r.code} — your PIT lacks contacts.write`, EXIT.AUTH, SCOPE_FIX);
  if (!r.ok) throw new GhlError(`contact create failed — HTTP ${r.code}: ${(r.txt || '').slice(0, 200).replace(/\s+/g, ' ')}`, EXIT.API);

  const created = r.j?.contact ?? r.j ?? {};
  const id = created.id || created._id || null;
  ctx.out.data({ status: 'ok', command: 'contact create', contactId: id });
  ctx.out.line(`  contact created · id ${id ?? '(see response)'}`);
  return EXIT.OK;
}

async function upsertContact(args, ctx) {
  const { name, first, last, email, phone } = args;
  // upsert de-dupes on email/phone — one of them is the match key. Without it, upsert can't
  // tell "update existing" from "create new", so require at least one.
  if (!email && !phone) {
    throw new GhlError('contact upsert needs --email or --phone (the de-dupe key)', EXIT.USAGE, 'sizmo contact upsert --email you@co.com --name "Jane Doe"');
  }
  let tags = args.tag ? String(args.tag).split(',').map(s => s.trim()).filter(Boolean) : undefined;

  // GHL's /contacts/upsert treats `tags` as the COMPLETE desired list, not an addition — verified
  // live 2026-07-05: upserting an existing contact with --tag "x" replaced its entire existing tag
  // set with just ["x"]. Silently wiping a contact's tags is exactly the kind of accident this CLI
  // is supposed to be incapable of, so look the contact up first (same email/phone key upsert
  // itself matches on) and merge --tag's value into whatever tags it already has.
  let existingTags = [];
  let mergedWithExisting = false;
  if (tags) {
    const key = email || phone;
    const found = await ctx.http.get('/contacts/', { query: { locationId: ctx.cfg.loc, query: key, limit: 20 } });
    if (found.ok) {
      const match = (found.j?.contacts ?? []).find(c =>
        (email && c.email && c.email.toLowerCase() === email.toLowerCase()) ||
        (phone && c.phone === phone)
      );
      if (match?.tags?.length) {
        existingTags = match.tags;
        const merged = new Set([...existingTags, ...tags]);
        if (merged.size > tags.length) mergedWithExisting = true;
        tags = [...merged];
      }
    }
  }

  const body = {
    locationId: ctx.cfg.loc,
    ...(name  ? { name } : {}),
    ...(first ? { firstName: first } : {}),
    ...(last  ? { lastName: last } : {}),
    ...(email ? { email } : {}),
    ...(phone ? { phone } : {}),
    ...(tags  ? { tags } : {}),
    ...optionalContactFields(args),
  };

  const key = [email, phone].filter(Boolean).join(' · ');
  const who = [name || [first, last].filter(Boolean).join(' '), key].filter(Boolean).join(' · ');
  const changes = [
    `Upsert contact on ${email ? 'email' : 'phone'} ${email || phone}`,
    `  → updates the matching contact, or creates it if none exists: ${who}`,
    ...(tags ? [`  tags: ${tags.join(', ')}${mergedWithExisting ? ` (merged with ${existingTags.length} existing tag(s) — nothing removed)` : ''}`] : []),
    ...optionalContactChanges(args),
  ];
  const parts = ['sizmo contact upsert'];
  for (const [flag, v] of [['--name', name], ['--first', first], ['--last', last], ['--email', email], ['--phone', phone], ['--tag', args.tag], ...OPTIONAL_FLAG_PAIRS(args)]) {
    if (v) parts.push(`${flag} "${String(v).replace(/"/g, '\\"')}"`);
  }
  if (args.dnd) parts.push('--dnd');
  const rerunCommand = parts.join(' ') + ' --confirm';

  const gate = requireConfirm({ command: 'contact upsert', changes, rerunCommand }, ctx);
  if (!gate.proceed) return gate.code;

  const r = await ctx.http.post('/contacts/upsert', body);
  if (r.code === 401 || r.code === 403) throw new GhlError(`HTTP ${r.code} — your PIT lacks contacts.write`, EXIT.AUTH, SCOPE_FIX);
  if (!r.ok) throw new GhlError(`contact upsert failed — HTTP ${r.code}: ${(r.txt || '').slice(0, 200).replace(/\s+/g, ' ')}`, EXIT.API);

  const c = r.j?.contact ?? r.j ?? {};
  const id = c.id || c._id || null;
  // GHL returns `new: true` when it created, `false` when it updated an existing contact.
  const created = r.j?.new === true;
  ctx.out.data({ status: 'ok', command: 'contact upsert', contactId: id, created, updated: !created });
  ctx.out.line(`  contact ${created ? 'created' : 'updated'} · id ${id ?? '(see response)'}`);
  return EXIT.OK;
}

// PUT /contacts/{contactId}. Distinct from upsert, which people conflate: upsert MATCHES on
// email/phone and rewrites whatever it finds; update targets a contact you already hold the id for.
// Every sizmo read hands you contact ids (segment, focus, brief, triage), and until now there was
// no way to act on one — you had to know the contact's email and route through upsert instead.
//
// --tag is REFUSED here on purpose. The endpoint's own schema warns that `tags` "overwrites all
// tags", which is precisely the bug sizmo shipped in upsert and fixed in 2.4.7 (a contact with two
// existing tags was left with only the new one). `sizmo tag` uses the dedicated add/remove
// endpoints and cannot wipe history; routing there is the fix, not re-implementing the merge.
//
// --company is absent because the UPDATE endpoint does not accept companyName, though create does.
async function updateContact(args, ctx) {
  const id = args._?.[1];
  if (!id || !String(id).trim()) {
    throw new GhlError('usage: sizmo contact update <contactId> [--email] [--phone] [--first] …',
      EXIT.USAGE, 'sizmo segment --tag X   # to find contact ids');
  }
  if (args.tag != null) {
    throw new GhlError(
      'contact update does not take --tag: this endpoint OVERWRITES a contact\'s entire tag list, ' +
      'which would silently erase tags it did not know about',
      EXIT.USAGE,
      `sizmo tag ${id} --add "<tag>" --confirm   # adds without removing anything`);
  }
  if (args.company != null) {
    throw new GhlError(
      'contact update does not take --company — the update endpoint accepts no companyName field',
      EXIT.USAGE,
      'set it at creation with `sizmo contact create --company`, or edit the contact in GoHighLevel');
  }

  const FIELDS = {
    first: 'firstName', last: 'lastName', name: 'name', email: 'email', phone: 'phone',
    source: 'source', 'assigned-user': 'assignedTo', timezone: 'timezone', country: 'country',
    website: 'website', address: 'address1', city: 'city', state: 'state', 'postal-code': 'postalCode',
    dob: 'dateOfBirth',
  };
  const body = {};
  for (const [flag, apiField] of Object.entries(FIELDS)) {
    if (args[flag] != null) body[apiField] = String(args[flag]);
  }
  // dnd is tri-state on update: set it, clear it, or leave it alone. create only ever sets it,
  // because a new contact has nothing to clear.
  if (args.dnd) body.dnd = true;
  if (args['no-dnd']) body.dnd = false;
  if (args.dnd && args['no-dnd']) {
    throw new GhlError('contact update: --dnd and --no-dnd contradict each other', EXIT.USAGE);
  }
  if (Object.keys(body).length === 0) {
    throw new GhlError(
      `contact update requires at least one field to change: ${Object.keys(FIELDS).map(f => '--' + f).join(', ')}, --dnd, --no-dnd`,
      EXIT.USAGE);
  }

  // Fetch first: proves the id exists before writing, and lets the preview show what is being
  // replaced rather than only what it is being replaced with.
  const got = await ctx.http.get(`/contacts/${encodeURIComponent(id)}`);
  if (got.code === 401 || got.code === 403) throw new GhlError(`HTTP ${got.code} — your PIT lacks contacts.write`, EXIT.AUTH, SCOPE_FIX);
  if (got.code === 404) throw new GhlError(`no contact with id ${id} — nothing changed`, EXIT.NOTFOUND);
  if (!got.ok) throw new GhlError(`could not read contact ${id} — HTTP ${got.code}`, EXIT.API);
  const cur = got.j?.contact ?? got.j ?? {};

  const who = [cur.firstName, cur.lastName].filter(Boolean).join(' ') || cur.name || cur.email || id;
  const changes = [`Update contact ${id} (${who})`];
  for (const [flag, apiField] of Object.entries(FIELDS)) {
    if (args[flag] == null) continue;
    const before = cur[apiField];
    changes.push(`  ${apiField}: ${before ? `"${before}"  →  ` : ''}"${args[flag]}"`);
  }
  if (args.dnd)        changes.push('  ⚠ DND ON — this contact will stop receiving messages');
  if (args['no-dnd'])  changes.push('  ⚠ DND OFF — this contact becomes messageable again');
  changes.push('  (tags untouched — use `sizmo tag` to change them)');

  const parts = [`sizmo contact update ${id}`];
  for (const flag of Object.keys(FIELDS)) {
    if (args[flag] != null) parts.push(`--${flag} "${String(args[flag]).replace(/"/g, '\\"')}"`);
  }
  if (args.dnd)       parts.push('--dnd');
  if (args['no-dnd']) parts.push('--no-dnd');
  const rerunCommand = parts.join(' ') + ' --confirm';

  const gate = requireConfirm({ command: 'contact update', changes, rerunCommand }, ctx);
  if (!gate.proceed) return gate.code;

  const r = await ctx.http.put(`/contacts/${encodeURIComponent(id)}`, body);
  if (r.code === 401 || r.code === 403) throw new GhlError(`HTTP ${r.code} — your PIT lacks contacts.write`, EXIT.AUTH, SCOPE_FIX);
  if (r.code === 404) throw new GhlError(`no contact with id ${id} — nothing changed`, EXIT.NOTFOUND);
  if (!r.ok) throw new GhlError(`contact update failed — HTTP ${r.code}: ${(r.txt || '').slice(0, 200).replace(/\s+/g, ' ')}`, EXIT.API);

  ctx.out.data({ status: 'ok', command: 'contact update', contactId: id, changed: Object.keys(body) });
  ctx.out.line(`  contact ${id} updated — ${Object.keys(body).length} field(s), tags untouched`);
  return EXIT.OK;
}

async function deleteContact(args, ctx) {
  const id = args._?.[1];
  if (!id || !String(id).trim()) {
    throw new GhlError('usage: sizmo contact delete <contactId> — exactly one id, never bulk', EXIT.USAGE, 'sizmo segment …  # to find the id');
  }
  // SAFETY: fetch the single contact first so the preview names who you're deleting, and a wrong id
  // 404s here (nothing deleted) instead of touching anything.
  const got = await ctx.http.get(`/contacts/${encodeURIComponent(id)}`);
  if (got.code === 401 || got.code === 403) throw new GhlError(`HTTP ${got.code} — your PIT lacks contacts.write`, EXIT.AUTH, SCOPE_FIX);
  if (got.code === 404) throw new GhlError(`no contact with id ${id} — nothing deleted`, EXIT.NOTFOUND);
  if (!got.ok) throw new GhlError(`contact delete: could not read contact ${id} — HTTP ${got.code}`, EXIT.API);
  const c = got.j?.contact ?? got.j ?? {};
  const who = c.contactName || [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || c.phone || '(unnamed)';

  const changes = [
    `Delete contact "${who}" (id ${id})`,
    '  ⚠ removes THIS ONE contact only — sizmo deletes a single record by id, never in bulk',
  ];
  const rerunCommand = `sizmo contact delete ${id} --confirm`;
  const gate = requireConfirm({ command: 'contact delete', changes, rerunCommand }, ctx);
  if (!gate.proceed) return gate.code;

  const r = await ctx.http.delete(`/contacts/${encodeURIComponent(id)}`);
  if (r.code === 401 || r.code === 403) throw new GhlError(`HTTP ${r.code} — your PIT lacks contacts.write`, EXIT.AUTH, SCOPE_FIX);
  if (!r.ok) throw new GhlError(`contact delete failed — HTTP ${r.code}: ${(r.txt || '').slice(0, 200).replace(/\s+/g, ' ')}`, EXIT.API);

  ctx.out.data({ status: 'ok', command: 'contact delete', contactId: id, name: who });
  ctx.out.line(`  contact "${who}" (id ${id}) deleted`);
  return EXIT.OK;
}

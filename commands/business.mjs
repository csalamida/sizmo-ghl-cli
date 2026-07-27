// commands/business.mjs — B2B company (business) management.
// sizmo business list                            → list companies (from model cache)
// sizmo business create --name "Acme" [--email --phone --website --address --city --state
//                        --postal-code --country --description] --confirm
// sizmo business update <id> [same optional flags, plus --name] --confirm
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
  summary: 'manage B2B companies — list, create, update, delete',
  flags: [
    { name: '--name',        type: 'string', desc: 'company name (required on create)' },
    { name: '--email',       type: 'string', desc: 'company email' },
    { name: '--phone',       type: 'string', desc: 'company phone' },
    { name: '--website',     type: 'string', desc: 'company website URL' },
    { name: '--address',     type: 'string', desc: 'street address' },
    { name: '--city',        type: 'string', desc: 'city' },
    { name: '--state',       type: 'string', desc: 'state/region' },
    { name: '--postal-code', type: 'string', desc: 'postal code' },
    { name: '--country',     type: 'string', desc: 'ISO country code, e.g. PH' },
    { name: '--description', type: 'string', desc: 'company description' },
  ],
};

// Optional fields shared by create and update — one fact, one place.
//
// `create-business` and `update-business` accept the SAME ten fields (verified via
// describe_operation 2026-07-27). sizmo exposed only four of them: name, email, phone, website.
// The other six were never a decision — no comment justified the omission, and commands/contact.mjs
// already exposes exactly this address set, so the precedent for "address data is in scope" was
// already established elsewhere in the codebase.
//
// The `--postal-code` flag maps to the API's `postalCode`; the flag name matches contact's.
const OPTIONAL = [
  ['email',       'email'],
  ['phone',       'phone'],
  ['website',     'website'],
  ['address',     'address'],
  ['city',        'city'],
  ['state',       'state'],
  ['postal-code', 'postalCode'],
  ['country',     'country'],
  ['description', 'description'],
];

// Unset flags are OMITTED, never sent as null — a null here blanks the stored field.
function optionalFields(parsed) {
  const out = {};
  for (const [flag, apiKey] of OPTIONAL) {
    const v = parsed[flag];
    if (v != null && String(v).trim() !== '') out[apiKey] = v;
  }
  return out;
}

function optionalChanges(parsed) {
  return OPTIONAL
    .filter(([flag]) => parsed[flag] != null && String(parsed[flag]).trim() !== '')
    .map(([flag]) => `  ${(flag + ':').padEnd(13)} ${parsed[flag]}`);
}

function optionalRerunParts(parsed) {
  return OPTIONAL
    .filter(([flag]) => parsed[flag] != null && String(parsed[flag]).trim() !== '')
    .map(([flag]) => `--${flag} "${String(parsed[flag]).replace(/"/g, '\\"')}"`);
}

export async function run(parsed, ctx) {
  const sub = parsed._?.[0] ?? 'list';

  switch (sub) {
    case 'list':   return listBusinesses(ctx);
    case 'create': return createBusiness(parsed, ctx);
    case 'update': return updateBusiness(parsed, ctx);
    case 'delete': return deleteBusiness(parsed, ctx);
    default:
      // THROW, do not return. A returned exit code skips the CLI's error handler, so `--json`
      // emitted a success-shaped envelope (data:null, degraded:false, no error) on stdout while
      // exiting 2 — an agent parsing it saw a clean no-op. This file had the identical bug fixed
      // for its AUTH/API paths earlier; USAGE was missed because the guard only matched
      // `return EXIT.(AUTH|API)`.
      throw new GhlError(
        `unknown subcommand "${sub}" — valid: list | create | update | delete`,
        EXIT.USAGE, 'sizmo business --help');
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
    throw new GhlError('business create requires --name "<company>"', EXIT.USAGE,
      'sizmo business create --name "Acme Corp" --confirm');
  }

  const loc  = ctx.cfg.loc;
  const body = { name, locationId: loc, ...optionalFields(parsed) };

  const changes = [`Create business "${name}"`, ...optionalChanges(parsed)];
  const rerunParts = [
    `sizmo business create --name "${name.replace(/"/g, '\\"')}"`,
    ...optionalRerunParts(parsed),
  ];
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

// ── update ────────────────────────────────────────────────────────────────────
//
// Added 2026-07-27. `business` could create and delete but never EDIT: a typo'd company name could
// only be fixed by deleting and recreating, which drops the contact associations that make a
// business record useful in the first place. PUT /businesses/{id} has always existed
// (verified via describe_operation) — sizmo simply never exposed it.
//
// Follows the same shape as contact/field/value update: fetch first so the preview names the real
// record and a wrong id 404s before anything is written, then PUT only the flags actually passed.

async function updateBusiness(parsed, ctx) {
  const id = parsed._?.[1];
  if (!id || !String(id).trim()) {
    throw new GhlError('usage: sizmo business update <businessId> [--name] [--email] …', EXIT.USAGE,
      'sizmo business list  # to find the id');
  }

  const changed = optionalFields(parsed);
  const newName = parsed.name != null && String(parsed.name).trim() !== '' ? String(parsed.name).trim() : null;
  if (!newName && Object.keys(changed).length === 0) {
    throw new GhlError(
      `business update requires at least one field to change — one of: --name, ${OPTIONAL.map(([f]) => '--' + f).join(', ')}`,
      EXIT.USAGE);
  }

  // Fetch first: names the record in the preview, and a wrong id 404s before any write fires.
  const got = await ctx.http.get(`/businesses/${encodeURIComponent(id)}`);
  if (got.code === 401 || got.code === 403) {
    throw new GhlError(`HTTP ${got.code} — your PIT lacks businesses.readonly (needed to read the business before updating it)`,
      EXIT.AUTH, SCOPE_FIX_R);
  }
  if (got.code === 404) throw new GhlError(`no business with id ${id} — nothing changed`, EXIT.NOTFOUND);
  if (!got.ok) throw new GhlError(`could not read business ${id} — HTTP ${got.code}`, EXIT.API);

  const cur = got.j?.business ?? got.j ?? {};
  const oldName = cur.name ?? '(unnamed)';

  const body = { ...(newName ? { name: newName } : {}), ...changed };

  const changes = [
    `Update business "${oldName}" (id ${id})`,
    ...(newName ? [`  name:         ${newName}`] : []),
    ...optionalChanges(parsed),
  ];
  const rerunCommand = [
    `sizmo business update ${id}`,
    ...(newName ? [`--name "${newName.replace(/"/g, '\\"')}"`] : []),
    ...optionalRerunParts(parsed),
    '--confirm',
  ].join(' ');

  const gate = requireConfirm({ command: 'business update', changes, rerunCommand }, ctx);
  if (!gate.proceed) return gate.code;

  let result;
  try {
    const r = await ctx.http.put(`/businesses/${encodeURIComponent(id)}`, body);
    if (r.code === 401 || r.code === 403) {
      throw new GhlError(`HTTP ${r.code} — your PIT lacks businesses.write`, EXIT.AUTH, SCOPE_FIX_W);
    }
    if (r.code === 404) throw new GhlError(`no business with id ${id} — nothing changed`, EXIT.NOTFOUND);
    if (!r.ok) {
      throw new GhlError(`business update failed — HTTP ${r.code}: ${r.j?.message ?? r.j?.msg ?? 'unknown'}`, EXIT.API);
    }
    result = r.j?.business ?? r.j;
  } catch (e) {
    if (e instanceof GhlError) throw e;
    throw new GhlError(`could not update business: ${e.message}`, EXIT.API);
  }

  ctx.out.data({ status: 'ok', command: 'business update', id, name: result?.name ?? newName ?? oldName });
  ctx.out.line(`  ✓ business ${id} updated`);
  ctx.out.line('  Run sizmo sync businesses to refresh the local cache.\n');
  return EXIT.OK;
}

// ── delete ────────────────────────────────────────────────────────────────────

async function deleteBusiness(parsed, ctx) {
  const id = parsed._?.[1];
  if (!id || !String(id).trim()) {
    throw new GhlError('usage: sizmo business delete <businessId> — exactly one id, never bulk',
      EXIT.USAGE, 'sizmo business list  # to find the id');
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

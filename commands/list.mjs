// commands/list.mjs — friendly ID lookup for CRM entities.
// "I need the ID before I run the next command" workflow.
// sizmo list [calendars|pipelines|tags|fields|values|users]

import { GhlError, EXIT } from '../lib/errors.mjs';

const ENTITIES = [
  'calendars', 'pipelines', 'tags', 'fields', 'values', 'users',
  'forms', 'surveys', 'products', 'links', 'businesses', 'objects',
];

export const meta = {
  name: 'list',
  summary: 'look up CRM entity IDs with full context — calendars, pipelines, tags, fields, values, users',
  // The same array the dispatch validates against, so `sizmo schema` can never advertise an entity
  // this command rejects, or omit one it accepts. ENTITIES moved above meta to be initialised first.
  subcommands: ENTITIES,
  flags: [
    { name: '--all', type: 'bool', desc: 'show all items (skips truncation on tags/fields)' },
  ],
  readOnly: true,
};


export async function run(parsed, ctx) {
  const entity = parsed._?.[0];
  const showAll = !!parsed.all;

  if (entity && !ENTITIES.includes(entity)) {
    // THROW, not return. list's AUTH/API paths were converted to GhlError on 2026-07-27; this
    // USAGE path was missed, so `sizmo list frobnicate --json` still printed a success-shaped
    // envelope (data:null, degraded:false, no error) on stdout while exiting 2.
    throw new GhlError(`unknown entity "${entity}" — valid: ${ENTITIES.join(' | ')}`,
      EXIT.USAGE, 'sizmo list  # with no argument shows an overview');
  }

  // live-fetch-only entities (not model-backed)
  if (entity === 'values') return listValues(ctx);

  const model = await ctx.ensureModel();
  const ents = model?.entities ?? {};
  const userMap = buildUserMap(ents.users?.items ?? []);

  if (!entity) return showAll ? listAllExpanded(ents, userMap, ctx) : listOverview(ents, ctx);

  switch (entity) {
    case 'calendars':  return listCalendars(ents, userMap, ctx);
    case 'pipelines':  return listPipelines(ents, ctx);
    case 'tags':       return listTags(ents, showAll, ctx);
    case 'fields':     return listFields(ents, showAll, ctx);
    case 'users':      return listUsers(ents, ctx);
    case 'forms':      return listForms(ents, showAll, ctx);
    case 'surveys':    return listSurveys(ents, showAll, ctx);
    case 'products':   return listProducts(ents, showAll, ctx);
    case 'links':      return listLinks(ents, showAll, ctx);
    case 'businesses': return listBusinesses(ents, showAll, ctx);
    case 'objects':    return listObjects(ents, ctx);
  }
  return EXIT.OK;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function buildUserMap(users) {
  const map = {};
  for (const u of users) {
    if (u.id) map[u.id] = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.name || u.email || u.id;
  }
  return map;
}

function maxNameLen(items, fallback = 16) {
  return items.reduce((m, i) => Math.max(m, (i.name || '').length), fallback);
}

function pad(s, n) { return String(s ?? '').slice(0, n).padEnd(n); }

// ent: the blocked model entity ({ blocked: true, scope, httpCode? }) — httpCode present means
// a real (non-401/403) API error reached the PIT, which is NOT a scope issue even though sizmo's
// own sync marks it "blocked" the same way. Saying "needs <scope>" there would be actively wrong
// if the scope is already granted, and EXIT.AUTH would send an agent chasing a permissions fix
// for what's actually a sizmo/API bug.
// THROWS rather than returns. A printed line plus a returned exit code never reaches the CLI's
// error handler, so `--json` emitted a success-shaped envelope on a hard 401 — degraded:false,
// warnings:[], no error, no remediation. An agent parsing that saw a clean empty result; only the
// exit code disagreed. Same fix business.mjs got; this helper covers all 12 `list` entities at once.
function blockedExit(entity, ent, ctx) {
  if (ent?.httpCode) {
    throw new GhlError(
      `${entity} — API error ${ent.httpCode} (not a scope issue — please report this)`, EXIT.API);
  }
  const scope = ent?.scope ?? null;
  throw new GhlError(
    `${entity} blocked — your PIT lacks ${scope ?? 'the required scope'}`,
    EXIT.AUTH,
    scope ? `GoHighLevel → Settings → Private Integrations → edit your PIT → add ${scope} scope`
          : 'GoHighLevel → Settings → Private Integrations → check this entity\'s scope');
}

// Distinguish "never synced" from "genuinely empty after sync"
function notSyncedExit(entity, ctx) {
  ctx.out.line(`  ${entity} not in local cache — run \`sizmo sync\` first`);
  return EXIT.OK;
}

// ── overview (bare list, no `sizmo list`) ─────────────────────────────────────

// The entity index, declared once. Both the TTY table and the --json payload are rendered from
// this, because they used to be two different things: the human got all twelve rows with counts
// and the exact command for each, and `sizmo list --json` emitted
//     { data: null, degraded: false, warnings: [] }  exit 0
// which is a success-shaped envelope carrying nothing. Both SKILL.md and AGENTS.md tell an agent to
// run `sizmo list` first, so the one command written to orient an agent was the one that told it
// nothing at all. Verified 2026-07-30.
const OVERVIEW = [
  { group: 'CRM ENTITIES',        label: 'Pipelines',      key: 'pipelines',    cmd: 'pipelines' },
  { group: 'CRM ENTITIES',        label: 'Calendars',      key: 'calendars',    cmd: 'calendars' },
  { group: 'CRM ENTITIES',        label: 'Tags',           key: 'tags',         cmd: 'tags' },
  { group: 'CRM ENTITIES',        label: 'Custom Fields',  key: 'customFields', cmd: 'fields' },
  { group: 'CRM ENTITIES',        label: 'Custom Values',  key: null,           cmd: 'values',     live: true },
  { group: 'CRM ENTITIES',        label: 'Users',          key: 'users',        cmd: 'users' },
  { group: 'CONTENT & COMMERCE',  label: 'Forms',          key: 'forms',        cmd: 'forms' },
  { group: 'CONTENT & COMMERCE',  label: 'Surveys',        key: 'surveys',      cmd: 'surveys' },
  { group: 'CONTENT & COMMERCE',  label: 'Products',       key: 'products',     cmd: 'products' },
  { group: 'CONTENT & COMMERCE',  label: 'Trigger Links',  key: 'links',        cmd: 'links' },
  { group: 'B2B & STRUCTURE',     label: 'Businesses',     key: 'businesses',   cmd: 'businesses' },
  { group: 'B2B & STRUCTURE',     label: 'Custom Objects', key: 'objects',      cmd: 'objects' },
];

function listOverview(ents, ctx) {
  // One pass over the table produces the machine rows; the TTY table is printed from the same ones.
  const rows = OVERVIEW.map(({ group, label, key, cmd, live }) => {
    const ent = key ? ents[key] : null;
    const blocked = !!ent?.blocked;
    return {
      entity: cmd,
      label,
      group,
      // `null` count means UNKNOWN (blocked, or fetched live) — never 0. A blocked entity with
      // count 0 would read as "this account has no tags" when the truth is "cannot see tags".
      count: live || blocked || !ent ? null : (ent.items ?? []).length,
      live: !!live,
      blocked,
      ...(blocked && { scope: ent?.scope ?? null, httpCode: ent?.httpCode ?? null }),
      command: `sizmo list ${cmd}`,
    };
  });
  ctx.out.data({ entities: rows, syncCommand: 'sizmo sync' });
  // degraded, because the index itself is incomplete: an entity marked blocked has an UNKNOWN
  // count, not a count of zero. The exit code stays 0 — rendering the index succeeded, and naming
  // what cannot be seen is the useful answer, not a failure.
  for (const r of rows) {
    if (r.blocked) ctx.out.warn(`${r.label} blocked — ${r.scope ? `PIT lacks ${r.scope}` : 'check scope'}`, { degraded: true });
  }

  const row = (r) => {
    // ✖ means "blocked, missing scope" everywhere else in this CLI — never reuse it for
    // "not cached, fetched live on demand." That's a different, non-error state.
    const display = r.live ? '   ·' : (r.count != null ? String(r.count).padStart(4) : '  ✖');
    ctx.out.line(`  ${pad(r.label, 16)}${display}    ${r.command}${r.live ? '  (live)' : ''}`);
  };
  let lastGroup = null;
  for (const r of rows) {
    if (r.group !== lastGroup) {
      ctx.out.line('');
      ctx.out.line(`  ${r.group}`);
      ctx.out.line('  ' + '─'.repeat(58));
      lastGroup = r.group;
    }
    row(r);
  }
  ctx.out.line('  ' + '─'.repeat(58));
  ctx.out.line('  Run sizmo sync to refresh all entities.\n');
  return EXIT.OK;
}

function listAllExpanded(ents, userMap, ctx) {
  listPipelines(ents, ctx);
  listCalendars(ents, userMap, ctx);
  listTags(ents, true, ctx);
  listFields(ents, true, ctx);
  listUsers(ents, ctx);
  listForms(ents, true, ctx);
  listSurveys(ents, true, ctx);
  listProducts(ents, true, ctx);
  listLinks(ents, true, ctx);
  listBusinesses(ents, true, ctx);
  listObjects(ents, ctx);
  return EXIT.OK;
}

// ── calendars ─────────────────────────────────────────────────────────────────

function listCalendars(ents, userMap, ctx) {
  if (ents.calendars?.blocked) return blockedExit('calendars', ents.calendars, ctx);
  const items = ents.calendars?.items ?? [];

  const nw = Math.min(30, maxNameLen(items, 14) + 2);
  const idW = 26;

  ctx.out.data({ entity: 'calendars', items });

  ctx.out.line('');
  ctx.out.line(`  CALENDARS (${items.length})`);
  ctx.out.line('  ' + '─'.repeat(nw + idW + 28));
  ctx.out.line(`  ${pad('Name', nw)}  ${pad('Calendar ID', idW)}  Staff`);
  ctx.out.line('  ' + '─'.repeat(nw + idW + 28));

  for (const c of items) {
    const memberIds = (c.teamMembers ?? []).map(m => m.userId ?? m.id ?? m).filter(Boolean);
    const staff = memberIds.length
      ? memberIds.map(id => userMap[id] || id).join(', ')
      : '—';
    const type = c.calendarType ? `  [${c.calendarType}]` : '';
    ctx.out.line(`  ${pad(c.name, nw)}  ${pad(c.id, idW)}  ${staff}${type}`);
  }

  ctx.out.line('  ' + '─'.repeat(nw + idW + 28));
  ctx.out.line('  Copy Calendar ID → sizmo appointment book --calendar <id> --contact <id> --start ISO8601\n');
  return EXIT.OK;
}

// ── pipelines ─────────────────────────────────────────────────────────────────

function listPipelines(ents, ctx) {
  if (ents.pipelines?.blocked) return blockedExit('pipelines', ents.pipelines, ctx);
  const items = ents.pipelines?.items ?? [];

  ctx.out.data({ entity: 'pipelines', items });

  ctx.out.line('');
  ctx.out.line(`  PIPELINES (${items.length})`);
  ctx.out.line('  ' + '─'.repeat(70));

  for (const p of items) {
    ctx.out.line(`  ${pad(p.name, 32)}  ${p.id || ''}`);
    for (const s of (p.stages ?? [])) {
      const pos = String(s.position ?? '').padStart(2);
      ctx.out.line(`    [${pos}] ${pad(s.name, 30)}  ${s.id || ''}`);
    }
  }

  ctx.out.line('  ' + '─'.repeat(70));
  ctx.out.line('  Copy Stage ID → sizmo opp move <oppId> --stage <stageId> --confirm\n');
  return EXIT.OK;
}

// WHY every `truncated` below is literally false
// `items` here carries the COMPLETE set; `shown` exists only to cut the terminal listing. These
// used to emit `truncated: shown.length < items.length`, i.e. "the TTY was cut" — which is the
// opposite of what `truncated` means everywhere else in this codebase (paginate, pipeline,
// snapshot, noshow all use it for "the DATA is incomplete, treat this as a floor"). A JSON caller
// therefore saw items.length === total alongside truncated:true, a self-contradiction, and would
// either re-request data it already had or distrust a complete answer. crm had the mirror-image
// bug: it sent the 20-item subset under the same flag. Both now mean one thing tool-wide, and the
// terminal still prints its "… N more — --all to show all" hint. Unified 2026-07-30.

// ── tags ─────────────────────────────────────────────────────────────────────

function listTags(ents, showAll, ctx) {
  if (ents.tags?.blocked) return blockedExit('tags', ents.tags, ctx);
  const items = ents.tags?.items ?? [];
  const shown = showAll ? items : items.slice(0, 40);

  ctx.out.data({ entity: 'tags', items, total: items.length, truncated: false });

  ctx.out.line('');
  ctx.out.line(`  TAGS (${items.length})`);
  ctx.out.line('  ' + '─'.repeat(40));

  for (const t of shown) {
    const name = typeof t === 'string' ? t : (t.name || '');
    ctx.out.line(`  ${name}`);
  }

  if (shown.length < items.length) ctx.out.line(`  … ${items.length - shown.length} more — --all to show all`);
  ctx.out.line('  ' + '─'.repeat(40));
  ctx.out.line('  Copy tag name → sizmo tag <contactId> --add <name> --confirm\n');
  return EXIT.OK;
}

// ── custom fields ─────────────────────────────────────────────────────────────

function listFields(ents, showAll, ctx) {
  if (ents.customFields?.blocked) return blockedExit('custom fields', ents.customFields, ctx);
  const items = ents.customFields?.items ?? [];
  const shown = showAll ? items : items.slice(0, 30);

  const nw = Math.min(30, maxNameLen(items, 14) + 2);
  const idW = 26;

  ctx.out.data({ entity: 'customFields', items, total: items.length, truncated: false });

  ctx.out.line('');
  ctx.out.line(`  CUSTOM FIELDS (${items.length})`);
  ctx.out.line('  ' + '─'.repeat(nw + idW + 26));
  ctx.out.line(`  ${pad('Name', nw)}  ${pad('Field ID', idW)}  Type        Model`);
  ctx.out.line('  ' + '─'.repeat(nw + idW + 26));

  for (const f of shown) {
    const type = pad(f.dataType || f.type || '—', 10);
    const model = f.model || '—';
    ctx.out.line(`  ${pad(f.name, nw)}  ${pad(f.id, idW)}  ${type}  ${model}`);
  }

  if (shown.length < items.length) ctx.out.line(`  … ${items.length - shown.length} more — --all to show all`);
  ctx.out.line('  ' + '─'.repeat(nw + idW + 26));
  ctx.out.line('  Copy Field ID → sizmo field delete <id> --confirm\n');
  return EXIT.OK;
}

// ── custom values (live fetch — not in model cache) ───────────────────────────

async function listValues(ctx) {
  let values = [];
  try {
    const r = await ctx.http.get(`/locations/${encodeURIComponent(ctx.cfg.loc)}/customValues`);
    if (r.code === 401 || r.code === 403) return blockedExit('custom values', { scope: 'locations/customValues.readonly' }, ctx);
    values = r.j?.customValues ?? [];
  } catch (e) {
    // blockedExit throws now, so let its GhlError through rather than flattening it into a
    // generic API error and losing the scope remediation.
    if (e instanceof GhlError) throw e;
    throw new GhlError(`could not fetch custom values: ${e.message}`, EXIT.API);
  }

  const nw = Math.min(30, values.reduce((m, v) => Math.max(m, (v.name || '').length), 14) + 2);
  const idW = 26;

  ctx.out.data({ entity: 'customValues', items: values });

  ctx.out.line('');
  ctx.out.line(`  CUSTOM VALUES (${values.length})`);
  ctx.out.line('  ' + '─'.repeat(nw + idW + 44));
  ctx.out.line(`  ${pad('Name', nw)}  ${pad('Value ID', idW)}  Current value`);
  ctx.out.line('  ' + '─'.repeat(nw + idW + 44));

  for (const v of values) {
    const val = String(v.value ?? '').slice(0, 42);
    ctx.out.line(`  ${pad(v.name, nw)}  ${pad(v.id, idW)}  "${val}"`);
  }

  ctx.out.line('  ' + '─'.repeat(nw + idW + 44));
  ctx.out.line('  Copy Value ID → sizmo value update <id> --value "..." --confirm\n');
  return EXIT.OK;
}

// ── users ─────────────────────────────────────────────────────────────────────

function listUsers(ents, ctx) {
  if (ents.users?.blocked) return blockedExit('users', ents.users, ctx);
  const items = ents.users?.items ?? [];

  ctx.out.data({ entity: 'users', items });

  ctx.out.line('');
  ctx.out.line(`  USERS (${items.length})`);
  ctx.out.line('  ' + '─'.repeat(80));
  ctx.out.line(`  ${pad('Name', 24)}  ${pad('Email', 32)}  User ID`);
  ctx.out.line('  ' + '─'.repeat(80));

  for (const u of items) {
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.name || u.id;
    ctx.out.line(`  ${pad(name, 24)}  ${pad(u.email || '—', 32)}  ${u.id || ''}`);
  }

  ctx.out.line('  ' + '─'.repeat(80));
  ctx.out.line('  User IDs appear in calendar staff lists and appointment assignments.\n');
  return EXIT.OK;
}

// ── forms ─────────────────────────────────────────────────────────────────────

function listForms(ents, showAll, ctx) {
  if (!ents.forms) return notSyncedExit('forms', ctx);
  if (ents.forms?.blocked) return blockedExit('forms', ents.forms, ctx);
  const items = ents.forms?.items ?? [];
  const shown = showAll ? items : items.slice(0, 30);

  const nw = Math.min(36, maxNameLen(items, 14) + 2);
  const idW = 26;

  ctx.out.data({ entity: 'forms', items, total: items.length, truncated: false });

  ctx.out.line('');
  ctx.out.line(`  FORMS (${items.length})`);
  ctx.out.line('  ' + '─'.repeat(nw + idW + 10));
  ctx.out.line(`  ${pad('Name', nw)}  ${pad('Form ID', idW)}`);
  ctx.out.line('  ' + '─'.repeat(nw + idW + 10));

  for (const f of shown) {
    ctx.out.line(`  ${pad(f.name, nw)}  ${pad(f.id, idW)}`);
  }

  if (shown.length < items.length) ctx.out.line(`  … ${items.length - shown.length} more — --all to show all`);
  ctx.out.line('  ' + '─'.repeat(nw + idW + 10));
  ctx.out.line('  Copy Form ID → sizmo forms <formId>  (view recent submissions)\n');
  return EXIT.OK;
}

// ── surveys ───────────────────────────────────────────────────────────────────

function listSurveys(ents, showAll, ctx) {
  if (!ents.surveys) return notSyncedExit('surveys', ctx);
  if (ents.surveys?.blocked) return blockedExit('surveys', ents.surveys, ctx);
  const items = ents.surveys?.items ?? [];
  const shown = showAll ? items : items.slice(0, 30);

  const nw = Math.min(36, maxNameLen(items, 14) + 2);
  const idW = 26;

  ctx.out.data({ entity: 'surveys', items, total: items.length, truncated: false });

  ctx.out.line('');
  ctx.out.line(`  SURVEYS (${items.length})`);
  ctx.out.line('  ' + '─'.repeat(nw + idW + 10));
  ctx.out.line(`  ${pad('Name', nw)}  ${pad('Survey ID', idW)}`);
  ctx.out.line('  ' + '─'.repeat(nw + idW + 10));

  for (const s of shown) {
    ctx.out.line(`  ${pad(s.name, nw)}  ${pad(s.id, idW)}`);
  }

  if (shown.length < items.length) ctx.out.line(`  … ${items.length - shown.length} more — --all to show all`);
  ctx.out.line('  ' + '─'.repeat(nw + idW + 10));
  ctx.out.line('  Copy Survey ID → sizmo surveys <surveyId>  (view recent submissions)\n');
  return EXIT.OK;
}

// ── products ──────────────────────────────────────────────────────────────────

function listProducts(ents, showAll, ctx) {
  if (!ents.products) return notSyncedExit('products', ctx);
  if (ents.products?.blocked) return blockedExit('products', ents.products, ctx);
  const items = ents.products?.items ?? [];
  const shown = showAll ? items : items.slice(0, 30);

  const nw = Math.min(34, maxNameLen(items, 14) + 2);
  const idW = 26;

  ctx.out.data({ entity: 'products', items, total: items.length, truncated: false });

  ctx.out.line('');
  ctx.out.line(`  PRODUCTS (${items.length})`);
  ctx.out.line('  ' + '─'.repeat(nw + idW + 22));
  ctx.out.line(`  ${pad('Name', nw)}  ${pad('Product ID', idW)}  Type`);
  ctx.out.line('  ' + '─'.repeat(nw + idW + 22));

  for (const p of shown) {
    const type = p.productType || p.type || '—';
    ctx.out.line(`  ${pad(p.name, nw)}  ${pad(p.id, idW)}  ${type}`);
  }

  if (shown.length < items.length) ctx.out.line(`  … ${items.length - shown.length} more — --all to show all`);
  ctx.out.line('  ' + '─'.repeat(nw + idW + 22));
  ctx.out.line('  Product IDs used in invoice line items and order fulfillment.\n');
  return EXIT.OK;
}

// ── trigger links ─────────────────────────────────────────────────────────────

function listLinks(ents, showAll, ctx) {
  if (!ents.links) return notSyncedExit('trigger links', ctx);
  if (ents.links?.blocked) return blockedExit('trigger links', ents.links, ctx);
  const items = ents.links?.items ?? [];
  const shown = showAll ? items : items.slice(0, 30);

  const nw = Math.min(34, maxNameLen(items, 14) + 2);
  const idW = 26;

  ctx.out.data({ entity: 'links', items, total: items.length, truncated: false });

  ctx.out.line('');
  ctx.out.line(`  TRIGGER LINKS (${items.length})`);
  ctx.out.line('  ' + '─'.repeat(nw + idW + 10));
  ctx.out.line(`  ${pad('Name', nw)}  ${pad('Link ID', idW)}`);
  ctx.out.line('  ' + '─'.repeat(nw + idW + 10));

  for (const l of shown) {
    ctx.out.line(`  ${pad(l.name, nw)}  ${pad(l.id, idW)}`);
  }

  if (shown.length < items.length) ctx.out.line(`  … ${items.length - shown.length} more — --all to show all`);
  ctx.out.line('  ' + '─'.repeat(nw + idW + 10));
  ctx.out.line('  Trigger links fire a workflow when clicked by a contact.\n');
  return EXIT.OK;
}

// ── businesses (B2B companies) ─────────────────────────────────────────────────

function listBusinesses(ents, showAll, ctx) {
  if (!ents.businesses) return notSyncedExit('businesses', ctx);
  if (ents.businesses?.blocked) return blockedExit('businesses', ents.businesses, ctx);
  const items = ents.businesses?.items ?? [];
  const shown = showAll ? items : items.slice(0, 30);

  const nw = Math.min(30, maxNameLen(items, 14) + 2);
  const idW = 26;

  ctx.out.data({ entity: 'businesses', items, total: items.length, truncated: false });

  ctx.out.line('');
  ctx.out.line(`  BUSINESSES (${items.length})`);
  ctx.out.line('  ' + '─'.repeat(nw + idW + 36));
  ctx.out.line(`  ${pad('Name', nw)}  ${pad('Business ID', idW)}  Website`);
  ctx.out.line('  ' + '─'.repeat(nw + idW + 36));

  for (const b of shown) {
    const site = pad(b.website || '—', 30);
    ctx.out.line(`  ${pad(b.name, nw)}  ${pad(b.id, idW)}  ${site}`);
  }

  if (shown.length < items.length) ctx.out.line(`  … ${items.length - shown.length} more — --all to show all`);
  ctx.out.line('  ' + '─'.repeat(nw + idW + 36));
  ctx.out.line('  Copy Business ID → sizmo business delete <id> --confirm\n');
  return EXIT.OK;
}

// ── custom objects (schema layer) ─────────────────────────────────────────────

function listObjects(ents, ctx) {
  if (!ents.objects) return notSyncedExit('custom objects', ctx);
  if (ents.objects?.blocked) return blockedExit('custom objects', ents.objects, ctx);
  const items = ents.objects?.items ?? [];

  ctx.out.data({ entity: 'objects', items });

  ctx.out.line('');
  ctx.out.line(`  CUSTOM OBJECTS (${items.length})`);
  ctx.out.line('  ' + '─'.repeat(72));
  ctx.out.line(`  ${pad('Label', 24)}  ${pad('Object Key / ID', 32)}  Fields`);
  ctx.out.line('  ' + '─'.repeat(72));

  for (const o of items) {
    const label = o.labels?.singular || o.label || o.key || '—';
    const key   = o.key || o.id || '—';
    const fieldCount = (o.fields ?? []).length || '—';
    ctx.out.line(`  ${pad(label, 24)}  ${pad(key, 32)}  ${fieldCount}`);
  }

  ctx.out.line('  ' + '─'.repeat(72));
  ctx.out.line('  Custom object records → GHL UI or direct API. Key used in API path.\n');
  return EXIT.OK;
}

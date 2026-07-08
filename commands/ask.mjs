// commands/ask.mjs — natural language → sizmo command resolver AND executor.
// Requires an AI key in profile: sizmo config set --profile <name> --ai-key <key>
//
// EXECUTION MODEL (the point of this file):
//   - Bare command matches (brief/doctor/list forms/etc) skip the LLM entirely — lib/quick-match.mjs.
//   - READS always execute immediately and print real output. No --confirm needed (same as running
//     the command directly), no risk (nothing mutates).
//   - WRITES go through preview → confirm → fire, same guarantee the rest of the CLI has, but the
//     confirm leg NEVER re-resolves via the LLM or re-runs a live search. The first (unconfirmed)
//     call resolves every name to a real id, caches that EXACT concretized plan locally
//     (lib/ask-memory.mjs), and `--confirm` replays that cached plan verbatim. This is what
//     guarantees "what you previewed is what fires" even though you typed a name, not an id.
//   - Multi-step asks ("tag her VIP and book Friday") are one batch: every step resolves before
//     anything executes; a single --confirm fires the whole ordered batch; the first failure
//     stops the rest.
//   - sizmo ask never sends your PIT, contacts, or money data to the LLM. Only your request text
//     and CRM *structure* (pipeline/calendar/tag/form/survey/business names+ids) leave the
//     machine. Pronoun follow-ups ("her", "that deal") are resolved via a local-only placeholder
//     substitution — the LLM only ever sees the literal token "<recent-contact>", never a real
//     name or id. See SECURITY.md.
//   - invoice draft/send, appointment book/cancel, and opp update are NOT auto-fired — sizmo ask
//     resolves and prints the exact deterministic command for you to run yourself (money and
//     scheduling stay a deliberate, manually-typed action).

import { callLlm } from '../lib/llm.mjs';
import { EXIT, GhlError } from '../lib/errors.mjs';
import { registry } from '../lib/registry.mjs';
import { quickMatch } from '../lib/quick-match.mjs';
import { fetchLiveEntity } from '../lib/model.mjs';
import { saveLastContact as _saveLastContact, loadLastContact as _loadLastContact,
         savePendingPlan as _savePendingPlan, loadPendingPlan as _loadPendingPlan,
         clearPendingPlan as _clearPendingPlan } from '../lib/ask-memory.mjs';

// ctx._askMemoryDir overrides the default ~/.config/sizmo/ask-memory dir — same pattern as
// ctx._modelDir elsewhere (test isolation; real runs never set this).
const saveLastContact = (loc, c, now, ctx) => _saveLastContact(loc, c, now, ctx?._askMemoryDir);
const loadLastContact = (loc, now, ctx) => _loadLastContact(loc, now, ctx?._askMemoryDir);
const savePendingPlan = (loc, steps, now, ctx) => _savePendingPlan(loc, steps, now, ctx?._askMemoryDir);
const loadPendingPlan = (loc, now, ctx) => _loadPendingPlan(loc, now, ctx?._askMemoryDir);
const clearPendingPlan = (loc, ctx) => _clearPendingPlan(loc, ctx?._askMemoryDir);

export const meta = {
  name: 'ask',
  summary: 'resolve (and, for reads, run) a natural language request — requires an AI key in profile',
  flags: [],
};

const RECENT_CONTACT_TOKEN = '<recent-contact>';

// Commands sizmo ask can fire directly once concretized. Anything else (invoice, appointment,
// opp update) falls back to resolve-and-print — see the file header for why.
const EXECUTABLE_WRITE_COMMANDS = new Set(['tag', 'note', 'send', 'contact', 'opp', 'value', 'field', 'calendar', 'business', 'link']);
// opp update stays print-only. opp delete added 2026-07-08 — resolves via the same oppQuery
// mechanism as move, no new resolution machinery needed.
const EXECUTABLE_OPP_SUBCOMMANDS = new Set(['create', 'move', 'delete']);

const SCHEMA_PROMPT = `
READ COMMANDS (run immediately, no --confirm):
  brief                                 morning readout: revenue, waiting contacts, stuck deals
  snapshot                              6-metric summary card
  triage                                unreplied threads, longest first
  pipeline                              pipeline health + stuck deals sweep
  receivables                           who owes money and how old
  reconcile                             money collected by source
  booked-not-paid                       sessions with no invoice or payment
  noshow                                no-shows to rebook
  focus                                 ranked action queue by money at stake
  segment --tag <tag>                   contacts with a tag
  segment --without-tag <tag>           contacts missing a tag
  segment --no-phone                    contacts with no phone
  contact search --email <email>        find contact by email
  opp list                              open opportunities
  crm [pipelines|calendars|tags|fields] CRM structure
  export --out <file>                   snapshot location to JSON
  diff <file>                           compare snapshot vs live
  forms                                 list all forms
  forms <formId>                        recent submissions for a form
  surveys                               list all surveys
  surveys <surveyId>                    recent submissions for a survey
  transactions                          payment transaction history
  business list                         list B2B companies
  list [entity]                         id lookup — pipelines|calendars|tags|fields|values|users|forms|surveys|products|links|businesses|objects

WRITE COMMANDS THIS TOOL CAN FIRE DIRECTLY (still confirm-gated — see steps schema below):
  tag        — add/remove a tag on a contact
  note       — add a note to a contact
  send       — sms or email a contact
  contact    — create | upsert (de-dupe on email/phone) | delete
  opp        — create | move (an existing deal to a new stage) | delete
  value      — create a custom value (delete needs an id you already have — not resolvable by name)
  field      — create | delete a custom field
  calendar   — create | delete a calendar
  business   — create | delete a B2B company
  link       — create a trigger link (delete needs an id you already have — not resolvable by name)

WRITE COMMANDS THIS TOOL ONLY RESOLVES (prints the exact command — you run it yourself; money and
scheduling stay a deliberate manual step, and anything needing a bare id instead of a name can't
be resolved from a natural-language query):
  opp update <oppId> [--value --status]
  appointment book --calendar --contact --start ISO8601
  appointment cancel <apptId>
  appointment note <apptId> --text "..."
  send cancel <messageId> --channel sms|email
  link delete <linkId>
  invoice draft --contact <id> --item "Name:amount[:qty]" --currency PHP
  invoice send <invoiceId>
`.trim();

function buildSystemPrompt(crmExcerpt, recentContactAvailable) {
  return `You are a GoHighLevel CLI command resolver. Translate a natural language request into one or more sizmo command steps.

${SCHEMA_PROMPT}

CRM STRUCTURE FOR THIS LOCATION:
${crmExcerpt}

RECENT CONTEXT: ${recentContactAvailable ? 'A contact was recently resolved in this session.' : 'No recent contact on file.'}

Return ONLY this JSON, no other text:
{
  "steps": [
    {
      "command": "tag",
      "subcommand": null,
      "isWrite": true,
      "intent": "Add VIP tag to Ana",
      "contactQuery": "Ana Cruz",
      "oppQuery": null,
      "oppPipelineHint": null,
      "fieldQuery": null,
      "calendarQuery": null,
      "businessQuery": null,
      "fields": { "add": "VIP" }
    }
  ],
  "confidence": 0.95,
  "explanation": "brief reason for this resolution"
}

Rules:
- One step per distinct action. "tag Ana VIP and book her Friday 2pm" is TWO steps.
- "command" is the bare registry word (tag, note, send, contact, opp, value, field, calendar,
  business, link, invoice, appointment, or a read command like brief/triage/list).
- "subcommand" is create|upsert|delete|move|update|book|cancel|list when the command needs one,
  else null.
- contactQuery: the person's name or email this step acts on. If a LATER step in THIS SAME
  request refers back to a person already named in an EARLIER step here ("tag Ana... and book
  her..."), just repeat that same name string again — do not use the placeholder for that, you
  already know who it is. Reserve the EXACT literal string "${RECENT_CONTACT_TOKEN}" ONLY for a
  pronoun/follow-up that refers to someone from a PREVIOUS, separate ask call (see RECENT CONTEXT
  above) — never guess a name, never invent one. null if this step doesn't act on a specific contact.
- oppQuery / oppPipelineHint: for "opp move"/"opp update", oppQuery is whose deal (same rules as
  contactQuery, including the "${RECENT_CONTACT_TOKEN}" token); oppPipelineHint is the pipeline
  name if mentioned, to disambiguate when someone has more than one open deal.
- fieldQuery / calendarQuery / businessQuery: the EXISTING field/calendar/business name to find
  (for delete only) — must match a name shown in CRM STRUCTURE above, never invented.
- fields: every other named value as plain keys matching CLI flag names exactly — add, remove,
  text, channel, message, email, phone, name, first, last, tag, pipeline, stage, value, status,
  type, model, "slot-min", website, item, currency, "redirect-to".
- confidence < 0.7 means you are unsure — explain why in "explanation".
- Never invent an id — only use ids/names shown in CRM STRUCTURE, or the ${RECENT_CONTACT_TOKEN} token.`;
}

function buildCrmExcerpt(model) {
  if (!model) return '(no CRM model — run: sizmo sync first)';
  const ents = model.entities || {};
  const lines = [];

  const pips = ents.pipelines?.items ?? [];
  if (pips.length) {
    lines.push('Pipelines:');
    for (const p of pips.slice(0, 12)) {
      const stages = (p.stages ?? []).map(s => s.name).join(', ');
      lines.push(`  ${p.name} (${p.id})${stages ? ' — stages: ' + stages : ''}`);
    }
  }

  const cals = ents.calendars?.items ?? [];
  if (cals.length) {
    lines.push('Calendars:');
    for (const c of cals.slice(0, 10)) lines.push(`  ${c.name} (${c.id})`);
  }

  const tags = ents.tags?.items ?? [];
  if (tags.length) {
    const names = tags.slice(0, 40).map(t => (typeof t === 'string' ? t : t.name));
    const extra = tags.length > 40 ? ` (+${tags.length - 40} more)` : '';
    lines.push(`Tags: ${names.join(', ')}${extra}`);
  }

  const fields = ents.customFields?.items ?? [];
  if (fields.length) {
    const compact = fields.slice(0, 12).map(f => `${f.name} (${f.id})`).join(', ');
    lines.push(`Custom Fields: ${compact}`);
  }

  const forms = ents.forms?.items ?? [];
  if (forms.length) {
    const compact = forms.slice(0, 12).map(f => `${f.name} (${f.id})`).join(', ');
    lines.push(`Forms: ${compact}`);
  }

  const surveys = ents.surveys?.items ?? [];
  if (surveys.length) {
    const compact = surveys.slice(0, 8).map(s => `${s.name} (${s.id})`).join(', ');
    lines.push(`Surveys: ${compact}`);
  }

  const businesses = ents.businesses?.items ?? [];
  if (businesses.length) {
    const compact = businesses.slice(0, 10).map(b => `${b.name} (${b.id})`).join(', ');
    lines.push(`Businesses: ${compact}`);
  }

  return lines.length ? lines.join('\n') : '(no CRM data cached — run: sizmo sync)';
}

// ── live name→id lookups for field/calendar/business — NOT the local sync cache ────────────────
// Live-verified: a field/calendar/business created by an earlier ask step (or an earlier separate
// ask call) isn't in the local model cache until `sizmo sync` runs again — resolving against
// that cache would fail to find something that demonstrably exists. These three endpoints each
// return their COMPLETE list in one uncapped call (verified live — customFields and objects even
// reject a `limit` param outright), so a fresh live fetch costs one extra GET, not a page-by-page
// crawl, and is reused via `liveCache` when a batch references the same entity type twice.

function normKey(s) { return String(s ?? '').trim().toLowerCase(); }

function findLocalByName(items, name, labelFn = (x) => x.name) {
  const target = normKey(name);
  if (!target) return { error: 'no name given' };
  const matches = items.filter(x => normKey(labelFn(x)) === target);
  if (matches.length === 1) return { item: matches[0] };
  if (matches.length === 0) return { error: `no match for "${name}"` };
  return { error: `"${name}" matches ${matches.length} items — be more specific`, matches };
}

// ── live contact + opportunity search (dedupe-aware within one ask invocation) ─────────────────

const CONTACT_SEARCH_LIMIT = 100; // GHL's real max — verified live: 101 gets 422 "limit must not be greater than 100"
const CANDIDATE_DISPLAY_MAX = 10; // readability cap on the disambiguation list — not the search limit

async function searchContactByQuery(query, ctx) {
  try {
    // GHL's /contacts/ list endpoint takes `query` (fuzzy match), NOT `search` — that param
    // name returns HTTP 422. Verified live: `search=` errors, `query=` correctly filters
    // (0 results for a nonsense term, real matches for a real one).
    const r = await ctx.http.get('/contacts/', { query: { locationId: ctx.cfg.loc, query, limit: CONTACT_SEARCH_LIMIT } });
    if (r.code === 401 || r.code === 403) return { error: `contacts.readonly scope required to search contacts` };
    if (!r.ok) return { error: `contact search failed — API ${r.code}` };
    const contacts = r.j?.contacts ?? [];
    // meta.total is the REAL match count from GHL — not just how many came back on this page.
    // Reporting contacts.length alone would silently undercount whenever more than the page
    // size actually matches (verified live: meta.total exists and can exceed items.length).
    const total = r.j?.meta?.total ?? contacts.length;
    if (total === 0) return { error: `no contact found for "${query}"` };
    if (total > 1) {
      const shown = contacts.slice(0, CANDIDATE_DISPLAY_MAX);
      const list = shown.map(c => `${c.id}  ${[c.firstName, c.lastName].filter(Boolean).join(' ')}  ${c.email ?? ''}`);
      if (total > shown.length) list.push(`  … ${total - shown.length} more — narrow the name further`);
      return { error: `"${query}" matches ${total} contact${total === 1 ? '' : 's'} — be more specific`, candidates: list };
    }
    const c = contacts[0];
    return { id: c.id, name: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || c.id };
  } catch (e) {
    return { error: `contact search failed: ${e.message}` };
  }
}

// GHL's opportunity object only carries pipelineId/pipelineStageId — no human-readable name
// fields (verified live: pipelineName/pipelineStageName/stageName are all undefined on the real
// response). Resolve them from the cached model, same as pipeline.mjs already does.
function buildPipelineNameLookup(model) {
  const lookup = new Map(); // pipelineId → { name, stages: Map(stageId → stageName) }
  for (const p of model?.entities?.pipelines?.items ?? []) {
    const stages = new Map((p.stages ?? []).map(s => [s.id, s.name]));
    lookup.set(p.id, { name: p.name, stages });
  }
  return lookup;
}

async function searchOpportunityByContact({ contactId, contactName, pipelineHint }, ctx, pipelineLookup) {
  try {
    // GHL's real max is 100 (verified live: 101 gets 400 "limit must not be greater than 100").
    const r = await ctx.http.get('/opportunities/search', { query: { location_id: ctx.cfg.loc, contact_id: contactId, status: 'open', limit: CONTACT_SEARCH_LIMIT } });
    if (!r.ok) return { error: `couldn't search opportunities (API ${r.code})` };
    let opps = (r.j?.opportunities ?? r.j?.data ?? []).map(o => {
      const pl = pipelineLookup?.get(o.pipelineId);
      return { ...o, pipelineName: pl?.name ?? o.pipelineId, stageLabel: pl?.stages.get(o.pipelineStageId) ?? o.pipelineStageId };
    });
    if (pipelineHint) {
      const target = normKey(pipelineHint);
      const filtered = opps.filter(o => normKey(o.pipelineName) === target || normKey(o.pipelineId) === target);
      if (filtered.length) opps = filtered;
    }
    if (opps.length === 0) return { error: `${contactName} has no open opportunities${pipelineHint ? ` in "${pipelineHint}"` : ''}` };
    if (opps.length > 1) {
      const shown = opps.slice(0, CANDIDATE_DISPLAY_MAX);
      const list = shown.map(o => `${o.id}  ${o.name ?? ''}  ${o.pipelineName} / ${o.stageLabel}`);
      if (opps.length > shown.length) list.push(`  … ${opps.length - shown.length} more — narrow further`);
      return { error: `${contactName} has ${opps.length} open opportunities — be more specific (pipeline name, or use the exact id)`, candidates: list };
    }
    const o = opps[0];
    return { id: o.id, label: `${o.name ?? contactName}'s deal (${o.pipelineName ?? ''})` };
  } catch (e) {
    return { error: `opportunity search failed: ${e.message}` };
  }
}

// ── per-command step builders — pure, validate required fields, assemble the exact `parsed`
// shape each real command expects (never trust the LLM's raw args ordering) ────────────────────

function need(fields, keys) {
  for (const k of keys) if (!fields?.[k]) return `missing --${k}`;
  return null;
}

const STEP_BUILDERS = {
  tag: (step, ids) => {
    const f = step.fields ?? {};
    if (!ids.contactId) return { error: 'no contact resolved' };
    if (!f.add && !f.remove) return { error: 'missing --add or --remove' };
    const parsed = { _: [ids.contactId], ...(f.add ? { add: f.add } : {}), ...(f.remove ? { remove: f.remove } : {}) };
    return { parsed, describe: `Tag ${ids.contactName}: ${f.add ? '+' + f.add : '-' + f.remove}` };
  },
  note: (step, ids) => {
    const f = step.fields ?? {};
    if (!ids.contactId) return { error: 'no contact resolved' };
    if (!f.text) return { error: 'missing --text' };
    return { parsed: { _: [ids.contactId], text: f.text }, describe: `Note on ${ids.contactName}: "${f.text}"` };
  },
  send: (step, ids) => {
    const f = step.fields ?? {};
    if (!ids.contactId) return { error: 'no contact resolved' };
    const err = need(f, ['channel', 'message']);
    if (err) return { error: err };
    return { parsed: { _: [ids.contactId], channel: f.channel, message: f.message }, describe: `Send ${f.channel} to ${ids.contactName}: "${f.message}"` };
  },
  contact: (step, ids) => {
    const f = step.fields ?? {};
    const sub = step.subcommand;
    if (sub === 'create') {
      if (!f.email && !f.phone && !f.name && !f.first && !f.last) return { error: 'contact create needs at least one of email/phone/name' };
      const parsed = { _: ['create'], ...f };
      return { parsed, describe: `Create contact: ${f.name || f.email || f.phone}` };
    }
    if (sub === 'upsert') {
      if (!f.email && !f.phone) return { error: 'contact upsert needs email or phone' };
      const parsed = { _: ['upsert'], ...f };
      return { parsed, describe: `Upsert contact: ${f.email || f.phone}` };
    }
    if (sub === 'delete') {
      if (!ids.contactId) return { error: 'no contact resolved' };
      return { parsed: { _: ['delete', ids.contactId] }, describe: `Delete contact ${ids.contactName}` };
    }
    return { error: `unsupported contact subcommand "${sub}"` };
  },
  opp: (step, ids) => {
    const f = step.fields ?? {};
    const sub = step.subcommand;
    if (sub === 'create') {
      if (!ids.contactId) return { error: 'no contact resolved' };
      const err = need(f, ['name', 'pipeline', 'stage']);
      if (err) return { error: err };
      const parsed = { _: ['create'], name: f.name, pipeline: f.pipeline, stage: f.stage, contact: ids.contactId, ...(f.value ? { value: f.value } : {}) };
      return { parsed, describe: `Create opportunity "${f.name}" for ${ids.contactName} in ${f.pipeline}/${f.stage}` };
    }
    if (sub === 'move') {
      if (!ids.oppId) return { error: 'no opportunity resolved' };
      if (!f.stage) return { error: 'missing --stage' };
      return { parsed: { _: ['move', ids.oppId], stage: f.stage }, describe: `Move ${ids.oppLabel} to ${f.stage}` };
    }
    if (sub === 'delete') {
      if (!ids.oppId) return { error: 'no opportunity resolved' };
      return { parsed: { _: ['delete', ids.oppId] }, describe: `Delete opportunity ${ids.oppLabel}` };
    }
    return { error: `unsupported opp subcommand "${sub}" — sizmo ask can only fire opp create/move/delete directly` };
  },
  value: (step, ids) => {
    const f = step.fields ?? {};
    if (step.subcommand !== 'create') return { error: 'sizmo ask can only fire value create directly — value delete needs an id (run sizmo list values)' };
    const err = need(f, ['name', 'value']);
    if (err) return { error: err };
    return { parsed: { _: ['create'], name: f.name, value: f.value }, describe: `Create custom value "${f.name}" = "${f.value}"` };
  },
  field: (step, ids) => {
    const f = step.fields ?? {};
    if (step.subcommand === 'create') {
      if (!f.name) return { error: 'missing --name' };
      return { parsed: { _: ['create'], name: f.name, ...(f.type ? { type: f.type } : {}), ...(f.model ? { model: f.model } : {}) }, describe: `Create field "${f.name}"${f.type ? ` (${f.type})` : ''}` };
    }
    if (step.subcommand === 'delete') {
      if (!ids.fieldId) return { error: 'no field resolved' };
      return { parsed: { _: ['delete', ids.fieldId] }, describe: `Delete field "${ids.fieldName}"` };
    }
    return { error: `unsupported field subcommand "${step.subcommand}"` };
  },
  calendar: (step, ids) => {
    const f = step.fields ?? {};
    if (step.subcommand === 'create') {
      if (!f.name) return { error: 'missing --name' };
      return { parsed: { _: ['create'], name: f.name, ...(f.type ? { type: f.type } : {}), ...(f['slot-min'] ? { 'slot-min': f['slot-min'] } : {}) }, describe: `Create calendar "${f.name}"` };
    }
    if (step.subcommand === 'delete') {
      if (!ids.calendarId) return { error: 'no calendar resolved' };
      return { parsed: { _: ['delete', ids.calendarId] }, describe: `Delete calendar "${ids.calendarName}"` };
    }
    return { error: `unsupported calendar subcommand "${step.subcommand}"` };
  },
  business: (step, ids) => {
    const f = step.fields ?? {};
    if (step.subcommand === 'create') {
      if (!f.name) return { error: 'missing --name' };
      return { parsed: { _: ['create'], name: f.name, ...(f.email ? { email: f.email } : {}), ...(f.phone ? { phone: f.phone } : {}), ...(f.website ? { website: f.website } : {}) }, describe: `Create business "${f.name}"` };
    }
    if (step.subcommand === 'delete') {
      if (!ids.businessId) return { error: 'no business resolved' };
      return { parsed: { _: ['delete', ids.businessId] }, describe: `Delete business "${ids.businessName}"` };
    }
    return { error: `unsupported business subcommand "${step.subcommand}"` };
  },
  link: (step, ids) => {
    const f = step.fields ?? {};
    if (step.subcommand !== 'create') {
      return { error: 'sizmo ask can only fire link create directly — link delete needs an id (run sizmo list links)' };
    }
    const err = need(f, ['name', 'redirect-to']);
    if (err) return { error: err };
    return { parsed: { _: ['create'], name: f.name, 'redirect-to': f['redirect-to'] }, describe: `Create trigger link "${f.name}" → ${f['redirect-to']}` };
  },
};

const READ_COMMANDS = new Set([
  'brief', 'snapshot', 'triage', 'pipeline', 'receivables', 'reconcile', 'booked-not-paid',
  'noshow', 'focus', 'segment', 'crm', 'export', 'diff', 'forms', 'surveys', 'transactions', 'list',
]);

function isExecutable(step) {
  if (READ_COMMANDS.has(step.command)) return true;
  if (!EXECUTABLE_WRITE_COMMANDS.has(step.command)) return false;
  if (step.command === 'opp') return EXECUTABLE_OPP_SUBCOMMANDS.has(step.subcommand);
  // send cancel and link delete both need a bare id (messageId/linkId) that isn't resolvable
  // from a natural-language query — same reasoning as value delete. Print-only, matching that
  // existing precedent rather than inventing new id-resolution machinery for them.
  if (step.command === 'send' && step.subcommand === 'cancel') return false;
  if (step.command === 'link' && step.subcommand !== 'create') return false;
  return true;
}

// ── concretize: resolve every placeholder to a real id, build `parsed` per step. Aborts the
// WHOLE batch (returns {ok:false}) on any failure — never a partial resolution. ─────────────────

export async function concretize(steps, ctx, now) {
  const contactCache = new Map(); // normalized query → {id,name} | {error}
  const liveEntityCache = new Map(); // entity name → {items} | {error} — one live fetch per type per batch
  let resolvedContact = null; // last one actually resolved this call, for memory save

  async function resolveContact(query) {
    const key = normKey(query);
    if (contactCache.has(key)) return contactCache.get(key);
    let result;
    if (query === RECENT_CONTACT_TOKEN) {
      // Prefer a contact already resolved EARLIER IN THIS SAME BATCH ("tag Marco... and note
      // him...") over the persisted cross-call memory — the persisted file isn't updated until
      // the whole batch finishes, so without this a same-sentence pronoun would incorrectly
      // fall back to whoever was resolved in a PREVIOUS, unrelated ask call.
      const last = resolvedContact ?? loadLastContact(ctx.cfg.loc, now, ctx);
      result = last ? { id: last.id, name: last.name } : { error: 'no recent contact remembered — name someone explicitly' };
    } else {
      result = await searchContactByQuery(query, ctx);
    }
    contactCache.set(key, result);
    if (result.id) resolvedContact = result;
    return result;
  }

  const model = await ctx.ensureModel();
  const pipelineLookup = buildPipelineNameLookup(model);
  const concrete = [];
  const previewLines = [];

  for (const step of steps) {
    // Reject an unrecognized/hallucinated command up front — never let it silently fall into
    // the "resolve-only, print this" path (which would print a command that doesn't exist).
    if (!Object.prototype.hasOwnProperty.call(registry, step.command)) {
      return { ok: false, error: `the AI suggested an unrecognized command "${step.command}" — try rephrasing` };
    }

    const ids = {};

    if (step.contactQuery) {
      const r = await resolveContact(step.contactQuery);
      if (r.error) return { ok: false, error: r.error, candidates: r.candidates };
      ids.contactId = r.id; ids.contactName = r.name;
    }

    if (step.oppQuery) {
      const c = await resolveContact(step.oppQuery);
      if (c.error) return { ok: false, error: c.error, candidates: c.candidates };
      const o = await searchOpportunityByContact({ contactId: c.id, contactName: c.name, pipelineHint: step.oppPipelineHint }, ctx, pipelineLookup);
      if (o.error) return { ok: false, error: o.error, candidates: o.candidates };
      ids.oppId = o.id; ids.oppLabel = o.label;
    }

    if (step.fieldQuery) {
      const live = await fetchLiveEntity('customFields', ctx, liveEntityCache);
      if (live.error) return { ok: false, error: live.error };
      const r = findLocalByName(live.items, step.fieldQuery);
      if (r.error) return { ok: false, error: r.error, candidates: r.matches?.map(m => `${m.id}  ${m.name}`) };
      ids.fieldId = r.item.id; ids.fieldName = r.item.name;
    }

    if (step.calendarQuery) {
      const live = await fetchLiveEntity('calendars', ctx, liveEntityCache);
      if (live.error) return { ok: false, error: live.error };
      const r = findLocalByName(live.items, step.calendarQuery);
      if (r.error) return { ok: false, error: r.error, candidates: r.matches?.map(m => `${m.id}  ${m.name}`) };
      ids.calendarId = r.item.id; ids.calendarName = r.item.name;
    }

    if (step.businessQuery) {
      const live = await fetchLiveEntity('businesses', ctx, liveEntityCache);
      if (live.error) return { ok: false, error: live.error };
      const r = findLocalByName(live.items, step.businessQuery);
      if (r.error) return { ok: false, error: r.error, candidates: r.matches?.map(m => `${m.id}  ${m.name}`) };
      ids.businessId = r.item.id; ids.businessName = r.item.name;
    }

    if (READ_COMMANDS.has(step.command)) {
      const parsed = { _: [...(step.args ?? [])], ...(step.fields ?? {}) };
      concrete.push({ command: step.command, parsed, isWrite: false, describe: step.intent ?? `Run ${step.command}` });
      previewLines.push(`  ${step.intent ?? step.command}`);
      continue;
    }

    if (!isExecutable(step)) {
      concrete.push({ command: step.command, subcommand: step.subcommand, step, isWrite: true, executable: false });
      previewLines.push(`  ${step.intent ?? step.command} (resolve-only — you run this one)`);
      continue;
    }

    const builder = STEP_BUILDERS[step.command];
    if (!builder) return { ok: false, error: `sizmo ask doesn't know how to run "${step.command}" yet` };
    const built = builder(step, ids);
    if (built.error) return { ok: false, error: `${step.command}${step.subcommand ? ' ' + step.subcommand : ''}: ${built.error}` };
    concrete.push({ command: step.command, parsed: built.parsed, isWrite: true, executable: true, describe: built.describe });
    previewLines.push(`  ${built.describe}`);
  }

  return { ok: true, concrete, previewLines, resolvedContact };
}

// ── execute: run concretized steps in order via the real registry command. Hard stop on the
// first non-OK exit code — never continue past a failure. ─────────────────────────────────────

export async function executeSteps(concrete, ctx) {
  const results = [];
  for (const step of concrete) {
    if (step.executable === false) {
      results.push({ command: step.command, skipped: true, note: 'resolve-only command — not auto-fired' });
      continue;
    }
    let mod;
    try {
      mod = await registry[step.command]();
    } catch (e) {
      results.push({ command: step.command, code: EXIT.API, error: e.message });
      break;
    }
    let code;
    try {
      code = await mod.run(step.parsed, ctx);
    } catch (e) {
      if (e instanceof GhlError) {
        ctx.out.line(`  ✖ ${step.describe ?? step.command}: ${e.message}`);
        results.push({ command: step.command, code: e.code, error: e.message });
      } else {
        ctx.out.line(`  ✖ ${step.describe ?? step.command}: ${e.message}`);
        results.push({ command: step.command, code: EXIT.API, error: e.message });
      }
      break;
    }
    results.push({ command: step.command, code: code ?? EXIT.OK });
    if ((code ?? EXIT.OK) !== EXIT.OK) break; // hard stop — never continue past a failure
  }
  return results;
}

// Re-prints what's about to fire (so a replayed plan is always observable, never silently
// executed) and, after running, reports every step's actual outcome — not just "it stopped" —
// so a partial-batch failure never leaves the human unsure which steps already went through
// (and might otherwise re-run the whole batch, double-firing the ones that already succeeded).
async function runWithReport(concrete, ctx) {
  ctx.out.line('');
  for (const step of concrete) ctx.out.line(`  ${step.describe ?? step.command}`);
  ctx.out.line('');
  const results = await executeSteps(concrete, ctx);
  ctx.out.line('');
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const label = concrete[i]?.describe ?? r.command;
    if (r.skipped) ctx.out.line(`  — ${label} (not auto-fired)`);
    else if (!r.code || r.code === EXIT.OK) ctx.out.line(`  ✓ ${label}`);
    else ctx.out.line(`  ✖ ${label}${r.error ? ` — ${r.error}` : ''}`);
  }
  if (results.length < concrete.length) {
    const remaining = concrete.length - results.length;
    ctx.out.line(`  ${remaining} step(s) not attempted — fix the error above and re-ask.`);
  }
  ctx.out.flush();
  const failed = results.find(r => r.code && r.code !== EXIT.OK);
  return failed ? failed.code : EXIT.OK;
}

export async function run(parsed, ctx) {
  const now = typeof ctx.now === 'function' ? ctx.now() : ctx.now;
  const intent = (parsed._ ?? []).join(' ').trim();

  // ── bare/typed --confirm: replay the cached plan, never re-resolve ────────────────────────
  if (ctx.confirmed) {
    const pending = loadPendingPlan(ctx.cfg.loc, now, ctx);
    if (pending) {
      clearPendingPlan(ctx.cfg.loc, ctx); // a stray extra --confirm can't replay an already-fired plan
      return runWithReport(pending, ctx);
    }
    if (!intent) {
      ctx.out.line('nothing to confirm — run `sizmo ask "..."` first (without --confirm) to preview.');
      ctx.out.flush();
      return EXIT.USAGE;
    }
    // Fresh sentence + --confirm, no prior preview: resolve and fire in this SAME call (safe —
    // one resolution, no drift risk since nothing was shown beforehand). Falls through below.
  }

  if (!intent) {
    ctx.out.line('usage: sizmo ask "what you want to do"');
    ctx.out.line('');
    ctx.out.line('examples:');
    ctx.out.line('  sizmo ask "who has been waiting longest for a reply"');
    ctx.out.line('  sizmo ask "tag Ana Cruz as follow-up"');
    ctx.out.line('  sizmo ask "tag Ana as follow-up and book her Friday at 2pm" --confirm');
    ctx.out.line('  sizmo ask "move Website Package to Proposal Sent"');
    ctx.out.flush();
    return EXIT.USAGE;
  }

  // ── local fast path: bare command names never touch the LLM ───────────────────────────────
  const quick = quickMatch(intent);
  let steps, confidence = 1, explanation = null;

  if (quick) {
    steps = [{ command: quick.command, subcommand: null, isWrite: false, intent: quick.intent, args: quick.args, fields: {} }];
  } else {
    const aiKey = ctx.cfg.aiKey;
    const aiProvider = ctx.cfg.aiProvider || 'anthropic';
    if (!aiKey) {
      ctx.out.line('sizmo ask requires an AI key in your profile (or type an exact command name — see `sizmo schema`).');
      ctx.out.line('');
      ctx.out.line('Setup (pick your provider):');
      ctx.out.line('  sizmo config set --profile <name> --ai-key "sk-ant-..." --ai-provider anthropic');
      ctx.out.line('  sizmo config set --profile <name> --ai-key "sk-..." --ai-provider openai');
      ctx.out.flush();
      return EXIT.AUTH;
    }

    const model = await ctx.ensureModel();
    const crmExcerpt = buildCrmExcerpt(model);
    const recentContact = loadLastContact(ctx.cfg.loc, now, ctx);

    ctx.out.line(`Resolving: "${intent}"...`);
    ctx.out.flush();

    let resolved;
    try {
      resolved = await callLlm({ apiKey: aiKey, provider: aiProvider, systemPrompt: buildSystemPrompt(crmExcerpt, !!recentContact), userMessage: intent });
    } catch (e) {
      ctx.out.line(`AI error: ${e.message}`);
      if (e.message?.includes('401') || e.message?.includes('403')) ctx.out.line('Check your AI key: sizmo config set --profile <name> --ai-key <key>');
      ctx.out.flush();
      return EXIT.API;
    }

    if (!resolved?.steps?.length) {
      ctx.out.line('Could not resolve — LLM returned no steps. Try rephrasing.');
      ctx.out.flush();
      return EXIT.USAGE;
    }
    steps = resolved.steps;
    confidence = resolved.confidence ?? 1;
    explanation = resolved.explanation ?? null;
  }

  if (confidence < 0.7) {
    ctx.out.line(`Low confidence (${Math.round(confidence * 100)}%): ${explanation ?? 'unclear request'}`);
    ctx.out.line('Try rephrasing, or browse commands: sizmo schema');
    ctx.out.flush();
    return EXIT.USAGE;
  }

  const result = await concretize(steps, ctx, now);
  if (!result.ok) {
    ctx.out.line(`Couldn't resolve: ${result.error}`);
    if (result.candidates) for (const c of result.candidates) ctx.out.line(`  ${c}`);
    ctx.out.flush();
    return EXIT.NOTFOUND;
  }

  if (result.resolvedContact) saveLastContact(ctx.cfg.loc, result.resolvedContact, now, ctx);

  const anyWrite = result.concrete.some(s => s.isWrite);

  if (!anyWrite) {
    // Pure read batch — execute immediately, print real output.
    const results = await executeSteps(result.concrete, ctx);
    ctx.out.flush();
    const failed = results.find(r => r.code && r.code !== EXIT.OK);
    return failed ? failed.code : EXIT.OK;
  }

  const anyNonExecutable = result.concrete.some(s => s.isWrite && s.executable === false);
  if (anyNonExecutable && result.concrete.length > 1) {
    ctx.out.line('');
    ctx.out.line("This request mixes something sizmo ask can't fire automatically (invoicing, appointments, or opp update) with other steps.");
    ctx.out.line('Ask for one thing at a time when it involves those.');
    ctx.out.flush();
    return EXIT.USAGE;
  }

  if (anyNonExecutable) {
    // Single non-executable write — today's original resolve-and-print behavior.
    const step = steps[0];
    const cmdParts = ['sizmo', step.command, step.subcommand].filter(Boolean);
    for (const [k, v] of Object.entries(step.fields ?? {})) {
      if (v === true) cmdParts.push(`--${k}`);
      else cmdParts.push(`--${k}`, String(v).includes(' ') ? `"${v}"` : String(v));
    }
    const cmdStr = cmdParts.join(' ');
    ctx.out.line('');
    ctx.out.line(`  ${step.intent ?? 'resolved command'}`);
    ctx.out.line(`  → ${cmdStr}`);
    ctx.out.line('');
    ctx.out.line('  Rerun with --confirm to apply (sizmo ask cannot fire this one automatically):');
    ctx.out.line(`  ${cmdStr} --confirm`);
    ctx.out.line('');
    ctx.out.flush();
    return EXIT.CONFIRM;
  }

  // Executable write(s). If this call already carries --confirm (the "fresh sentence + --confirm,
  // no prior preview" case from the top of run()), fire now — same-call resolution, no drift risk.
  if (ctx.confirmed) {
    return runWithReport(result.concrete, ctx);
  }

  // Preview + cache the concretized plan for a bare `--confirm` replay.
  savePendingPlan(ctx.cfg.loc, result.concrete, now, ctx);
  ctx.out.line('');
  for (const line of result.previewLines) ctx.out.line(line);
  ctx.out.line('');
  ctx.out.line('  Rerun with --confirm to apply:');
  ctx.out.line('  sizmo ask --confirm');
  ctx.out.line('');
  ctx.out.flush();
  return EXIT.CONFIRM;
}

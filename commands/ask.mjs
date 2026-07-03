// commands/ask.mjs — natural language → sizmo command resolver.
// Requires an AI key in profile: sizmo config set --profile <name> --ai-key <key>
// Reads show the resolved command. Writes preview + exit 5 without --confirm.

import { callLlm } from '../lib/llm.mjs';
import { EXIT } from '../lib/errors.mjs';

export const meta = {
  name: 'ask',
  summary: 'resolve natural language to a sizmo command (requires AI key in profile)',
  flags: [],
};

// Compact static schema — given to LLM as command reference.
const SCHEMA_PROMPT = `
READ COMMANDS (no --confirm, safe):
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
  forms <formId> --top <n>             limit submission rows
  surveys                               list all surveys
  surveys <surveyId>                    recent submissions for a survey
  transactions                          payment transaction history (read-only)
  transactions --top <n>               show more rows (default 25, max 100)
  transactions --type subscription|order  filter by type
  business list                         list B2B companies
  list calendars                        calendar IDs and staff
  list pipelines                        pipeline and stage IDs
  list tags                             all tag names
  list fields                           custom field IDs and types
  list values                           custom value IDs and current values
  list users                            user IDs and emails
  list forms                            form IDs (no submissions)
  list surveys                          survey IDs
  list products                         product IDs
  list businesses                       B2B company IDs

WRITE COMMANDS (need --confirm; without it: preview + exit 5):
  tag <contactId> --add <tag>
  tag <contactId> --remove <tag>
  note <contactId> --text "..."
  contact create --email <e> --name "..."
  contact upsert --email <e> --name "..."
  contact delete <contactId>
  opp create --pipeline "name" --stage "name" --name "deal" --contact <id>
  opp move <oppId> --stage "name"
  send <contactId> --channel sms --message "..."
  send <contactId> --channel email --message "..."
  value update <valueId> --value "..."
  value create --name "..." --value "..."
  field create --name "..." --type TEXT|MONETORY|DATE
  calendar create --name "..."
  calendar delete <calendarId>
  appointment book --calendar "name" --contact <id> --start ISO8601
  appointment cancel <apptId>
  invoice draft --contact <id> --item "Name:Amount" --currency PHP
  invoice send <invoiceId>
  business create --name "Company" --website "https://..." --email "..."
  business delete <businessId>
`.trim();

function buildSystemPrompt(crmExcerpt) {
  return `You are a GoHighLevel CLI command resolver. Translate a natural language request into the exact sizmo CLI command.

${SCHEMA_PROMPT}

CRM STRUCTURE FOR THIS LOCATION:
${crmExcerpt}

Return ONLY this JSON, no other text:
{
  "command": "tag",
  "args": ["<contactId>"],
  "flags": { "add": "VIP" },
  "confidence": 0.95,
  "intent": "Add VIP tag to contact",
  "isWrite": true,
  "requiresContactSearch": false,
  "contactQuery": null,
  "explanation": "brief reason for this command choice"
}

Rules:
- confidence < 0.7 means you are unsure — explain in "explanation"
- requiresContactSearch: true when you know a person name but not their ID
- contactQuery: the name or email to search when requiresContactSearch is true
- isWrite: true for any command that modifies GHL data
- args: positional arguments BEFORE flags, as a JSON array
- flags: object with flag names (without --) mapped to values; boolean flags map to true
- Never invent IDs — only use IDs shown in the CRM structure above
- Use the pipeline/calendar/tag names from the CRM structure when matching`;
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

function buildCommandStr(resolved) {
  const parts = ['sizmo', resolved.command];
  for (const a of (resolved.args ?? [])) parts.push(a);
  for (const [k, v] of Object.entries(resolved.flags ?? {})) {
    if (v === true) parts.push(`--${k}`);
    else {
      const val = String(v);
      parts.push(`--${k}`, val.includes(' ') ? `"${val}"` : val);
    }
  }
  return parts.join(' ');
}

export async function run(parsed, ctx) {
  const intent = parsed._.join(' ').trim();

  if (!intent) {
    ctx.out.line('usage: sizmo ask "what you want to do"');
    ctx.out.line('');
    ctx.out.line('examples:');
    ctx.out.line('  sizmo ask "who has been waiting longest for a reply"');
    ctx.out.line('  sizmo ask "tag Ana Cruz as follow-up"');
    ctx.out.line('  sizmo ask "show me unpaid invoices"');
    ctx.out.line('  sizmo ask "move the Website Package deal to Proposal Sent"');
    ctx.out.flush();
    return EXIT.USAGE;
  }

  const aiKey = ctx.cfg.aiKey;
  const aiProvider = ctx.cfg.aiProvider || 'anthropic';

  if (!aiKey) {
    ctx.out.line('sizmo ask requires an AI key in your profile.');
    ctx.out.line('');
    ctx.out.line('Setup (pick your provider):');
    ctx.out.line('  sizmo config set --profile <name> --ai-key "sk-ant-..." --ai-provider anthropic');
    ctx.out.line('  sizmo config set --profile <name> --ai-key "sk-..." --ai-provider openai');
    ctx.out.line('');
    ctx.out.line('Supported: anthropic (default, claude-haiku-4-5-20251001), openai (gpt-4o-mini)');
    ctx.out.flush();
    return EXIT.AUTH;
  }

  // Load CRM model for context (auto-syncs if missing)
  const model = await ctx.ensureModel();
  const crmExcerpt = buildCrmExcerpt(model);

  ctx.out.line(`Resolving: "${intent}"...`);
  ctx.out.flush();

  let resolved;
  try {
    resolved = await callLlm({
      apiKey: aiKey,
      provider: aiProvider,
      systemPrompt: buildSystemPrompt(crmExcerpt),
      userMessage: intent,
    });
  } catch (e) {
    ctx.out.line(`AI error: ${e.message}`);
    if (e.message?.includes('401') || e.message?.includes('403')) {
      ctx.out.line('Check your AI key: sizmo config set --profile <name> --ai-key <key>');
    }
    ctx.out.flush();
    return EXIT.API;
  }

  if (!resolved?.command) {
    ctx.out.line('Could not resolve — LLM returned no command. Try rephrasing.');
    ctx.out.flush();
    return EXIT.USAGE;
  }

  if ((resolved.confidence ?? 1) < 0.7) {
    const pct = Math.round((resolved.confidence ?? 0) * 100);
    ctx.out.line(`Low confidence (${pct}%): ${resolved.explanation ?? 'unclear request'}`);
    ctx.out.line('Try rephrasing, or browse commands: sizmo schema');
    ctx.out.flush();
    return EXIT.USAGE;
  }

  // Contact search — resolve name → ID when LLM needs it
  if (resolved.requiresContactSearch && resolved.contactQuery) {
    ctx.out.line(`Searching: "${resolved.contactQuery}"...`);
    ctx.out.flush();
    try {
      const r = await ctx.http.get('/contacts/', {
        query: { locationId: ctx.cfg.loc, search: resolved.contactQuery, limit: 5 },
      });
      const contacts = r.j?.contacts ?? [];

      if (contacts.length === 0) {
        ctx.out.line(`No contact found for "${resolved.contactQuery}"`);
        ctx.out.line(`Try: sizmo segment --name "${resolved.contactQuery}"`);
        ctx.out.flush();
        return EXIT.NOTFOUND;
      }

      if (contacts.length > 1) {
        ctx.out.line(`Multiple matches for "${resolved.contactQuery}" — pick one:`);
        for (const c of contacts) {
          ctx.out.line(`  ${c.id}  ${[c.firstName, c.lastName].filter(Boolean).join(' ')}  ${c.email ?? ''}`);
        }
        ctx.out.line('');
        ctx.out.line(`Retry with the exact ID:`);
        ctx.out.line(`  sizmo ask "${intent}" --contact-id ${contacts[0].id}`);
        ctx.out.flush();
        return EXIT.USAGE;
      }

      const contactId = contacts[0].id;
      const name = [contacts[0].firstName, contacts[0].lastName].filter(Boolean).join(' ');
      ctx.out.line(`  → ${name} (${contactId})`);

      // Replace placeholder in args with real ID
      resolved.args = (resolved.args ?? []).map(a =>
        a === '<contactId>' || a === resolved.contactQuery ? contactId : a
      );
      // If no placeholder existed, prepend the ID (tag/note/send take contactId first)
      if (!(resolved.args ?? []).includes(contactId)) {
        resolved.args = [contactId, ...(resolved.args ?? [])];
      }
    } catch (e) {
      ctx.out.line(`Contact search failed: ${e.message}`);
      ctx.out.flush();
      return EXIT.API;
    }
  }

  const cmdStr = buildCommandStr(resolved);

  ctx.out.line('');
  ctx.out.line(`  ${resolved.intent}`);
  ctx.out.line(`  → ${cmdStr}`);

  if (resolved.isWrite) {
    ctx.out.line('');
    ctx.out.line('  Rerun with --confirm to apply:');
    ctx.out.line(`  ${cmdStr} --confirm`);
    ctx.out.line('');
    ctx.out.flush();
    return EXIT.CONFIRM;
  }

  ctx.out.line('');
  ctx.out.flush();
  return EXIT.OK;
}

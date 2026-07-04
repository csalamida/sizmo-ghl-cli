// lib/quick-match.mjs — conservative local fast-path for `sizmo ask`. Recognizes only BARE
// command names (no free-text argument parsing) so it can never misfire: every match here is a
// read-only command with zero entity resolution involved. If the phrasing isn't an exact,
// unambiguous match, return null and let the LLM handle it — no guessing, no partial credit.
//
// This deliberately does NOT attempt to parse tag/note/send/etc from plain English locally —
// those need real argument extraction + contact-name resolution, which belongs in the LLM path
// where it can be checked against CRM structure and confidence-gated.

const BARE_COMMANDS = [
  'brief', 'doctor', 'snapshot', 'triage', 'pipeline', 'receivables', 'reconcile',
  'noshow', 'focus', 'crm', 'schema',
];

// Alias → canonical bare command (covers the most common natural phrasings of the same word).
const ALIASES = {
  'no show': 'noshow', 'no-show': 'noshow', 'noshows': 'noshow', 'no shows': 'noshow',
  'booked not paid': 'booked-not-paid', 'booked-not-paid': 'booked-not-paid',
  'booked but not paid': 'booked-not-paid',
};

const LIST_ENTITIES = [
  'pipelines', 'calendars', 'tags', 'fields', 'values', 'users',
  'forms', 'surveys', 'products', 'links', 'businesses', 'objects',
];

// entity phrase → canonical entity name (plural/singular + a couple common synonyms)
const ENTITY_ALIASES = {
  pipeline: 'pipelines', calendar: 'calendars', tag: 'tags', field: 'fields', value: 'values',
  user: 'users', form: 'forms', survey: 'surveys', product: 'products', link: 'links',
  business: 'businesses', object: 'objects', 'custom object': 'objects', 'custom objects': 'objects',
};

function normalize(s) {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function makeResolved(command, args = []) {
  return {
    command, args, flags: {}, confidence: 1, isWrite: false,
    requiresContactSearch: false, contactQuery: null,
    intent: `Run sizmo ${[command, ...args].join(' ')}`,
    explanation: 'matched locally — exact command name, no AI call needed',
  };
}

/**
 * quickMatch(intentText) → a fully-resolved `resolved` object (same shape ask.mjs's LLM path
 * produces), or null if this isn't a confident, conservative match. Every match is read-only.
 */
export function quickMatch(intentText) {
  const n = normalize(intentText);
  if (!n) return null;

  const canonical = ALIASES[n] ?? n;
  if (BARE_COMMANDS.includes(canonical) || canonical === 'booked-not-paid') {
    return makeResolved(canonical);
  }

  if (canonical === 'forms' || canonical === 'surveys' || canonical === 'transactions') {
    return makeResolved(canonical);
  }

  if (canonical === 'business list' || canonical === 'businesses' || canonical === 'list businesses') {
    return makeResolved('business', ['list']);
  }

  // "list" bare, or "list <entity>"
  if (canonical === 'list') return makeResolved('list');
  if (canonical.startsWith('list ')) {
    const rest = canonical.slice(5).trim();
    const entity = ENTITY_ALIASES[rest] ?? (LIST_ENTITIES.includes(rest) ? rest : null);
    if (entity) return makeResolved('list', [entity]);
    return null; // unknown entity word — don't guess, let the LLM try
  }

  return null;
}

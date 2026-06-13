// commands/segment.mjs — Multi-criteria contact segment finder.
// Trust-fix #1: LOC from ctx.cfg.loc.
// Trust-fix #2: contacts paginate to completion.
// READ-ONLY. Never writes a tag, never messages.
import { paginate } from '../lib/paginate.mjs';

export const meta = {
  name: 'segment',
  summary: 'Find contacts by criteria — tag, phone, age, etc.',
  flags: [
    { name: '--tag', type: 'str', desc: 'must have this tag' },
    { name: '--without-tag', type: 'str', desc: 'must NOT have this tag' },
    { name: '--no-tags', type: 'bool', desc: 'contacts with zero tags' },
    { name: '--created-days', type: 'int', desc: 'created within N days' },
    { name: '--has-phone', type: 'bool', desc: 'must have phone' },
    { name: '--no-phone', type: 'bool', desc: 'must NOT have phone' },
    { name: '--top', type: 'int', default: 20, desc: 'max rows to show in sample' },
    { name: '--full', type: 'bool', default: false, desc: 'include full contact objects in sample (default: id+name only)' },
  ],
  readOnly: true,
};

export async function collect(args, ctx) {
  const TAG = args.tag?.toLowerCase() ?? null;
  const WITHOUT = args['without-tag']?.toLowerCase() ?? null;
  const NO_TAGS = !!args['no-tags'];
  const CREATED_DAYS = args['created-days'] ?? null;
  const HAS_PHONE = !!args['has-phone'];
  const NO_PHONE = !!args['no-phone'];
  const TOP = args.top ?? 20;
  const LOC = ctx.cfg.loc;
  const NOW = ctx.now;
  const START = CREATED_DAYS ? NOW - Number(CREATED_DAYS) * 86400000 : null;

  const crit = [
    TAG && `tag=${TAG}`,
    WITHOUT && `without=${WITHOUT}`,
    NO_TAGS && 'no-tags',
    CREATED_DAYS && `created≤${CREATED_DAYS}d`,
    HAS_PHONE && 'has-phone',
    NO_PHONE && 'no-phone',
  ].filter(Boolean);

  if (!crit.length) {
    ctx.out.warn('No criteria given. Use e.g. --created-days 30 --no-tags', { degraded: false });
    return null; // signal usage error
  }

  function matches(c) {
    const tags = (c.tags || []).map(t => String(t).toLowerCase());
    if (TAG && !tags.includes(TAG)) return false;
    if (WITHOUT && tags.includes(WITHOUT)) return false;
    if (NO_TAGS && tags.length > 0) return false;
    if (START) { const t = Date.parse(c.dateAdded || c.createdAt) || 0; if (t < START) return false; }
    if (HAS_PHONE && !c.phone) return false;
    if (NO_PHONE && c.phone) return false;
    return true;
  }

  let scanned = 0;
  const hits = [];
  let firstErr = null;

  for await (const c of paginate({
    fetchPage: async (cursor) => {
      const q = { locationId: LOC, limit: 100 };
      if (cursor) { q.startAfter = cursor.startAfter; q.startAfterId = cursor.startAfterId; }
      const r = await ctx.http.get('/contacts/', { query: q });
      if (!r.ok) return { _err: r.code, contacts: [] };
      return r.j;
    },
    getItems: (resp) => {
      if (resp._err) { firstErr = resp._err; return []; }
      return resp.contacts || resp.data || [];
    },
    nextCursor: (resp, items) => {
      if (resp._err || items.length < 100) return null;
      const last = items[items.length - 1];
      return {
        startAfter: last.dateAdded ? Date.parse(last.dateAdded) : undefined,
        startAfterId: last.id,
      };
    },
    maxPages: 200,
  })) {
    scanned++;
    if (matches(c)) hits.push(c);
  }

  if (firstErr && scanned === 0) {
    ctx.out.warn(`can't see contacts → HTTP ${firstErr}`, { degraded: true });
    return { location: LOC, criteria: crit, scanned: 0, matched: 0, contactIds: [], sample: [] };
  }

  const FULL = !!args.full;

  // Default lean: {id, name} sample. --full: full contact objects (email, phone, tags, etc.).
  const sample = hits.slice(0, TOP).map(c => {
    if (FULL) {
      return {
        name: c.contactName || ((c.firstName || '') + ' ' + (c.lastName || '')).trim() || c.email,
        email: c.email,
        phone: c.phone || null,
        tags: c.tags || [],
        id: c.id,
      };
    }
    return {
      id: c.id,
      name: c.contactName || ((c.firstName || '') + ' ' + (c.lastName || '')).trim() || c.email || '(no name)',
    };
  });

  return {
    location: LOC,
    criteria: crit,
    scanned,
    matched: hits.length,
    contactIds: hits.map(c => c.id),
    sample,
  };
}

export async function run(args, ctx) {
  const data = await collect(args, ctx);
  if (data === null) return 2; // usage error — no criteria

  ctx.out.data(data);
  const TOP = args.top ?? 20;

  ctx.out.card(() => {
    ctx.out.line(`\n  SEGMENT — ${data.matched} contact(s) match [${data.criteria.join(' AND ')}]  ·  ${data.scanned} scanned  ·  loc ${data.location}`);
    ctx.out.line('  ' + '─'.repeat(70));
    if (!data.sample.length) {
      ctx.out.line('  No matches.\n');
      return;
    }
    data.sample.forEach((c, i) => {
      const name = (c.name || '(no name)').slice(0, 26);
      ctx.out.line(`  ${String(i + 1).padStart(3)}. ${name.padEnd(26)} ${(c.email || '—').slice(0, 28).padEnd(28)} [${(c.tags || []).join(', ').slice(0, 20)}]`);
    });
    if (data.matched > TOP) ctx.out.line(`  … +${data.matched - TOP} more (--top to show, --json for all IDs)`);
    ctx.out.line('  ' + '─'.repeat(70));
    ctx.out.line(`  → hand to ghl-contacts: bulk-tag these ${data.matched} (L2 — I echo the count + tag, you confirm, then apply). NEVER auto-tagged here.\n`);
  });
  return 0;
}

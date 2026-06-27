// commands/triage.mjs — Who's waiting on a reply, longest first.
// Trust-fix #1: LOC from ctx.cfg.loc (no baked default).
// Trust-fix #2: conversations paginate to completion — --top N caps final sorted list only.
// READ-ONLY. Never sends. Agent drafts, human approves.
import { paginate } from '../lib/paginate.mjs';

export const meta = {
  name: 'triage',
  summary: 'Who is waiting on a reply, longest first',
  flags: [
    { name: '--top', type: 'int', default: 10, desc: 'max threads to show' },
    { name: '--days', type: 'int', default: 30, desc: 'lookback window' },
  ],
  readOnly: true,
};

const CHAN = {
  TYPE_SMS: 'SMS', TYPE_EMAIL: 'Email', TYPE_PHONE: 'Call', TYPE_FB: 'FB',
  TYPE_IG: 'IG', TYPE_WHATSAPP: 'WhatsApp', TYPE_GMB: 'GMB',
  TYPE_LIVE_CHAT: 'Chat', TYPE_NO_SHOW: '(no-show)',
};

export async function collect(args, ctx) {
  const TOP = args.top ?? 10;
  const DAYS = args.days ?? 30;
  const LOC = ctx.cfg.loc;
  const NOW = ctx.now;
  const START = NOW - DAYS * 24 * 60 * 60 * 1000;
  const ago = (ms) => {
    const d = Math.floor((NOW - ms) / 86400000);
    if (d >= 1) return d + 'd';
    const h = Math.floor((NOW - ms) / 3600000);
    if (h >= 1) return h + 'h';
    return Math.max(1, Math.floor((NOW - ms) / 60000)) + 'm';
  };

  // paginate conversations to completion — limit:100 per page, offset-based (trust-fix #2)
  const convos = [];
  let convErr = null;
  for await (const c of paginate({
    fetchPage: async (offset = 0) => {
      const r = await ctx.http.get('/conversations/search', {
        query: { locationId: LOC, limit: 100, offset },
        version: '2021-04-15',
      });
      if (!r.ok) return { _err: r.code, conversations: [] };
      return r.j;
    },
    getItems: (resp) => {
      if (resp._err) { convErr = resp._err; return []; }
      return resp.conversations || resp.data || [];
    },
    nextCursor: (resp, items, offset = 0) => {
      if (resp._err || items.length < 100) return null;
      return offset + 100;
    },
    maxPages: 200,
    startCursor: 0,
  })) {
    convos.push(c);
  }

  if (convErr && convos.length === 0) {
    ctx.out.warn(`can't see conversations → HTTP ${convErr}`, { degraded: true });
    return { location: LOC, scanned: 0, waiting: 0, shown: 0, threads: [] };
  }

  const waiting = convos
    .filter(c => (c.unreadCount || 0) > 0 && (c.lastMessageDate || 0) >= START)
    .sort((a, b) => (a.lastMessageDate || 0) - (b.lastMessageDate || 0));
  const top = waiting.slice(0, TOP);

  // fetch last inbound snippet for context (top-N only, cheap)
  async function lastInbound(convId) {
    const r = await ctx.http.get(`/conversations/${encodeURIComponent(convId)}/messages`, {
      query: { limit: 20 },
      version: '2021-04-15',
    });
    if (!r.ok) return '';
    const msgs = r.j.messages?.messages || r.j.messages || r.j.data || [];
    const inb = msgs.find(m => (m.direction || '').toLowerCase() === 'inbound');
    const b = (inb?.body || inb?.message || '').replace(/\s+/g, ' ').trim();
    return b.slice(0, 90);
  }

  for (const c of top) { c._snippet = await lastInbound(c.id); }

  return {
    location: LOC,
    scanned: convos.length,
    waiting: waiting.length,
    shown: top.length,
    threads: top.map(c => ({
      rank: 0,
      name: c.contactName || c.fullName,
      channel: CHAN[c.lastMessageType] || c.type,
      waiting: ago(c.lastMessageDate),
      unread: c.unreadCount,
      snippet: c._snippet,
      conversationId: c.id,
      contactId: c.contactId,
      email: c.email,
    })),
  };
}

export async function run(args, ctx) {
  const data = await collect(args, ctx);
  ctx.out.data(data);

  const TOP = args.top ?? 10;
  const DAYS = args.days ?? 30;
  const LOC = ctx.cfg.loc;
  const NOW = ctx.now;
  const ago = (ms) => {
    const d = Math.floor((NOW - ms) / 86400000);
    if (d >= 1) return d + 'd';
    const h = Math.floor((NOW - ms) / 3600000);
    if (h >= 1) return h + 'h';
    return Math.max(1, Math.floor((NOW - ms) / 60000)) + 'm';
  };

  ctx.out.card(() => {
    ctx.out.line(`\n  TRIAGE — ${data.waiting} thread(s) waiting on you  ·  showing top ${data.shown}  ·  last ${DAYS}d  ·  loc ${LOC}`);
    ctx.out.line('  ' + '─'.repeat(72));
    if (!data.threads.length) {
      ctx.out.line('  Inbox clear — nobody waiting on a reply. ✅\n');
      return;
    }
    // reconstruct display from convos in data — thread ordering preserved
    data.threads.forEach((t, i) => {
      const name = (t.name || '(no name)').slice(0, 22);
      const chan = (t.channel || '?').replace('TYPE_', '');
      ctx.out.line(`  ${String(i + 1).padStart(2)}. ${name.padEnd(22)} ${chan.padEnd(7)} waiting ${(t.waiting || '?').padEnd(4)} · ${t.unread} unread`);
      if (t.snippet) ctx.out.line(`      "${t.snippet}"`);
      ctx.out.line(`      conv ${t.conversationId} · contact ${t.contactId}`);
      if (t.contactId) ctx.out.line(`      → sizmo send ${t.contactId} --channel sms --message "..."   ·   sizmo open ${t.contactId}`);
    });
    ctx.out.line('  ' + '─'.repeat(72));
    ctx.out.line('  → I draft a reply per thread; you approve each before it sends (L2, human-gated).\n');
  });
  return 0;
}

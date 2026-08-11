// commands/invoice.mjs — LIST invoices, create a DRAFT invoice for a contact, or SEND an existing one.
// Scope required: invoices.write
// SCOPE-IS-THE-GATE: sizmo exposes what your PIT scope + the public GHL API allow. There is no
// public "charge a card" endpoint — `draft` creates a document, `send` delivers a pay-link the
// customer acts on. Every op is confirm-gated; nothing fires without --confirm.
import { requireConfirm } from '../lib/confirm.mjs';
import { GhlError, EXIT } from '../lib/errors.mjs';
import { paginate } from '../lib/paginate.mjs';
import { notePartialScan } from '../lib/blind.mjs';
// The single money formatter. invoice draft used to format its own totals two different ways and
// neither went through here — see the note at the preview line below.
import { fmtMoney } from '../lib/money.mjs';
import { ymd } from '../lib/dates.mjs';

const SCOPE_FIX = 'GoHighLevel → Settings → Private Integrations → edit your PIT → add invoices.write scope';

// `invoice draft` touches THREE scopes, not one: it reads the contact (contacts.readonly), reads
// the location for the business name (locations.readonly), then writes the invoice (invoices.write).
// Naming the wrong one sends the user to add a scope they already have while the real gap stays.
const scopeFix = (scope) =>
  `GoHighLevel → Settings → Private Integrations → edit your PIT → add ${scope} scope`;

// The subcommand list, declared once so `sizmo schema` and the dispatch below cannot
// disagree. test/client/schema-subcommands.test.mjs extracts the verbs this file actually
// dispatches on and fails if they differ from this array.
const SUBCOMMANDS = ['list', 'draft', 'send'];

export const meta = {
  name: 'invoice',
  summary: 'list invoices, create a draft invoice for a contact, or send an existing invoice (pay-link)',
  subcommands: SUBCOMMANDS,
  flags: [
    { name: '--contact',  type: 'string', desc: 'contact id (draft)' },
    { name: '--item',     type: 'string', desc: 'line item "Name:amount[:qty]" — repeat with commas' },
    { name: '--currency', type: 'string', desc: 'ISO currency (draft, default PHP)' },
    { name: '--name',     type: 'string', desc: 'invoice title (draft)' },
    { name: '--due',      type: 'string', desc: 'due date YYYY-MM-DD (draft, default +14d)' },
    { name: '--status',   type: 'string', desc: 'filter by status, e.g. draft|sent|paid|void (list)' },
    { name: '--top',      type: 'int',    desc: 'max rows to show (list, default 20)' },
  ],
  readOnly: false,
};

function parseItems(raw, currency) {
  // "Setup:5000, Retainer:3000:2" → [{name, amount, qty, currency}]
  return String(raw).split(',').map(s => s.trim()).filter(Boolean).map(part => {
    const bits = part.split(':').map(b => b.trim());
    const name = bits[0];
    const amount = Number(bits[1]);
    const qty = bits[2] != null ? Number(bits[2]) : 1;
    if (!name || !Number.isFinite(amount) || amount <= 0) {
      throw new GhlError(`invoice: bad --item "${part}" — expected "Name:amount[:qty]" with amount > 0`, EXIT.USAGE);
    }
    return { name, currency, amount, qty: Number.isFinite(qty) && qty > 0 ? qty : 1 };
  });
}


export async function run(args, ctx) {
  const sub = args._?.[0];
  if (sub === 'list') return listInvoices(args, ctx);
  if (sub === 'draft') return draftInvoice(args, ctx);
  if (sub === 'send') return sendInvoice(args, ctx);
  throw new GhlError(
    'usage: sizmo invoice list [--status draft] [--top 20]\n' +
    '       sizmo invoice draft --contact <id> --item "Name:amount"\n' +
    '       sizmo invoice send <invoiceId>',
    EXIT.USAGE, 'sizmo invoice --help');
}

// ── list ─────────────────────────────────────────────────────────────────────
//
// WHY THIS EXISTS
// `invoice draft` printed the new invoice's id exactly once, and `invoice send <id>` needs it. No
// command could find it again. `receivables` fetches every invoice but then keeps only the
// unpaid-and-issued statuses, so a DRAFT is filtered out by design — correctly, since a draft is not
// receivable. Lose the terminal output and the draft was unreachable except through `sizmo api`.
//
// READ-ONLY. Uses the exact request receivables has been paginating in production, so no new API
// assumption is introduced: GET /invoices/ with altId/altType and offset paging.
const LIST_TOP_DEFAULT = 20;
const LIST_PAGE = 100;

async function listInvoices(args, ctx) {
  const LOC = ctx.cfg.loc;
  const TOP = args.top ?? LIST_TOP_DEFAULT;
  if (!Number.isInteger(TOP) || TOP < 1) {
    throw new GhlError(`--top must be a positive integer (got ${JSON.stringify(args.top)})`, EXIT.USAGE,
      'example: sizmo invoice list --top 50');
  }
  // Filter locally rather than trusting an undocumented server-side status param. The status
  // vocabulary GoHighLevel returns is known from receivables; which query params it accepts for
  // filtering is not, and guessing at an API's behaviour is how a filter silently returns nothing.
  const wantStatus = args.status ? String(args.status).trim().toLowerCase() : null;

  const rows = [];
  let firstErr = null;
  const stats = { pages: 0, truncated: false };
  for await (const inv of paginate({
    fetchPage: async (offset = 0) => {
      const r = await ctx.http.get('/invoices/', {
        query: { altId: LOC, altType: 'location', limit: LIST_PAGE, offset },
      });
      if (!r.ok) return { _err: r.code, invoices: [] };
      return r.j;
    },
    getItems: (resp) => {
      if (resp._err) { firstErr ??= resp._err; return []; }
      return resp.invoices || resp.data || [];
    },
    nextCursor: (resp, items, offset = 0) => {
      if (resp._err || items.length < LIST_PAGE) return null;
      return offset + LIST_PAGE;
    },
    maxPages: 100,
    startCursor: 0,
    stats,
  })) {
    rows.push(inv);
  }

  // Nothing at all came back: UNKNOWN, never an empty list. "You have no invoices" and "I could not
  // read your invoices" are different answers and only one of them is safe to act on.
  if (firstErr && rows.length === 0) {
    if (firstErr === 401 || firstErr === 403) {
      throw new GhlError(`HTTP ${firstErr} — your PIT lacks invoices.readonly`, EXIT.AUTH,
        scopeFix('invoices.readonly'));
    }
    throw new GhlError(`could not read invoices — HTTP ${firstErr}`, EXIT.API);
  }
  // A later page failed: what came back is real, the list is a floor.
  const partial = notePartialScan({ err: firstErr, count: rows.length, source: 'invoices', ctx });
  if (stats.truncated) {
    ctx.out.warn(`invoices truncated at ${stats.pages} pages (${rows.length} invoices) — more exist`,
      { degraded: true });
  }

  const mapped = rows.map((i) => {
    const total = Number(i.total ?? i.amount ?? i.invoiceTotal ?? 0);
    const paid = Number(i.amountPaid ?? i.totalPaid ?? 0);
    return {
      id: i._id || i.id,
      number: i.invoiceNumber ?? null,
      status: String(i.status ?? '').toLowerCase() || null,
      name: i.name ?? null,
      contactName: i.contactDetails?.name ?? null,
      contactId: i.contactDetails?.id ?? i.contactDetails?._id ?? i.contactId ?? null,
      currency: (i.currency || 'PHP').toUpperCase(),
      total,
      amountPaid: paid,
      due: total - paid,
      issueDate: i.issueDate ?? null,
      dueDate: i.dueDate ?? null,
    };
  });
  const filtered = wantStatus ? mapped.filter(x => x.status === wantStatus) : mapped;
  // Ordered newest-first by issue date so the invoice you just drafted is the top row — which is the
  // situation this command exists for.
  filtered.sort((a, b) => (Date.parse(b.issueDate || b.dueDate || 0) || 0) - (Date.parse(a.issueDate || a.dueDate || 0) || 0));
  const shown = filtered.slice(0, TOP);

  const byStatus = {};
  for (const x of mapped) byStatus[x.status ?? 'unknown'] = (byStatus[x.status ?? 'unknown'] ?? 0) + 1;

  ctx.out.data({
    location: LOC,
    scanned: mapped.length,
    matched: filtered.length,
    shown: shown.length,
    ...(wantStatus ? { status: wantStatus } : {}),
    byStatus,
    ...(partial || stats.truncated ? { truncated: true, ...(partial ? { partialScanError: firstErr } : {}) } : {}),
    invoices: shown,
  });

  ctx.out.card(() => {
    const floor = (partial || stats.truncated) ? 'at least ' : '';
    ctx.out.line(`\n  INVOICES — ${floor}${filtered.length}${wantStatus ? ` with status "${wantStatus}"` : ''}  ·  ${mapped.length} scanned  ·  loc ${LOC}`);
    ctx.out.line('  ' + '─'.repeat(76));
    if (!filtered.length) {
      if (wantStatus) {
        ctx.out.line(`  No invoice with status "${wantStatus}".`);
        const seen = Object.keys(byStatus).filter(Boolean).sort();
        if (seen.length) ctx.out.line(`  Statuses present: ${seen.join(', ')}`);
      } else {
        ctx.out.line('  No invoices in this location.');
      }
      ctx.out.line('');
      return;
    }
    for (const x of shown) {
      const num = (x.number ? `#${x.number}` : '(no number)').padEnd(12);
      const who = (x.contactName || x.name || '?').slice(0, 22).padEnd(22);
      ctx.out.line(`  ${num} ${who} ${fmtMoney(x.total, x.currency).padStart(12)}  ${String(x.status ?? '?').padEnd(16)} ${x.dueDate ? `due ${String(x.dueDate).slice(0, 10)}` : ''}`);
      ctx.out.line(`      id ${x.id}`);
    }
    if (filtered.length > shown.length) ctx.out.line(`  … +${filtered.length - shown.length} more — raise --top`);
    ctx.out.line('  ' + '─'.repeat(76));
    ctx.out.line('  Copy an id → sizmo invoice send <id> --confirm   # delivers a pay-link, never charges a card\n');
  });
  return EXIT.OK;
}

async function draftInvoice(args, ctx) {
  const contactId = args.contact;
  if (!contactId) throw new GhlError('invoice draft requires --contact <id>', EXIT.USAGE);
  if (!args.item) throw new GhlError('invoice draft requires at least one --item "Name:amount"', EXIT.USAGE);
  const currency = (args.currency || 'PHP').toUpperCase();
  const items = parseItems(args.item, currency);
  const loc = ctx.cfg.loc;
  const now = typeof ctx.now === 'function' ? ctx.now() : ctx.now;
  const issueDate = ymd(now);
  const dueDate = args.due || ymd(now + 14 * 86400000);

  // Pull the contact so contactDetails carries a real name/email (GHL expects more than a bare id).
  const cg = await ctx.http.get(`/contacts/${encodeURIComponent(contactId)}`);
  // This GET is /contacts/{id} — it needs contacts.readonly. It previously blamed invoices.write.
  if (cg.code === 401 || cg.code === 403) {
    throw new GhlError(`HTTP ${cg.code} — your PIT lacks contacts.readonly (needed to read the contact for this invoice)`,
      EXIT.AUTH, scopeFix('contacts.readonly'));
  }
  if (cg.code === 404) throw new GhlError(`no contact with id ${contactId} — nothing created`, EXIT.NOTFOUND);
  const c = cg.j?.contact ?? cg.j ?? {};
  const contactName = c.contactName || [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || 'Customer';
  const contactDetails = { id: contactId, name: contactName, ...(c.email ? { email: c.email } : {}), ...(c.phone ? { phoneNo: c.phone } : {}) };

  // GHL requires businessDetails.name — pull it from the location's business profile.
  //
  // This response was UNCHECKED until 2026-07-27. A 401/404/500 here fell through to the string
  // literal 'Business', and the invoice was created and sent anyway with exit 0 and no warning —
  // so a real customer received a money document naming the vendor "Business". Verified by
  // fixture: location 401, 404 and 500 all produced businessDetails={"name":"Business"}.
  //
  // sizmo already refuses to fabricate NUMBERS on a blocked source (a blocked lane reports UNKNOWN,
  // never zero — test/docs/blocked-is-not-zero.test.mjs). Fabricating the vendor's NAME on an
  // invoice is the same rule, and the consequence is more visible: the customer reads it.
  //
  // Refusing is the right failure here. The alternative — send it with a placeholder — is a wrong
  // invoice, and a wrong invoice is worse than no invoice.
  const lg = await ctx.http.get(`/locations/${encodeURIComponent(loc)}`);
  if (lg.code === 401 || lg.code === 403) {
    throw new GhlError(
      `HTTP ${lg.code} — your PIT lacks locations.readonly (needed for the business name on the invoice)`,
      EXIT.AUTH, scopeFix('locations.readonly'));
  }
  if (!lg.ok) {
    throw new GhlError(
      `could not read location ${loc} for the business name — HTTP ${lg.code}. Nothing was created.`,
      EXIT.API);
  }
  const locItem = lg.j?.location ?? lg.j ?? {};
  const businessName = locItem.business?.name || locItem.name;
  if (!businessName || !String(businessName).trim()) {
    throw new GhlError(
      `location ${loc} has no business name set — GHL requires one on every invoice. Nothing was created.`,
      EXIT.API,
      'GoHighLevel → Settings → Business Profile → set the business name, then rerun');
  }

  const total = items.reduce((s, i) => s + i.amount * i.qty, 0);
  const name = args.name || `Invoice for ${contactName}`;
  const body = {
    altId: loc, altType: 'location',
    name, currency, items, contactDetails,
    issueDate, dueDate, liveMode: true,
    businessDetails: { name: businessName },
  };

  const changes = [
    `Create DRAFT invoice "${name}" for ${contactName} (contact ${contactId})`,
    // The CONFIRM PREVIEW and the created-invoice line below used to format the same total two
    // different ways, both bypassing lib/money.mjs: this one passed maximumFractionDigits: 0 and the
    // other passed no options at all (so a default of 3). For a total of 201.005 the preview said
    // "201" and the success line said "201.005" — one invoice, two numbers, in one command run.
    // On a confirm gate that is the difference between the amount approved and the amount created.
    // Both now go through fmtMoney, so they cannot disagree, and the symbol matches every other
    // money surface in the tool instead of printing a bare currency code.
    `  ${items.length} item(s) · ${fmtMoney(total, currency)} · due ${dueDate}`,
    '  draft only — NOT sent, no charge. Send later with: sizmo invoice send <id>',
  ];
  // --due MUST round-trip. It was omitted here while the preview above printed the resolved due
  // date, so approving "due 2026-12-25" and running the offered command produced an invoice due
  // +14d instead. The confirm gate's whole promise is that rerunning fires what you previewed —
  // on a money document that is the difference between the terms the client agreed to and
  // different ones.
  const duePart = args.due ? ` --due ${args.due}` : '';
  const rerunCommand = `sizmo invoice draft --contact ${contactId} --item "${args.item.replace(/"/g, '\\"')}" --currency ${currency}${args.name ? ` --name "${String(args.name).replace(/"/g, '\\"')}"` : ''}${duePart} --confirm`;
  const gate = requireConfirm({ command: 'invoice draft', changes, rerunCommand }, ctx);
  if (!gate.proceed) return gate.code;

  const r = await ctx.http.post('/invoices/', body);
  if (r.code === 401 || r.code === 403) throw new GhlError(`HTTP ${r.code} — your PIT lacks invoices.write`, EXIT.AUTH, SCOPE_FIX);
  if (!r.ok) throw new GhlError(`invoice draft failed — HTTP ${r.code}: ${(r.txt || '').slice(0, 240).replace(/\s+/g, ' ')}`, EXIT.API);

  const inv = r.j?.invoice ?? r.j ?? {};
  const id = inv._id || inv.id || null;
  ctx.out.data({ status: 'ok', command: 'invoice draft', invoiceId: id, currency, total });
  ctx.out.line(`  draft invoice created · id ${id ?? '(see response)'} · ${fmtMoney(total, currency)} · NOT sent`);
  return EXIT.OK;
}

async function sendInvoice(args, ctx) {
  const id = args._?.[1];
  if (!id || !String(id).trim()) throw new GhlError('usage: sizmo invoice send <invoiceId> — exactly one id', EXIT.USAGE);
  const loc = ctx.cfg.loc;

  const changes = [
    `Send invoice ${id} to its contact (delivers a pay-link / text-to-pay)`,
    '  ⚠ this notifies the customer and requests payment — it does NOT charge a card',
  ];
  const rerunCommand = `sizmo invoice send ${id} --confirm`;
  const gate = requireConfirm({ command: 'invoice send', changes, rerunCommand }, ctx);
  if (!gate.proceed) return gate.code;

  const r = await ctx.http.post(`/invoices/${encodeURIComponent(id)}/send`, { altId: loc, altType: 'location', liveMode: true });
  if (r.code === 401 || r.code === 403) throw new GhlError(`HTTP ${r.code} — your PIT lacks invoices.write`, EXIT.AUTH, SCOPE_FIX);
  if (r.code === 404) throw new GhlError(`no invoice with id ${id} — nothing sent`, EXIT.NOTFOUND);
  if (!r.ok) throw new GhlError(`invoice send failed — HTTP ${r.code}: ${(r.txt || '').slice(0, 240).replace(/\s+/g, ' ')}`, EXIT.API);

  ctx.out.data({ status: 'ok', command: 'invoice send', invoiceId: id });
  ctx.out.line(`  invoice ${id} sent (pay-link delivered)`);
  return EXIT.OK;
}

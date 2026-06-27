// commands/invoice.mjs — create a DRAFT invoice for a contact, or SEND an existing invoice.
// Scope required: invoices.write
// SCOPE-IS-THE-GATE: sizmo exposes what your PIT scope + the public GHL API allow. There is no
// public "charge a card" endpoint — `draft` creates a document, `send` delivers a pay-link the
// customer acts on. Every op is confirm-gated; nothing fires without --confirm.
import { requireConfirm } from '../lib/confirm.mjs';
import { GhlError, EXIT } from '../lib/errors.mjs';

const SCOPE_FIX = 'GoHighLevel → Settings → Private Integrations → edit your PIT → add invoices.write scope';

export const meta = {
  name: 'invoice',
  summary: 'create a draft invoice for a contact, or send an existing invoice (pay-link)',
  flags: [
    { name: '--contact',  type: 'string', desc: 'contact id (draft)' },
    { name: '--item',     type: 'string', desc: 'line item "Name:amount[:qty]" — repeat with commas' },
    { name: '--currency', type: 'string', desc: 'ISO currency (draft, default PHP)' },
    { name: '--name',     type: 'string', desc: 'invoice title (draft)' },
    { name: '--due',      type: 'string', desc: 'due date YYYY-MM-DD (draft, default +14d)' },
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

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

export async function run(args, ctx) {
  const sub = args._?.[0];
  if (sub === 'draft') return draftInvoice(args, ctx);
  if (sub === 'send') return sendInvoice(args, ctx);
  throw new GhlError('usage: sizmo invoice draft --contact <id> --item "Name:amount" | sizmo invoice send <invoiceId>', EXIT.USAGE, 'sizmo invoice --help');
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
  if (cg.code === 401 || cg.code === 403) throw new GhlError(`HTTP ${cg.code} — your PIT lacks invoices.write`, EXIT.AUTH, SCOPE_FIX);
  if (cg.code === 404) throw new GhlError(`no contact with id ${contactId} — nothing created`, EXIT.NOTFOUND);
  const c = cg.j?.contact ?? cg.j ?? {};
  const contactName = c.contactName || [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || 'Customer';
  const contactDetails = { id: contactId, name: contactName, ...(c.email ? { email: c.email } : {}), ...(c.phone ? { phoneNo: c.phone } : {}) };

  // GHL requires businessDetails.name — pull it from the location's business profile.
  const lg = await ctx.http.get(`/locations/${encodeURIComponent(loc)}`);
  const locItem = lg.j?.location ?? lg.j ?? {};
  const businessName = locItem.business?.name || locItem.name || 'Business';

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
    `  ${items.length} item(s) · ${currency} ${total.toLocaleString('en-PH', { maximumFractionDigits: 0 })} · due ${dueDate}`,
    '  draft only — NOT sent, no charge. Send later with: sizmo invoice send <id>',
  ];
  const rerunCommand = `sizmo invoice draft --contact ${contactId} --item "${args.item.replace(/"/g, '\\"')}" --currency ${currency}${args.name ? ` --name "${String(args.name).replace(/"/g, '\\"')}"` : ''} --confirm`;
  const gate = requireConfirm({ command: 'invoice draft', changes, rerunCommand }, ctx);
  if (!gate.proceed) return gate.code;

  const r = await ctx.http.post('/invoices/', body);
  if (r.code === 401 || r.code === 403) throw new GhlError(`HTTP ${r.code} — your PIT lacks invoices.write`, EXIT.AUTH, SCOPE_FIX);
  if (!r.ok) throw new GhlError(`invoice draft failed — HTTP ${r.code}: ${(r.txt || '').slice(0, 240).replace(/\s+/g, ' ')}`, EXIT.API);

  const inv = r.j?.invoice ?? r.j ?? {};
  const id = inv._id || inv.id || null;
  ctx.out.data({ status: 'ok', command: 'invoice draft', invoiceId: id, currency, total });
  ctx.out.line(`  draft invoice created · id ${id ?? '(see response)'} · ${currency} ${total.toLocaleString('en-PH')} · NOT sent`);
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

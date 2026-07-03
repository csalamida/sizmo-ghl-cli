// commands/transactions.mjs — payment transaction history.
// READ-ONLY — money never moves from the CLI.
//
// sizmo transactions [--top N] [--type subscription|order|product]
//
// GHL payments API uses altId/altType (not locationId) for location-scoped queries.
// API returns: contactName, contactId, amount, currency, status, entityType, entityId, createdAt.

import { EXIT } from '../lib/errors.mjs';

export const meta = {
  name: 'transactions',
  summary: 'payment transaction history — read-only',
  flags: [
    { name: '--top',  type: 'number', desc: 'max rows (default 25, max 100)' },
    { name: '--type', type: 'string', desc: 'filter by entityType: subscription | order | product' },
  ],
  readOnly: true,
};

const DEFAULT_TOP = 25;
const MAX_TOP     = 100;

export async function run(parsed, ctx) {
  const top        = Math.min(Number(parsed.top) || DEFAULT_TOP, MAX_TOP);
  const entityType = parsed.type?.trim() || null;

  const loc = ctx.cfg.loc;

  // Payments API uses altId/altType instead of locationId.
  const qs = new URLSearchParams({
    altId:   loc,
    altType: 'location',
    limit:   String(top),
  });
  if (entityType) qs.set('entityType', entityType);

  let transactions = [];
  let total = 0;

  try {
    const r = await ctx.http.get(`/payments/transactions?${qs}`);
    if (r.code === 401 || r.code === 403) {
      ctx.out.line('✖ transactions blocked — needs payments.readonly scope');
      ctx.out.line('  Add scope in GHL → Settings → Integrations → Private Integrations');
      return EXIT.AUTH;
    }
    if (!r.ok) {
      ctx.out.line(`✖ API error ${r.code}: ${r.j?.message ?? 'unknown'}`);
      return EXIT.API;
    }
    transactions = r.j?.transactions ?? r.j?.data ?? r.j?.results ?? [];
    if (!Array.isArray(transactions)) {
      ctx.out.warn(`unexpected response shape — raw keys: ${Object.keys(r.j ?? {}).join(', ')}`);
      transactions = [];
    }
    total = r.j?.total ?? r.j?.count ?? transactions.length;
  } catch (e) {
    ctx.out.warn(`could not fetch transactions: ${e.message}`);
    return EXIT.API;
  }

  ctx.out.data({ transactions, total, top });

  if (transactions.length === 0) {
    ctx.out.line('');
    ctx.out.line('  TRANSACTIONS — none found');
    if (entityType) ctx.out.line(`  (filtered to type: ${entityType})`);
    ctx.out.line('');
    return EXIT.OK;
  }

  const nameW = Math.min(28, transactions.reduce((m, t) =>
    Math.max(m, (t.contactName || '').length), 12) + 2);

  ctx.out.line('');
  ctx.out.line(`  TRANSACTIONS (showing ${transactions.length} of ${total})`);
  if (entityType) ctx.out.line(`  filter: entityType = ${entityType}`);
  ctx.out.line('  ' + '─'.repeat(nameW + 58));
  ctx.out.line(`  ${'Name'.padEnd(nameW)}  ${'Amount'.padStart(12)}  ${'Status'.padEnd(14)}  ${'Type'.padEnd(14)}  Date`);
  ctx.out.line('  ' + '─'.repeat(nameW + 58));

  for (const t of transactions) {
    const name   = pad(t.contactName || '—', nameW);
    const cur    = t.currency || 'USD';
    const amount = formatAmount(t.amount ?? t.amountDue, cur);
    const status = pad(t.status || '—', 14);
    const type   = pad(t.entityType || '—', 14);
    const date   = t.createdAt ? String(t.createdAt).slice(0, 10) : '—';
    ctx.out.line(`  ${name}  ${amount.padStart(12)}  ${status}  ${type}  ${date}`);
  }

  ctx.out.line('  ' + '─'.repeat(nameW + 58));
  ctx.out.line(`  Use --top to show more (max ${MAX_TOP}) · --type to filter by entityType`);
  ctx.out.line('  Contact lookup → sizmo contact search --email <email>\n');
  return EXIT.OK;
}

function pad(s, n) { return String(s ?? '').slice(0, n).padEnd(n); }

function formatAmount(raw, currency) {
  if (raw == null) return '—';
  const num = typeof raw === 'number' ? raw : Number(raw);
  if (isNaN(num)) return String(raw);
  // GHL payments API returns amounts as floats in the currency unit (not cents).
  // Show exactly what the API returns — never transform, never assume.
  return `${currency} ${num.toFixed(2)}`;
}

// lib/prioritize.mjs — Transparent money-at-stake ranker.
// Pure function, no I/O. Honesty law: rank ONLY by money we can actually see.
// Items with no known value go to a SEPARATE unknownValue group — never faked as ₱0.
// Every output line shows its inputs. No hidden score. No currency conversion.

const SYM = { PHP: '₱', USD: '$', EUR: '€', GBP: '£' };
const fmt = (n, c = 'PHP') => (SYM[c] || c + ' ') + Number(n || 0).toLocaleString('en-PH', { maximumFractionDigits: 0 });

/**
 * rankActions({ deals, invoices, threads, noshows, neverBilled })
 *
 * Each input array element shape:
 *   deals:       { contactId, name, monetaryValue, ageDays }
 *   invoices:    { contactId, name, due, cur, ageDays }
 *   threads:     { contactId, name, ageDays }                — no known money
 *   noshows:     { contactId, name, ageDays }                — no known money
 *   neverBilled: { contactId, name, estValue, ageDays }      — estValue>0 counts; 0/null → unknownValue
 *
 * Returns:
 *   ranked      — money items, sorted money desc, tie-break age desc
 *                 each: { money, cur, age, kind, contact, name, action, inputs }
 *   unknownValue — threads + noshows + zero-est neverBilled, sorted age desc
 *                 each: { money:null, age, kind, contact, name, action, inputs }
 *
 * Mixed-currency caveat: sort is by raw number with currency labeled per line.
 * PHP 1000 vs USD 100 — the sort compares raw values without conversion.
 * If mixed currencies are present in ranked, callers should surface a caveat footer.
 */
export function rankActions({
  deals = [],
  invoices = [],
  threads = [],
  noshows = [],
  neverBilled = [],
} = {}) {
  const ranked = [];
  const unknownValue = [];

  // ── deals: monetaryValue>0 → ranked; 0/unset → unknownValue ──────────────────
  // A deal with no monetaryValue is value-UNKNOWN (coach didn't enter one), NOT worth ₱0.
  // Faking it as ₱0 and ranking it at the bottom of the money list is the fake-intelligence
  // bug — an unset value is unknown, surfaced honestly, never a fabricated zero.
  for (const d of deals) {
    const money = Number(d.monetaryValue) || 0;
    // GHL opportunity monetaryValue has no currency field — treated as PHP (known GHL limitation)
    if (money > 0) {
      ranked.push({
        money, cur: 'PHP', age: d.ageDays, kind: 'deal', contact: d.contactId, name: d.name,
        action: 'ghl pipeline', inputs: `${fmt(money, 'PHP')} deal · idle ${d.ageDays}d`,
      });
    } else {
      unknownValue.push({
        money: null, age: d.ageDays, kind: 'deal', contact: d.contactId, name: d.name,
        action: 'ghl pipeline', inputs: `open deal · no value set · idle ${d.ageDays}d · value unknown`,
      });
    }
  }

  // ── invoices: due>0 → ranked; ≤0 → unknownValue (defensive; receivables only returns due>0) ──
  for (const i of invoices) {
    const money = Number(i.due) || 0;
    const cur = (i.cur || 'PHP').toUpperCase();
    if (money > 0) {
      ranked.push({
        money, cur, age: i.ageDays, kind: 'invoice', contact: i.contactId, name: i.name,
        action: 'ghl receivables', inputs: `${fmt(money, cur)} invoice due · aged ${i.ageDays}d`,
      });
    } else {
      unknownValue.push({
        money: null, age: i.ageDays, kind: 'invoice', contact: i.contactId, name: i.name,
        action: 'ghl receivables', inputs: `invoice · no balance shown · aged ${i.ageDays}d · value unknown`,
      });
    }
  }

  // ── never-billed: real estValue>0 → ranked; 0/null/undefined → unknownValue ──
  for (const b of neverBilled) {
    const est = Number(b.estValue);
    if (est > 0) {
      ranked.push({
        money: est,
        cur: 'PHP',
        age: b.ageDays,
        kind: 'never-billed',
        contact: b.contactId,
        name: b.name,
        action: 'ghl booked-not-paid',
        inputs: `${fmt(est, 'PHP')} est. value · never billed · last session ${b.ageDays}d ago`,
      });
    } else {
      unknownValue.push({
        money: null,
        age: b.ageDays,
        kind: 'never-billed',
        contact: b.contactId,
        name: b.name,
        action: 'ghl booked-not-paid',
        inputs: `never billed · last session ${b.ageDays}d ago · value unknown`,
      });
    }
  }

  // ── threads (waiting on reply) — no known money ───────────────────────────
  for (const t of threads) {
    unknownValue.push({
      money: null,
      age: t.ageDays,
      kind: 'waiting-reply',
      contact: t.contactId,
      name: t.name,
      action: 'ghl triage',
      inputs: `waiting ${t.ageDays}d · value unknown`,
    });
  }

  // ── noshows — no known money ───────────────────────────────────────────────
  for (const n of noshows) {
    unknownValue.push({
      money: null,
      age: n.ageDays,
      kind: 'noshow',
      contact: n.contactId,
      name: n.name,
      action: 'ghl noshow',
      inputs: `no-show ${n.ageDays}d ago · value unknown`,
    });
  }

  // ── sort ───────────────────────────────────────────────────────────────────
  // ranked: money desc, tie-break age desc (older = more urgent)
  ranked.sort((a, b) => b.money - a.money || b.age - a.age);
  // unknownValue: age desc
  unknownValue.sort((a, b) => b.age - a.age);

  return { ranked, unknownValue };
}

/**
 * hasMixedCurrencies(ranked) → boolean
 * True when ranked items span more than one currency.
 * Callers use this to surface the "raw-number sort, currencies labeled" caveat.
 */
export function hasMixedCurrencies(ranked) {
  const currencies = new Set(ranked.map(x => x.cur));
  return currencies.size > 1;
}

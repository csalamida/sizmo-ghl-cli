// lib/money.mjs — the SINGLE source for currency symbols + money formatting.
// Every command formats money through here so the symbol set can never drift between
// surfaces (before this, brief/snapshot knew AUD→A$ but the ranker/receivables didn't,
// so the same AUD invoice rendered "A$30,000" in one line and "AUD 30,000" in another).
//
// HONESTY: a non-finite amount renders as '—', never a fabricated 0. A missing/unknown
// currency renders the number with NO symbol (never assumes ₱) — callers that want a
// neutral "(currency unknown)" label add it themselves.
//
// NOTE on deals: GHL opportunity `monetaryValue` carries no currency field (it inherits the
// pipeline's config, which the API does not expose per-opportunity). pipeline + prioritize
// therefore format deal values as PHP by documented convention — that is NOT a drift bug,
// it is the only currency the API gives us for opportunities.

// Canonical symbol table — the union of every currency the tool has shown, plus the common
// international ones (Sizmo serves international, not PHP-only). Unknown codes fall back to a
// neutral "CODE " prefix.
export const SYM = {
  PHP: '₱', USD: '$', EUR: '€', GBP: '£', AUD: 'A$', CAD: 'C$',
  SGD: 'S$', NZD: 'NZ$', JPY: '¥', INR: '₹', HKD: 'HK$', AED: 'AED ',
};

// Locale used for digit grouping only (thousands separators). Not a currency assumption.
const GROUP_LOCALE = 'en-PH';

// symbolFor(cur) → the currency symbol, or a neutral "CODE " prefix when the code is unknown,
// or '' when no currency is given. NEVER assumes ₱.
export function symbolFor(cur) {
  if (!cur) return '';
  const c = String(cur).toUpperCase();
  return SYM[c] || (c + ' ');
}

// fmtMoney(n, cur) → "<sym><grouped>" — or '—' when n is not a finite number.
// cur omitted/unknown → the grouped number with no symbol (never assumes a currency).
export function fmtMoney(n, cur) {
  // null/undefined are UNKNOWN, not 0 — guard explicitly (Number(null) === 0 would fabricate ₱0).
  if (n == null) return '—';
  const num = Number(n);
  if (!Number.isFinite(num)) return '—';
  return symbolFor(cur) + num.toLocaleString(GROUP_LOCALE, { maximumFractionDigits: 0 });
}

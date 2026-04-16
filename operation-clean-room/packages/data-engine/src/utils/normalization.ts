const LEGAL_SUFFIXES = /\b(inc|llc|ltd|corp|corporation|gmbh|ag|sa|sas|bv|nv|pty|co|company|group|holdings|limited|incorporated)\b\.?/gi;
const COMMON_PREFIXES = /^the\s+/i;
const PUNCTUATION = /[.,\-'"\u2018\u2019\u201C\u201D()]/g;
const COLLAPSE_SPACES = /\s{2,}/g;

/**
 * Normalize a company name for fuzzy matching.
 *
 * Steps: lowercase, strip legal suffixes, strip "The " prefix,
 * remove punctuation, collapse spaces, trim.
 */
export function normalizeCompanyName(name: string): string {
  let n = name.toLowerCase();
  n = n.replace(COMMON_PREFIXES, '');
  n = n.replace(LEGAL_SUFFIXES, '');
  n = n.replace(PUNCTUATION, ' ');
  n = n.replace(COLLAPSE_SPACES, ' ');
  return n.trim();
}

const ZERO_DECIMAL_CURRENCIES = new Set(['jpy', 'krw', 'clp', 'vnd', 'bif', 'djf', 'gnf', 'kmf', 'mga', 'pyg', 'rwf', 'ugx', 'vuf', 'xaf', 'xof', 'xpf']);

/**
 * Normalize a monetary amount to major currency units.
 *
 * Heuristic:
 * - Zero-decimal currencies (JPY, KRW, etc.) returned as-is.
 * - Integers > 10,000 assumed to be in minor units -> divide by 100.
 * - Otherwise returned as-is.
 */
export function normalizeAmount(amount: number, currency: string): number {
  const c = currency.toLowerCase();
  if (ZERO_DECIMAL_CURRENCIES.has(c)) return amount;
  if (Number.isInteger(amount) && Math.abs(amount) > 10_000) {
    return amount / 100;
  }
  return amount;
}

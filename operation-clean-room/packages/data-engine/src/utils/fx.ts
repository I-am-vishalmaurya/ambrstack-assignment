import { FXRate } from '../ingestion/types.js';

export interface FXConversionResult {
  amountUSD: number;
  fxRateApproximated: boolean;
}

const SUPPORTED = new Set(['usd', 'eur', 'gbp', 'jpy', 'aud']);

function rateForCurrency(rateRow: FXRate, currency: string): number {
  const c = currency.toLowerCase();
  if (c === 'usd') return 1;
  if (c === 'eur') return rateRow.eur_usd;
  if (c === 'gbp') return rateRow.gbp_usd;
  if (c === 'jpy') return rateRow.jpy_usd;
  if (c === 'aud') return rateRow.aud_usd;
  throw new Error(`Unsupported currency: ${currency}`);
}

function pickRateRow(
  asOf: Date,
  rates: FXRate[],
): { row: FXRate; approximated: boolean } {
  if (rates.length === 0) throw new Error('No FX rates provided');
  const target = asOf.toISOString().slice(0, 10);
  const sorted = [...rates].sort((a, b) => (a.date < b.date ? -1 : 1));

  let best: FXRate | undefined;
  for (const r of sorted) {
    if (r.date <= target) best = r;
  }
  if (best) return { row: best, approximated: false };

  // Fallback: target date is before ALL available rates (Assumption Data #4).
  // Use the earliest available rate and flag as approximated.
  const earliest = sorted[0];
  if (!earliest) {
    throw new Error('FX rates array was unexpectedly empty after validation');
  }
  console.error(
    `[FX] No rate on or before ${target}; falling back to earliest available rate ${earliest.date} (fxRateApproximated: true)`,
  );
  return { row: earliest, approximated: true };
}

/**
 * Convert an amount from one currency to USD using historical FX rates,
 * returning metadata about whether the rate was approximated.
 */
export function convertToUSDWithMeta(
  amount: number,
  currency: string,
  date: Date,
  rates: FXRate[],
): FXConversionResult {
  const c = currency.toLowerCase();
  if (!SUPPORTED.has(c)) throw new Error(`Unsupported currency: ${currency}`);
  if (c === 'usd') return { amountUSD: amount, fxRateApproximated: false };
  const { row, approximated } = pickRateRow(date, rates);
  const fx = rateForCurrency(row, c);
  return { amountUSD: Math.round(amount * fx), fxRateApproximated: approximated };
}

/**
 * Convert an amount from one currency to USD using historical FX rates.
 *
 * Looks up the FX rate for the given date. If the exact date is not available
 * (e.g., weekends or holidays), falls back to the most recent prior trading
 * day's rate. If the date precedes all available rates (pre-July 2023 gap),
 * falls back to the earliest available rate per Assumption Data #4.
 *
 * Supported currencies: EUR, GBP, JPY, AUD.
 * USD amounts are returned as-is (no conversion needed).
 */
export function convertToUSD(
  amount: number,
  currency: string,
  date: Date,
  rates: FXRate[],
): number {
  return convertToUSDWithMeta(amount, currency, date, rates).amountUSD;
}

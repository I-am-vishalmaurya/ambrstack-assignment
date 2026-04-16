import { describe, it, expect } from 'vitest';
import { convertToUSD, convertToUSDWithMeta } from '../src/utils/fx.js';
import type { FXRate } from '../src/ingestion/types.js';

describe('convertToUSD', () => {
  const rates: FXRate[] = [
    { date: '2024-03-01', eur_usd: 1.08, gbp_usd: 1.26, jpy_usd: 0.0067, aud_usd: 0.65 },
    { date: '2024-03-15', eur_usd: 1.09, gbp_usd: 1.27, jpy_usd: 0.0066, aud_usd: 0.66 },
    { date: '2024-03-31', eur_usd: 1.07, gbp_usd: 1.25, jpy_usd: 0.0068, aud_usd: 0.64 },
  ];

  it('uses payment-date rate for EUR amounts', () => {
    const usdCents = convertToUSD(100_00, 'eur', new Date('2024-03-01T12:00:00Z'), rates);
    expect(usdCents).toBe(108_00);
  });

  it('returns USD amounts unchanged', () => {
    expect(convertToUSD(500_00, 'usd', new Date('2024-03-01'), rates)).toBe(500_00);
  });

  it('picks most recent prior rate for dates between entries', () => {
    const usdCents = convertToUSD(100_00, 'gbp', new Date('2024-03-10T00:00:00Z'), rates);
    expect(usdCents).toBe(126_00); // uses 2024-03-01 rate
  });

  it('throws on unsupported currency', () => {
    expect(() => convertToUSD(100_00, 'CHF', new Date('2024-03-01'), rates)).toThrow(
      'Unsupported currency',
    );
  });

  it('throws when no rates provided', () => {
    expect(() => convertToUSD(100_00, 'eur', new Date('2024-03-01'), [])).toThrow(
      'No FX rates provided',
    );
  });

  it('falls back to earliest rate when date precedes all rates (Assumption Data #4)', () => {
    const { amountUSD, fxRateApproximated } = convertToUSDWithMeta(
      100_00,
      'eur',
      new Date('2023-02-15T00:00:00Z'),
      rates,
    );
    expect(amountUSD).toBe(108_00);
    expect(fxRateApproximated).toBe(true);
  });

  it('marks non-approximated when exact date exists', () => {
    const { amountUSD, fxRateApproximated } = convertToUSDWithMeta(
      100_00,
      'eur',
      new Date('2024-03-15T00:00:00Z'),
      rates,
    );
    expect(amountUSD).toBe(109_00);
    expect(fxRateApproximated).toBe(false);
  });
});

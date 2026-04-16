import { join } from 'node:path';
import { loadCSV } from './csv-loader.js';
import { DATA_FILES } from '../data/paths.js';
import type { MarketingSpend } from './types.js';

function parseNum(s: string, field: string): number {
  const t = s.trim();
  if (t.length === 0) return 0;
  const n = Number(t);
  if (Number.isNaN(n)) {
    throw new Error(`Invalid number for ${field}: ${s}`);
  }
  return n;
}

/**
 * Load marketing spend rows from `marketing_spend.csv`.
 */
export async function loadMarketingSpend(dataDir: string): Promise<MarketingSpend[]> {
  const filePath = join(dataDir, DATA_FILES.marketingSpend);
  try {
    return await loadCSV<MarketingSpend>(filePath, {
      transform: (row) => ({
        period: String(row.month ?? ''),
        channel: String(row.channel ?? ''),
        spend: parseNum(String(row.spend_usd ?? ''), 'spend_usd'),
        currency: 'USD',
        impressions: 0,
        clicks: 0,
        signups: 0,
        trials_started: 0,
        conversions: parseNum(String(row.attributed_deals ?? ''), 'attributed_deals'),
        attributed_revenue: parseNum(String(row.attributed_pipeline ?? ''), 'attributed_pipeline'),
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[loadMarketingSpend]', msg);
    throw new Error(`loadMarketingSpend failed for ${filePath}: ${msg}`);
  }
}

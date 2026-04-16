import { join } from 'node:path';
import { loadCSV } from './csv-loader.js';
import { DATA_FILES } from '../data/paths.js';
import type { FXRate } from './types.js';

function parseRate(s: string, field: string): number {
  const n = Number(String(s).trim());
  if (Number.isNaN(n)) {
    throw new Error(`Invalid FX rate ${field}: ${s}`);
  }
  return n;
}

/**
 * Load FX rates from `fx_rates.csv`.
 */
export async function loadFXRates(dataDir: string): Promise<FXRate[]> {
  const filePath = join(dataDir, DATA_FILES.fxRates);
  try {
    return await loadCSV<FXRate>(filePath, {
      transform: (row) => ({
        date: String(row.date ?? ''),
        eur_usd: parseRate(String(row.eur_usd ?? ''), 'eur_usd'),
        gbp_usd: parseRate(String(row.gbp_usd ?? ''), 'gbp_usd'),
        jpy_usd: parseRate(String(row.jpy_usd ?? ''), 'jpy_usd'),
        aud_usd: parseRate(String(row.aud_usd ?? ''), 'aud_usd'),
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[loadFXRates]', msg);
    throw new Error(`loadFXRates failed for ${filePath}: ${msg}`);
  }
}

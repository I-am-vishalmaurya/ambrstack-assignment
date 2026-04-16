import { join } from 'node:path';
import { loadCSV } from './csv-loader.js';
import { DATA_FILES } from '../data/paths.js';
import type { PlanPricing } from './types.js';

function emptyToNull(s: string): string | null {
  const t = s.trim();
  return t.length === 0 ? null : t;
}

function parsePrice(s: string, _field: string): number {
  const t = String(s).trim().toLowerCase();
  if (t === 'custom' || t === 'n/a' || t === '') return 0;
  const n = Number(t);
  if (Number.isNaN(n)) return 0;
  return n;
}

function isLegacyFromNotes(notes: string): boolean {
  return notes.toLowerCase().includes('discontinued');
}

/**
 * Load plan pricing history from `plan_pricing_history.csv`.
 *
 * Emits one {@link PlanPricing} row per billing period (monthly and annual) per source row.
 */
export async function loadPlanPricing(dataDir: string): Promise<PlanPricing[]> {
  const filePath = join(dataDir, DATA_FILES.planPricingHistory);
  try {
    const rows = await loadCSV<Record<string, string>>(filePath);
    const out: PlanPricing[] = [];
    for (const row of rows) {
      const effectiveTo = emptyToNull(row.end_date ?? '');
      const isLegacy = isLegacyFromNotes(row.notes ?? '');
      const billing_model = (row.billing_model ?? '').trim();

      const common = {
        plan_id: String(row.plan_id ?? ''),
        plan_name: String(row.plan_name ?? ''),
        currency: 'USD',
        included_seats: 1,
        price_per_additional_seat: 0,
        features: [] as string[],
        effective_from: String(row.effective_date ?? ''),
        effective_to: effectiveTo,
        is_legacy: isLegacy,
        billing_model,
      };

      out.push({
        ...common,
        billing_period: 'monthly',
        base_price: parsePrice(String(row.price_usd_monthly ?? ''), 'price_usd_monthly'),
      });
      out.push({
        ...common,
        billing_period: 'annual',
        base_price: parsePrice(String(row.price_usd_annual ?? ''), 'price_usd_annual'),
      });
    }
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[loadPlanPricing]', msg);
    throw new Error(`loadPlanPricing failed for ${filePath}: ${msg}`);
  }
}

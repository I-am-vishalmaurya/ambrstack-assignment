import { join } from 'node:path';
import { loadCSV } from './csv-loader.js';
import { DATA_FILES } from '../data/paths.js';
import type { PartnerDeal } from './types.js';

function mapStatus(raw: string): PartnerDeal['status'] {
  const s = raw.trim().toLowerCase();
  if (s === 'pending') return 'registered';
  if (s === 'active') return 'approved';
  if (s === 'expired') return 'closed_lost';
  throw new Error(`Unknown partner deal status: ${raw}`);
}

function parseAmount(s: string, field: string): number {
  const n = Number(String(s).replace(/,/g, '').trim());
  if (Number.isNaN(n)) {
    throw new Error(`Invalid ${field}: ${s}`);
  }
  return n;
}

function parseMarginPct(s: string): number {
  const n = parseAmount(s, 'partner_margin_pct');
  return n / 100;
}

function emptyToNull(s: string | undefined): string | null {
  if (s == null) return null;
  const t = s.trim();
  return t.length === 0 ? null : t;
}

/**
 * Load partner deals from `partner_deals.csv`.
 */
export async function loadPartnerDeals(dataDir: string): Promise<PartnerDeal[]> {
  const filePath = join(dataDir, DATA_FILES.partnerDeals);
  try {
    return await loadCSV<PartnerDeal>(filePath, {
      transform: (row) => {
        const endDate = String(row.end_date ?? '').trim();
        return {
          deal_id: String(row.partner_deal_id ?? ''),
          partner_id: String(row.partner_id ?? ''),
          partner_name: String(row.partner_name ?? ''),
          account_id: '',
          account_name: String(row.account_name ?? ''),
          deal_type: 'referral',
          commission_rate: parseMarginPct(String(row.partner_margin_pct ?? '')),
          deal_amount: parseAmount(String(row.deal_amount_gross ?? ''), 'deal_amount_gross'),
          currency: 'USD',
          status: mapStatus(String(row.status ?? '')),
          registered_date: String(row.start_date ?? ''),
          closed_date: endDate.length === 0 ? null : endDate,
          opportunity_id: emptyToNull(row.crm_opportunity_id),
          notes: null,
        };
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[loadPartnerDeals]', msg);
    throw new Error(`loadPartnerDeals failed for ${filePath}: ${msg}`);
  }
}

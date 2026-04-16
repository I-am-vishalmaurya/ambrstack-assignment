import { join } from 'node:path';
import { loadCSV } from './csv-loader.js';
import { DATA_FILES } from '../data/paths.js';
import type { SalesforceAccount, SalesforceOpportunity } from './types.js';

function deriveSegment(
  employeeCount: number,
): SalesforceAccount['segment'] {
  if (employeeCount >= 1000) return 'enterprise';
  if (employeeCount >= 200) return 'mid_market';
  if (employeeCount >= 50) return 'smb';
  return 'startup';
}

function parseNum(s: string): number {
  const n = Number(String(s).replace(/,/g, '').trim());
  if (Number.isNaN(n)) {
    throw new Error(`Expected number, got "${s}"`);
  }
  return n;
}

function emptyToNull(s: string | undefined): string | null {
  if (s == null) return null;
  const t = s.trim();
  return t.length === 0 ? null : t;
}

function mapDealType(raw: string): SalesforceOpportunity['type'] {
  const t = raw.trim();
  if (t === 'New Business') return 'new_business';
  if (t === 'Expansion') return 'expansion';
  if (t === 'Renewal') return 'renewal';
  throw new Error(`Unknown deal_type: ${raw}`);
}

function forecastFromProbability(p: number): SalesforceOpportunity['forecast_category'] {
  if (p === 100) return 'closed';
  if (p > 75) return 'commit';
  if (p > 50) return 'best_case';
  return 'pipeline';
}

/**
 * Load Salesforce accounts from `salesforce_accounts.csv`.
 */
export async function loadSalesforceAccounts(dataDir: string): Promise<SalesforceAccount[]> {
  const filePath = join(dataDir, DATA_FILES.salesforceAccounts);
  try {
    return await loadCSV<SalesforceAccount>(filePath, {
      transform: (row) => ({
        account_id: String(row.account_id ?? ''),
        account_name: String(row.account_name ?? ''),
        industry: String(row.industry ?? ''),
        employee_count: parseNum(String(row.employee_count ?? '')),
        annual_revenue: parseNum(String(row.annual_contract_value ?? '')),
        billing_country: String(row.region ?? ''),
        billing_state: '',
        website: String(row.website ?? ''),
        owner_name: String(row.account_owner ?? ''),
        owner_email: '',
        created_date: String(row.created_date ?? ''),
        segment: deriveSegment(parseNum(String(row.employee_count ?? ''))),
        parent_account_id: emptyToNull(row.parent_account_id),
        stripe_customer_id: null,
        chargebee_customer_id: null,
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[loadSalesforceAccounts]', msg);
    throw new Error(`loadSalesforceAccounts failed for ${filePath}: ${msg}`);
  }
}

/**
 * Load Salesforce opportunities from `salesforce_opportunities.csv`.
 */
export async function loadSalesforceOpportunities(
  dataDir: string,
): Promise<SalesforceOpportunity[]> {
  const filePath = join(dataDir, DATA_FILES.salesforceOpportunities);
  try {
    return await loadCSV<SalesforceOpportunity>(filePath, {
      transform: (row) => {
        const amount = parseNum(String(row.amount ?? ''));
        const termMonths = parseNum(String(row.contract_term_months ?? ''));
        const probability = parseNum(String(row.probability ?? ''));
        const acvDen = termMonths / 12;
        const acv = acvDen === 0 ? amount : amount / acvDen;
        return {
          opportunity_id: String(row.opportunity_id ?? ''),
          account_id: String(row.account_id ?? ''),
          account_name: String(row.account_name ?? ''),
          opportunity_name: String(row.opportunity_name ?? ''),
          stage: String(row.stage ?? ''),
          amount,
          currency: String(row.currency ?? ''),
          close_date: String(row.close_date ?? ''),
          created_date: String(row.created_date ?? ''),
          probability,
          last_activity_date: String(row.last_activity_date ?? ''),
          forecast_category: forecastFromProbability(probability),
          type: mapDealType(String(row.deal_type ?? '')),
          owner_name: String(row.owner_name ?? ''),
          owner_email: '',
          next_step: emptyToNull(row.next_step),
          tcv: amount,
          acv,
          contract_term_months: termMonths,
          competitor: null,
          loss_reason: null,
          partner_id: emptyToNull(row.partner_id),
        };
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[loadSalesforceOpportunities]', msg);
    throw new Error(`loadSalesforceOpportunities failed for ${filePath}: ${msg}`);
  }
}

/**
 * Load both Salesforce opportunities and accounts.
 *
 * @returns Tuple of `[opportunities, accounts]`.
 */
export async function loadSalesforceData(
  dataDir: string,
): Promise<[SalesforceOpportunity[], SalesforceAccount[]]> {
  const [opportunities, accounts] = await Promise.all([
    loadSalesforceOpportunities(dataDir),
    loadSalesforceAccounts(dataDir),
  ]);
  return [opportunities, accounts];
}

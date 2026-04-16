import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const thisDir = dirname(fileURLToPath(import.meta.url));

/**
 * Default `data/` directory for the Operation Clean Room workspace
 * (`operation-clean-room/data`), resolved from this package location.
 */
export function defaultDataDirectory(): string {
  return join(thisDir, '..', '..', '..', '..', 'data');
}

export const DATA_FILES = {
  stripePayments: 'stripe_payments.csv',
  chargebeeSubscriptions: 'chargebee_subscriptions.json',
  legacyInvoices: 'legacy_invoices.xml',
  salesforceAccounts: 'salesforce_accounts.csv',
  salesforceOpportunities: 'salesforce_opportunities.csv',
  productEvents: 'product_events.jsonl',
  supportTickets: 'support_tickets.csv',
  npsSurveys: 'nps_surveys.csv',
  marketingSpend: 'marketing_spend.csv',
  planPricingHistory: 'plan_pricing_history.csv',
  fxRates: 'fx_rates.csv',
  partnerDeals: 'partner_deals.csv',
} as const;

export function datasetPath(dataDir: string, filename: string): string {
  return join(dataDir, filename);
}

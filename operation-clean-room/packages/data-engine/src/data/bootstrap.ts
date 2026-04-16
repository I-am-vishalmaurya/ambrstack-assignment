import { loadChargebeeSubscriptions } from '../ingestion/chargebee.js';
import { loadFXRates } from '../ingestion/fx.js';
import { loadLegacyInvoices } from '../ingestion/legacy.js';
import { loadMarketingSpend } from '../ingestion/marketing.js';
import { loadNPSSurveys } from '../ingestion/nps.js';
import { loadPartnerDeals } from '../ingestion/partner-deals.js';
import { loadPlanPricing } from '../ingestion/plan-pricing.js';
import { loadProductEvents } from '../ingestion/product-events.js';
import { loadSalesforceAccounts, loadSalesforceOpportunities } from '../ingestion/salesforce.js';
import { loadStripePayments } from '../ingestion/stripe.js';
import { loadSupportTickets } from '../ingestion/support.js';
import type {
  ChargebeeSubscription,
  FXRate,
  LegacyInvoice,
  MarketingSpend,
  NPSSurvey,
  PartnerDeal,
  PlanPricing,
  ProductEvent,
  SalesforceAccount,
  SalesforceOpportunity,
  StripePayment,
  SupportTicket,
} from '../ingestion/types.js';

export interface LoadedData {
  stripePayments: StripePayment[];
  chargebeeSubscriptions: ChargebeeSubscription[];
  legacyInvoices: LegacyInvoice[];
  salesforceAccounts: SalesforceAccount[];
  salesforceOpportunities: SalesforceOpportunity[];
  productEvents: ProductEvent[];
  supportTickets: SupportTicket[];
  npsSurveys: NPSSurvey[];
  marketingSpend: MarketingSpend[];
  planPricing: PlanPricing[];
  fxRates: FXRate[];
  partnerDeals: PartnerDeal[];
}

/**
 * Load every static dataset from the given `data/` directory.
 */
export async function loadAllDatasets(dataDir: string): Promise<LoadedData> {
  const [
    stripePayments,
    chargebeeSubscriptions,
    legacyInvoices,
    salesforceAccounts,
    salesforceOpportunities,
    productEvents,
    supportTickets,
    npsSurveys,
    marketingSpend,
    planPricing,
    fxRates,
    partnerDeals,
  ] = await Promise.all([
    loadStripePayments(dataDir),
    loadChargebeeSubscriptions(dataDir),
    loadLegacyInvoices(dataDir),
    loadSalesforceAccounts(dataDir),
    loadSalesforceOpportunities(dataDir),
    loadProductEvents(dataDir),
    loadSupportTickets(dataDir),
    loadNPSSurveys(dataDir),
    loadMarketingSpend(dataDir),
    loadPlanPricing(dataDir),
    loadFXRates(dataDir),
    loadPartnerDeals(dataDir),
  ]);

  return {
    stripePayments,
    chargebeeSubscriptions,
    legacyInvoices,
    salesforceAccounts,
    salesforceOpportunities,
    productEvents,
    supportTickets,
    npsSurveys,
    marketingSpend,
    planPricing,
    fxRates,
    partnerDeals,
  };
}

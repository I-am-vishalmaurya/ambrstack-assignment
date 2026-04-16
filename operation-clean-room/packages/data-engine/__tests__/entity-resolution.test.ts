import { describe, it, expect } from 'vitest';
import { resolveEntities } from '../src/reconciliation/entity-resolution.js';
import type { LoadedData } from '../src/data/bootstrap.js';
import {
  DataSource,
  type ChargebeeSubscription,
  type LegacyInvoice,
  type SalesforceAccount,
  type StripePayment,
} from '../src/ingestion/types.js';
import { DiscrepancyType } from '../src/reconciliation/types.js';

function emptyLoadedData(): LoadedData {
  return {
    stripePayments: [],
    chargebeeSubscriptions: [],
    legacyInvoices: [],
    salesforceAccounts: [],
    salesforceOpportunities: [],
    productEvents: [],
    supportTickets: [],
    npsSurveys: [],
    marketingSpend: [],
    planPricing: [],
    fxRates: [],
    partnerDeals: [],
  };
}

describe('resolveEntities', () => {
  it('Pass 1: Salesforce ID bridge yields confidence 1.0', async () => {
    const sf: SalesforceAccount = {
      account_id: 'SF001',
      account_name: 'Bridged Co',
      industry: 'Software',
      employee_count: 50,
      annual_revenue: 1_000_000,
      billing_country: 'US',
      billing_state: 'CA',
      website: 'https://bridged.example',
      owner_name: 'Owner',
      owner_email: 'owner@bridged.example',
      created_date: '2024-01-01T00:00:00.000Z',
      segment: 'smb',
      parent_account_id: null,
      stripe_customer_id: 'cus_bridge_1',
      chargebee_customer_id: null,
    };
    const stripe: StripePayment = {
      payment_id: 'pi_bridge',
      customer_id: 'cus_bridge_1',
      customer_name: 'Bridged Co',
      amount: 10000,
      currency: 'usd',
      status: 'succeeded',
      payment_date: '2024-06-01T00:00:00.000Z',
      subscription_id: null,
      description: null,
      failure_code: null,
      refund_id: null,
      dispute_id: null,
    };
    const data: LoadedData = {
      ...emptyLoadedData(),
      salesforceAccounts: [sf],
      stripePayments: [stripe],
    };
    const { customers, discrepancies } = await resolveEntities(data);
    expect(discrepancies).toHaveLength(0);
    const c = customers.find((u) => u.external_ids.salesforce_account_id === 'SF001');
    expect(c).toBeDefined();
    expect(c!.match_confidence).toBe(1);
    expect(c!.needs_review).toBe(false);
    expect(c!.data_sources).toContain(DataSource.SALESFORCE);
    expect(c!.data_sources).toContain(DataSource.STRIPE);
  });

  it('Pass 2: Chargebee email domain + company name vs Salesforce', async () => {
    const sf: SalesforceAccount = {
      account_id: 'SF-DOM',
      account_name: 'Acme Analytics Inc',
      industry: 'Software',
      employee_count: 120,
      annual_revenue: 5_000_000,
      billing_country: 'US',
      billing_state: 'NY',
      website: 'https://www.acmeanalytics.com',
      owner_name: 'Owner',
      owner_email: 'owner@acmeanalytics.com',
      created_date: '2023-05-01T00:00:00.000Z',
      segment: 'mid_market',
      parent_account_id: null,
      stripe_customer_id: null,
      chargebee_customer_id: null,
    };
    const cb: ChargebeeSubscription = {
      subscription_id: 'sub_dom_1',
      customer: {
        customer_id: 'cb_cust_1',
        first_name: 'Jane',
        last_name: 'Doe',
        email: 'jane@acmeanalytics.com',
        company: 'Acme Analytics',
        billing_address: {
          line1: '1 Main',
          city: 'NYC',
          state: 'NY',
          country: 'US',
          zip: '10001',
        },
      },
      plan: {
        plan_id: 'p1',
        plan_name: 'Professional',
        price: 500,
        currency: 'usd',
        billing_period: 1,
        billing_period_unit: 'month',
        trial_end: null,
      },
      status: 'active',
      current_term_start: '2024-01-01T00:00:00.000Z',
      current_term_end: '2025-01-01T00:00:00.000Z',
      created_at: '2024-01-01T00:00:00.000Z',
      cancelled_at: null,
      cancel_reason: null,
      mrr: 500,
      coupons: [],
      plan_changes: [],
      addons: [],
      metadata: {},
    };
    const data: LoadedData = {
      ...emptyLoadedData(),
      salesforceAccounts: [sf],
      chargebeeSubscriptions: [cb],
    };
    const { customers } = await resolveEntities(data);
    const c = customers.find((u) => u.external_ids.salesforce_account_id === 'SF-DOM');
    expect(c).toBeDefined();
    expect(c!.match_confidence).toBeGreaterThan(0.8);
    expect(c!.data_sources).toContain(DataSource.CHARGEBEE);
    expect(c!.data_sources).toContain(DataSource.SALESFORCE);
  });

  it('Pass 5: weak corpus match puts record in review band (needs_review)', async () => {
    const sf: SalesforceAccount = {
      account_id: 'SF-REVIEW',
      account_name: 'Alpha Particle Research Labs Division',
      industry: 'Science',
      employee_count: 200,
      annual_revenue: 10_000_000,
      billing_country: 'US',
      billing_state: 'MA',
      website: 'https://unrelated-domain.example',
      owner_name: 'Owner',
      owner_email: 'o@unrelated-domain.example',
      created_date: '2022-01-01T00:00:00.000Z',
      segment: 'enterprise',
      parent_account_id: null,
      stripe_customer_id: null,
      chargebee_customer_id: null,
    };
    const stripe: StripePayment = {
      payment_id: 'pi_review_1',
      customer_id: 'cus_review_only',
      customer_name: 'Alpha Particle Labs',
      amount: 5000,
      currency: 'usd',
      status: 'succeeded',
      payment_date: '2024-03-15T00:00:00.000Z',
      subscription_id: null,
      description: null,
      failure_code: null,
      refund_id: null,
      dispute_id: null,
    };
    const data: LoadedData = {
      ...emptyLoadedData(),
      salesforceAccounts: [sf],
      stripePayments: [stripe],
    };
    const { customers } = await resolveEntities(data);
    const c = customers.find((u) => u.external_ids.stripe_customer_id === 'cus_review_only');
    expect(c).toBeDefined();
    expect(c!.match_confidence).toBeGreaterThanOrEqual(0.3);
    expect(c!.match_confidence).toBeLessThanOrEqual(0.79);
    expect(c!.needs_review).toBe(true);
  });

  it('Pass 5: orphan legacy invoice creates ORPHAN_RECORD discrepancy', async () => {
    const inv: LegacyInvoice = {
      id: 'LEG-999',
      customer_name: 'ZZZUNKNOWNCORPXYZ',
      amount: 42,
      currency: 'usd',
      date: '01/01/2024',
      status: 'paid',
      description: null,
      payment_ref: null,
    };
    const data: LoadedData = {
      ...emptyLoadedData(),
      legacyInvoices: [inv],
    };
    const { customers, discrepancies } = await resolveEntities(data);
    const orphan = discrepancies.find((d) => d.type === DiscrepancyType.ORPHAN_RECORD);
    expect(orphan).toBeDefined();
    expect(orphan!.sourceA.recordId).toBe('LEG-999');
    expect(customers.some((u) => u.external_ids.legacy_invoice_id === 'LEG-999')).toBe(false);
  });
});

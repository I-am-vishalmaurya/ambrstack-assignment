/**
 * Shared types for all data sources ingested by the reconciliation engine.
 *
 * These types represent the **normalized** shape of each data source after
 * ingestion.  Raw file formats (CSV, JSON, XML, JSONL) are parsed by the
 * respective loaders and mapped into these interfaces before any business
 * logic is applied.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

/** Canonical identifier for every external data source. */
export enum DataSource {
  STRIPE = 'stripe',
  CHARGEBEE = 'chargebee',
  LEGACY_BILLING = 'legacy_billing',
  SALESFORCE = 'salesforce',
  PRODUCT_EVENTS = 'product_events',
  SUPPORT = 'support',
  NPS = 'nps',
  MARKETING = 'marketing',
  PLAN_PRICING = 'plan_pricing',
  FX_RATES = 'fx_rates',
  PARTNER_DEALS = 'partner_deals',
}

// ---------------------------------------------------------------------------
// Billing: Stripe
// ---------------------------------------------------------------------------

/** A single Stripe payment record (one row in stripe_payments.csv). */
export interface StripePayment {
  /** Stripe payment intent or charge ID (e.g. "pi_3Ox..."). */
  payment_id: string;
  /** Internal Stripe customer ID (e.g. "cus_..."). */
  customer_id: string;
  /** Human-readable customer / company name. */
  customer_name: string;
  /** Payment amount in the smallest currency unit (cents, pence, etc.). */
  amount: number;
  /** ISO 4217 currency code (e.g. "usd", "eur"). */
  currency: string;
  /** Payment status: succeeded, failed, pending, refunded, disputed. */
  status: 'succeeded' | 'failed' | 'pending' | 'refunded' | 'disputed';
  /** ISO-8601 date/time the payment was created. */
  payment_date: string;
  /** Associated Stripe subscription ID, if any. */
  subscription_id: string | null;
  /** Free-text description or invoice memo. */
  description: string | null;
  /** Stripe failure code when status is "failed" (e.g. "card_declined"). */
  failure_code: string | null;
  /** Stripe refund ID when the payment was refunded. */
  refund_id: string | null;
  /** Stripe dispute ID when the payment is disputed. */
  dispute_id: string | null;
}

// ---------------------------------------------------------------------------
// Billing: Chargebee
// ---------------------------------------------------------------------------

/** A coupon applied to a Chargebee subscription. */
export interface ChargebeeCoupon {
  coupon_id: string;
  coupon_name: string;
  discount_type: 'percentage' | 'fixed_amount';
  discount_value: number;
  apply_on: 'invoice_amount' | 'each_specified_item';
  valid_from: string;
  valid_till: string | null;
}

/** A historical plan change on a Chargebee subscription. */
export interface ChargebeePlanChange {
  change_date: string;
  previous_plan: string;
  new_plan: string;
  previous_amount: number;
  new_amount: number;
  change_type: 'upgrade' | 'downgrade' | 'lateral';
  proration_amount: number | null;
}

/** Nested customer object within a Chargebee subscription. */
export interface ChargebeeCustomer {
  customer_id: string;
  first_name: string;
  last_name: string;
  email: string;
  company: string;
  billing_address: {
    line1: string;
    city: string;
    state: string;
    country: string;
    zip: string;
  };
}

/** A single Chargebee subscription record (from chargebee_subscriptions.json). */
export interface ChargebeeSubscription {
  subscription_id: string;
  customer: ChargebeeCustomer;
  plan: {
    plan_id: string;
    plan_name: string;
    price: number;
    currency: string;
    billing_period: number;
    billing_period_unit: 'month' | 'year';
    trial_end: string | null;
  };
  status: 'active' | 'in_trial' | 'cancelled' | 'non_renewing' | 'paused' | 'future';
  current_term_start: string;
  current_term_end: string;
  created_at: string;
  cancelled_at: string | null;
  cancel_reason: string | null;
  mrr: number;
  coupons: ChargebeeCoupon[];
  plan_changes: ChargebeePlanChange[];
  addons: {
    addon_id: string;
    addon_name: string;
    quantity: number;
    unit_price: number;
  }[];
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Billing: Legacy System
// ---------------------------------------------------------------------------

/**
 * An invoice from the legacy billing system (legacy_invoices.xml).
 *
 * The legacy system used inconsistent date formats (DD/MM/YYYY and
 * MM/DD/YYYY) and free-text descriptions.  The `payment_ref` field
 * *sometimes* contains a Stripe charge ID that can be cross-referenced.
 */
export interface LegacyInvoice {
  id: string;
  customer_name: string;
  amount: number;
  currency: string;
  /** Raw date string -- format is ambiguous; see utils/date-parser.ts. */
  date: string;
  status: 'paid' | 'unpaid' | 'overdue' | 'void' | 'partially_paid';
  description: string | null;
  /** Optional reference to an external payment (may be a Stripe charge ID). */
  payment_ref: string | null;
  /** True when amount was converted using an approximate FX rate. */
  fxRateApproximated?: boolean;
}

// ---------------------------------------------------------------------------
// CRM: Salesforce
// ---------------------------------------------------------------------------

/** A Salesforce Opportunity record (from sf_opportunities.csv). */
export interface SalesforceOpportunity {
  opportunity_id: string;
  account_id: string;
  account_name: string;
  opportunity_name: string;
  stage: string;
  amount: number;
  currency: string;
  close_date: string;
  created_date: string;
  probability: number;
  last_activity_date: string;
  forecast_category: 'pipeline' | 'best_case' | 'commit' | 'closed' | 'omitted';
  type: 'new_business' | 'expansion' | 'renewal';
  owner_name: string;
  owner_email: string;
  next_step: string | null;
  /** Total contract value (may differ from amount for multi-year deals). */
  tcv: number;
  /** Annual contract value. */
  acv: number;
  contract_term_months: number;
  competitor: string | null;
  loss_reason: string | null;
  partner_id: string | null;
}

/** A Salesforce Account record (from sf_accounts.csv). */
export interface SalesforceAccount {
  account_id: string;
  account_name: string;
  industry: string;
  employee_count: number;
  annual_revenue: number;
  billing_country: string;
  billing_state: string;
  website: string;
  owner_name: string;
  owner_email: string;
  created_date: string;
  segment: 'enterprise' | 'mid_market' | 'smb' | 'startup';
  parent_account_id: string | null;
  stripe_customer_id: string | null;
  chargebee_customer_id: string | null;
}

// ---------------------------------------------------------------------------
// Product Analytics
// ---------------------------------------------------------------------------

/**
 * A single product usage event (from product_events.jsonl).
 *
 * Events are emitted in real-time and stored as newline-delimited JSON.
 * Common event types include: login, feature_used, api_call, export,
 * invite_sent, settings_changed, integration_connected.
 */
export interface ProductEvent {
  event_id: string;
  account_id: string;
  user_id: string;
  event_type: string;
  feature: string;
  timestamp: string;
  metadata: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Customer Success: Support
// ---------------------------------------------------------------------------

/** A support ticket record (from support_tickets.csv). */
export interface SupportTicket {
  ticket_id: string;
  account_id: string;
  account_name: string;
  subject: string;
  description: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  status: 'open' | 'pending' | 'solved' | 'closed';
  category: string;
  created_at: string;
  resolved_at: string | null;
  first_response_at: string | null;
  assignee: string;
  satisfaction_rating: number | null;
  tags: string[];
}

// ---------------------------------------------------------------------------
// Customer Success: NPS
// ---------------------------------------------------------------------------

/** A Net Promoter Score survey response (from nps_surveys.csv). */
export interface NPSSurvey {
  response_id: string;
  account_id: string;
  account_name: string;
  respondent_email: string;
  score: number;
  comment: string | null;
  survey_date: string;
  segment: string;
  /** Derived category: 0-6 = detractor, 7-8 = passive, 9-10 = promoter. */
  category: 'promoter' | 'passive' | 'detractor';
}

// ---------------------------------------------------------------------------
// Marketing
// ---------------------------------------------------------------------------

/** Marketing spend by channel and period (from marketing_spend.csv). */
export interface MarketingSpend {
  period: string;
  channel: string;
  spend: number;
  currency: string;
  impressions: number;
  clicks: number;
  signups: number;
  trials_started: number;
  conversions: number;
  attributed_revenue: number;
}

// ---------------------------------------------------------------------------
// Pricing & Plans
// ---------------------------------------------------------------------------

/** Plan pricing configuration (from plan_pricing.json). */
export interface PlanPricing {
  plan_id: string;
  plan_name: string;
  billing_period: 'monthly' | 'annual';
  base_price: number;
  currency: string;
  included_seats: number;
  price_per_additional_seat: number;
  features: string[];
  effective_from: string;
  effective_to: string | null;
  /** If true, this plan is no longer sold but existing subscribers are grandfathered. */
  is_legacy: boolean;
  /** Raw billing model from source data (e.g. flat-rate, per-seat). */
  billing_model: string;
}

// ---------------------------------------------------------------------------
// FX Rates
// ---------------------------------------------------------------------------

/**
 * Historical foreign exchange rates for a single date (from fx_rates.csv).
 *
 * All rates are expressed as "1 foreign currency unit = X USD".
 */
export interface FXRate {
  date: string;
  eur_usd: number;
  gbp_usd: number;
  jpy_usd: number;
  aud_usd: number;
}

// ---------------------------------------------------------------------------
// Partnerships
// ---------------------------------------------------------------------------

/** A partner-sourced or partner-influenced deal (from partner_deals.csv). */
export interface PartnerDeal {
  deal_id: string;
  partner_id: string;
  partner_name: string;
  account_id: string;
  account_name: string;
  deal_type: 'referral' | 'co_sell' | 'reseller';
  commission_rate: number;
  deal_amount: number;
  currency: string;
  status: 'registered' | 'approved' | 'rejected' | 'closed_won' | 'closed_lost';
  registered_date: string;
  closed_date: string | null;
  opportunity_id: string | null;
  notes: string | null;
}

// ---------------------------------------------------------------------------
// Unified / Reconciled
// ---------------------------------------------------------------------------

/**
 * A unified customer record produced by the reconciliation engine.
 *
 * This is the "single source of truth" view that stitches together data from
 * Stripe, Chargebee, Salesforce, product analytics, support, and NPS into
 * one coherent entity per customer.
 */
export interface UnifiedCustomer {
  /** Synthetic internal ID created by the reconciliation engine. */
  unified_id: string;
  /** Canonical company name (after normalization). */
  company_name: string;
  /** All known aliases / name variants seen across systems. */
  aliases: string[];
  /** External IDs keyed by source system. */
  external_ids: {
    stripe_customer_id: string | null;
    chargebee_customer_id: string | null;
    salesforce_account_id: string | null;
    legacy_invoice_id: string | null;
  };
  /** Segment classification. */
  segment: 'enterprise' | 'mid_market' | 'smb' | 'startup';
  /** ISO-3166-1 alpha-2 country code. */
  country: string;
  /** Industry vertical. */
  industry: string;
  /** Current billing system of record. */
  billing_system: DataSource.STRIPE | DataSource.CHARGEBEE | DataSource.LEGACY_BILLING;
  /** Current monthly recurring revenue in USD. */
  mrr_usd: number;
  /** Current annual recurring revenue in USD. */
  arr_usd: number;
  /** Current plan name. */
  plan: string;
  /** Subscription status. */
  status: 'active' | 'churned' | 'trial' | 'paused';
  /** Date the customer first appeared in any system. */
  first_seen: string;
  /** Date of the most recent activity across all systems. */
  last_activity: string;
  /** Latest NPS score, if available. */
  nps_score: number | null;
  /** Number of open support tickets. */
  open_tickets: number;
  /** Product usage score (0-100). */
  usage_score: number;
  /** Confidence score for the entity resolution match (0-1). */
  match_confidence: number;
  /** True when automated matching is uncertain and a human should review. */
  needs_review: boolean;
  /** Sources that contributed data to this unified record. */
  data_sources: DataSource[];
}

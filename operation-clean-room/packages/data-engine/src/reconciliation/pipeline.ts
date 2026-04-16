import type { PipelineAnalysisResult } from './types.js';
import type { SalesforceOpportunity, ChargebeeSubscription, StripePayment } from '../ingestion/types.js';

/**
 * CRM pipeline quality analysis.
 *
 * Identifies data quality issues in the Salesforce pipeline by cross-
 * referencing CRM data against billing system data.  Key analyses:
 *
 * - **Zombie deals**: Open opportunities whose last activity is older than
 *   the configured threshold (default **180** days) while the deal remains
 *   outside Closed Won / Closed Lost.
 *
 * - **Stage mismatches**: Opportunities marked as "Closed Won" in
 *   Salesforce but with no corresponding active subscription in the
 *   billing data passed into this function (matched by account name).
 *
 * - **Unbooked revenue**: Active Chargebee subscriptions (or Stripe
 *   customers with recent successful payments) with no matching
 *   "Closed Won" opportunity for the same account name.
 *
 * - **Pipeline health score**: 100 minus weighted penalties for zombies,
 *   mismatches, and unbooked rows (clamped to 0–100).
 *
 * @module reconciliation/pipeline
 */

const MS_PER_DAY = 86_400_000;
const STRIPE_ACTIVE_LOOKBACK_DAYS = 90;

/** Options for pipeline quality analysis. */
export interface PipelineAnalysisOptions {
  /** Number of days with no activity to flag as zombie. Defaults to 180. */
  zombieThresholdDays?: number;
  /** Tolerance for ACV vs billing amount comparison (as a fraction). Defaults to 0.10 (10%). */
  amountToleranceFraction?: number;
  /** Whether to include closed-lost opportunities in the analysis. Defaults to false. */
  includeClosedLost?: boolean;
}

function isChargebee(
  s: ChargebeeSubscription | StripePayment,
): s is ChargebeeSubscription {
  return (
    'plan' in s &&
    typeof (s as ChargebeeSubscription).plan === 'object' &&
    'plan_id' in (s as ChargebeeSubscription).plan &&
    'customer' in s &&
    typeof (s as ChargebeeSubscription).customer === 'object' &&
    'customer_id' in (s as ChargebeeSubscription).customer
  );
}

function isStripePayment(s: ChargebeeSubscription | StripePayment): s is StripePayment {
  return 'payment_id' in s && 'customer_id' in s;
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function namesMatch(a: string, b: string): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (na.length === 0 || nb.length === 0) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

function stageKey(stage: string): string {
  return stage.trim().toLowerCase();
}

function isClosedWon(stage: string): boolean {
  return stageKey(stage) === 'closed won';
}

function isClosedLost(stage: string): boolean {
  return stageKey(stage) === 'closed lost';
}

function parseDate(s: string): Date {
  const d = new Date(s.trim());
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
}

function chargebeeActiveForAccount(
  accountName: string,
  subs: ChargebeeSubscription[],
): ChargebeeSubscription | undefined {
  return subs.find(
    (s) =>
      s.status === 'active' &&
      namesMatch(s.customer.company, accountName),
  );
}

function stripeActiveForAccount(
  accountName: string,
  payments: StripePayment[],
  now: Date,
): boolean {
  const cutoff = new Date(now.getTime() - STRIPE_ACTIVE_LOOKBACK_DAYS * MS_PER_DAY);
  return payments.some(
    (p) =>
      p.status === 'succeeded' &&
      namesMatch(p.customer_name, accountName) &&
      new Date(p.payment_date) >= cutoff,
  );
}

function hasActiveBilling(
  accountName: string,
  chargebee: ChargebeeSubscription[],
  stripe: StripePayment[],
  now: Date,
): boolean {
  return (
    chargebeeActiveForAccount(accountName, chargebee) !== undefined ||
    stripeActiveForAccount(accountName, stripe, now)
  );
}

function hasClosedWonOpportunity(
  accountName: string,
  opps: SalesforceOpportunity[],
): boolean {
  return opps.some((o) => isClosedWon(o.stage) && namesMatch(o.account_name, accountName));
}

/**
 * Analyze CRM pipeline quality against billing data.
 *
 * @param opportunities - Salesforce opportunity records
 * @param subscriptions - Active subscriptions from billing systems
 * @param options - Analysis options
 * @returns Pipeline quality analysis with zombie deals, mismatches, and unbooked revenue
 */
export async function analyzePipelineQuality(
  opportunities: SalesforceOpportunity[],
  subscriptions: (ChargebeeSubscription | StripePayment)[],
  options?: PipelineAnalysisOptions,
): Promise<PipelineAnalysisResult> {
  const now = new Date();
  const zombieThresholdDays = options?.zombieThresholdDays ?? 180;
  const includeClosedLost = options?.includeClosedLost ?? false;

  const chargebeeSubs = subscriptions.filter(isChargebee);
  const stripePayments = subscriptions.filter(isStripePayment);

  const oppsForAnalysis = includeClosedLost
    ? opportunities
    : opportunities.filter((o) => !isClosedLost(o.stage));

  const zombieDeals: PipelineAnalysisResult['zombieDeals'] = [];
  for (const o of oppsForAnalysis) {
    if (isClosedWon(o.stage) || isClosedLost(o.stage)) continue;

    const last = parseDate(o.last_activity_date);
    const daysSinceActivity = daysBetween(last, now);
    if (daysSinceActivity > zombieThresholdDays) {
      zombieDeals.push({
        opportunityId: o.opportunity_id,
        accountName: o.account_name,
        amount: o.amount,
        stage: o.stage,
        daysSinceActivity,
      });
    }
  }

  const mismatches: PipelineAnalysisResult['mismatches'] = [];
  for (const o of oppsForAnalysis) {
    if (!isClosedWon(o.stage)) continue;
    if (hasActiveBilling(o.account_name, chargebeeSubs, stripePayments, now)) continue;
    mismatches.push({
      opportunityId: o.opportunity_id,
      accountName: o.account_name,
      issue: 'Closed Won in CRM with no active billing subscription for this account',
      crmValue: o.stage,
      billingValue: 'none',
    });
  }

  const unbookedRevenue: PipelineAnalysisResult['unbookedRevenue'] = [];

  for (const sub of chargebeeSubs) {
    if (sub.status !== 'active') continue;
    const name = sub.customer.company;
    if (!hasClosedWonOpportunity(name, oppsForAnalysis)) {
      unbookedRevenue.push({
        subscriptionId: sub.subscription_id,
        customerName: name,
        mrr: sub.mrr,
        system: 'chargebee',
      });
    }
  }

  const stripeByCustomer = new Map<string, StripePayment[]>();
  for (const p of stripePayments) {
    if (p.status !== 'succeeded') continue;
    const list = stripeByCustomer.get(p.customer_id) ?? [];
    list.push(p);
    stripeByCustomer.set(p.customer_id, list);
  }

  for (const [, pays] of stripeByCustomer) {
    const latest = pays.reduce((a, b) =>
      new Date(a.payment_date) > new Date(b.payment_date) ? a : b,
    );
    if (!stripeActiveForAccount(latest.customer_name, pays, now)) continue;
    if (hasClosedWonOpportunity(latest.customer_name, oppsForAnalysis)) continue;
    const cutoff = new Date(now.getTime() - STRIPE_ACTIVE_LOOKBACK_DAYS * MS_PER_DAY);
    const windowPayments = pays.filter((p) => new Date(p.payment_date) >= cutoff);
    const mrrEstimate =
      windowPayments.length === 0
        ? 0
        : Math.round(
            windowPayments.reduce((s, p) => s + p.amount, 0) / windowPayments.length,
          );

    unbookedRevenue.push({
      subscriptionId: latest.subscription_id ?? latest.customer_id,
      customerName: latest.customer_name,
      mrr: mrrEstimate,
      system: 'stripe',
    });
  }

  const totalZombieValue = zombieDeals.reduce((s, z) => s + z.amount, 0);
  const totalUnbookedMRR = unbookedRevenue.reduce((s, u) => s + u.mrr, 0);

  const zombieCount = zombieDeals.length;
  const mismatchCount = mismatches.length;
  const unbookedCount = unbookedRevenue.length;
  const rawScore = 100 - (zombieCount * 2 + mismatchCount * 5 + unbookedCount * 3);
  const pipelineHealthScore = Math.min(100, Math.max(0, rawScore));

  return {
    zombieDeals,
    mismatches,
    unbookedRevenue,
    summary: {
      totalZombieDeals: zombieCount,
      totalZombieValue,
      totalMismatches: mismatchCount,
      totalUnbookedMRR,
      pipelineHealthScore,
    },
  };
}

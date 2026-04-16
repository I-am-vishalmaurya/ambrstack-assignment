import type { ARRBreakdown, ARRResult, MetricOptions } from './types.js';
import type { LoadedData } from '../data/bootstrap.js';
import type { ChargebeeSubscription, StripePayment } from '../ingestion/types.js';
import { convertToUSD } from '../utils/fx.js';
import { detectDuplicates } from '../reconciliation/deduplication.js';

/**
 * Annual Recurring Revenue (ARR) calculation.
 *
 * Annualizes normalized subscription MRR (Chargebee loader + annual plans),
 * converts to USD using `convertToUSD`, applies partner commissions, and
 * de-duplicates overlapping Stripe + Chargebee pairs in favor of active
 * Chargebee when configured by duplicate detection.
 *
 * @param data - Loaded datasets (billing, CRM, FX, partners, etc.)
 * @param date - The as-of date for the ARR calculation
 * @param options - Calculation options (segmentation, exclusions, etc.)
 * @returns ARR result with total and breakdowns
 */
export async function calculateARR(
  data: LoadedData,
  date: Date,
  options?: MetricOptions,
): Promise<ARRResult> {
  const excludeTrials = options?.excludeTrials !== false;
  const dups = await detectDuplicates(data.stripePayments, data.chargebeeSubscriptions);
  const skipStripeCustomerIds = new Set<string>();
  for (const d of dups) {
    if (!d.hasOverlap) continue;
    const cb = data.chargebeeSubscriptions.find(
      (s) => s.subscription_id === d.chargebeeRecord.subscriptionId,
    );
    if (cb?.status === 'active') skipStripeCustomerIds.add(d.stripeRecord.customerId);
  }

  const accountByChargebeeId = new Map(
    data.salesforceAccounts
      .filter((a) => a.chargebee_customer_id)
      .map((a) => [a.chargebee_customer_id!, a]),
  );

  function partnerCommissionRate(accountId: string | undefined): number {
    if (!accountId) return 0;
    const deals = data.partnerDeals.filter(
      (pd) =>
        pd.account_id === accountId &&
        (pd.status === 'closed_won' || pd.status === 'approved'),
    );
    if (deals.length === 0) return 0;
    return Math.max(...deals.map((d) => d.commission_rate));
  }

  function segmentFromPlan(planName: string): string {
    const n = planName.toLowerCase();
    if (n.includes('enterprise')) return 'enterprise';
    if (n.includes('scale')) return 'enterprise';
    if (n.includes('growth')) return 'mid_market';
    if (n.includes('starter')) return 'smb';
    return 'mid_market';
  }

  function inTrial(sub: ChargebeeSubscription): boolean {
    if (sub.status === 'in_trial') return true;
    if (!sub.plan.trial_end) return false;
    return new Date(sub.plan.trial_end) > date;
  }

  const perCustomerArrUsd = new Map<string, number>();
  const perCustomerPlan = new Map<string, string>();
  const perCustomerSegment = new Map<string, string>();
  const perCustomerRegion = new Map<string, string>();
  const perCustomerCohort = new Map<string, string>();

  for (const sub of data.chargebeeSubscriptions) {
    if (sub.status === 'paused') continue;
    if (sub.status !== 'active') continue;
    if (sub.mrr <= 0) continue;
    if (excludeTrials && inTrial(sub)) continue;

    const mrrUsd = convertToUSD(sub.mrr, sub.plan.currency, date, data.fxRates);
    let arrUsd =
      sub.plan.billing_period_unit === 'year'
        ? convertToUSD(sub.plan.price, sub.plan.currency, date, data.fxRates)
        : mrrUsd * 12;

    const custId = sub.customer.customer_id;
    const acct = accountByChargebeeId.get(custId);
    const comm = partnerCommissionRate(acct?.account_id);
    arrUsd *= 1 - comm;

    perCustomerArrUsd.set(custId, (perCustomerArrUsd.get(custId) ?? 0) + arrUsd);
    perCustomerPlan.set(custId, sub.plan.plan_name);
    perCustomerSegment.set(
      custId,
      acct?.segment ?? segmentFromPlan(sub.plan.plan_name),
    );
    perCustomerRegion.set(custId, acct?.billing_country ?? 'unknown');
    perCustomerCohort.set(custId, sub.created_at.slice(0, 7));
  }

  const stripePaymentsByCustomer = new Map<string, StripePayment[]>();
  for (const p of data.stripePayments) {
    if (p.status !== 'succeeded') continue;
    if (skipStripeCustomerIds.has(p.customer_id)) continue;
    const list = stripePaymentsByCustomer.get(p.customer_id) ?? [];
    list.push(p);
    stripePaymentsByCustomer.set(p.customer_id, list);
  }

  const lookbackMs = 120 * 86_400_000;
  const cutoff = new Date(date.getTime() - lookbackMs);

  for (const [custId, pays] of stripePaymentsByCustomer) {
    const recent = pays.filter((p) => new Date(p.payment_date) >= cutoff);
    if (recent.length === 0) continue;
    const mrrSamples = recent.map((p) =>
      convertToUSD(p.amount, p.currency, new Date(p.payment_date), data.fxRates),
    );
    const mrrUsd = mrrSamples.reduce((a, b) => a + b, 0) / mrrSamples.length;
    const arrUsd = mrrUsd * 12;
    if (arrUsd <= 0) continue;

    const acct = data.salesforceAccounts.find((a) => a.stripe_customer_id === custId);
    const comm = partnerCommissionRate(acct?.account_id);
    const netArr = arrUsd * (1 - comm);

    perCustomerArrUsd.set(custId, (perCustomerArrUsd.get(custId) ?? 0) + netArr);
    perCustomerPlan.set(custId, 'stripe');
    perCustomerSegment.set(custId, acct?.segment ?? 'mid_market');
    perCustomerRegion.set(custId, acct?.billing_country ?? 'unknown');
    const latest = pays.reduce((a, b) =>
      new Date(a.payment_date) > new Date(b.payment_date) ? a : b,
    );
    perCustomerCohort.set(custId, latest.payment_date.slice(0, 7));
  }

  const customers = [...perCustomerArrUsd.entries()].filter(([, arr]) => arr > 0);
  const total = customers.reduce((s, [, arr]) => s + arr, 0);
  const arrValues = customers.map(([, arr]) => arr);
  const medianARRPerCustomer = median(arrValues);
  const avgARRPerCustomer =
    customers.length > 0 ? total / customers.length : 0;

  function buildBreakdown(
    labelFn: (id: string) => string,
  ): ARRBreakdown[] {
    const buckets = new Map<string, { arr: number; count: number }>();
    for (const [id, arr] of customers) {
      const label = labelFn(id);
      const cur = buckets.get(label) ?? { arr: 0, count: 0 };
      cur.arr += arr;
      cur.count += 1;
      buckets.set(label, cur);
    }
    return [...buckets.entries()]
      .map(([label, { arr, count }]) => ({
        label,
        arr,
        customerCount: count,
        percentOfTotal: total > 0 ? (arr / total) * 100 : 0,
      }))
      .sort((a, b) => b.arr - a.arr);
  }

  const bySegment = buildBreakdown((id) => perCustomerSegment.get(id) ?? 'unknown');
  const byPlan = buildBreakdown((id) => perCustomerPlan.get(id) ?? 'unknown');
  const byRegion = buildBreakdown((id) => perCustomerRegion.get(id) ?? 'unknown');
  const byCohort = buildBreakdown((id) => perCustomerCohort.get(id) ?? 'unknown');

  return {
    total,
    bySegment,
    byPlan,
    byRegion,
    byCohort,
    asOfDate: date.toISOString().slice(0, 10),
    totalCustomers: customers.length,
    avgARRPerCustomer,
    medianARRPerCustomer,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

import type { LoadedData } from '../data/bootstrap.js';
import type { ChargebeeSubscription } from '../ingestion/types.js';
import type { MetricOptions, NRRBreakdownItem, NRRResult } from './types.js';
import { convertToUSD } from '../utils/fx.js';

function wasActiveOn(sub: ChargebeeSubscription, asOf: Date): boolean {
  const created = new Date(sub.created_at);
  if (Number.isNaN(created.getTime()) || created > asOf) return false;
  if (sub.cancelled_at) {
    const cancelled = new Date(sub.cancelled_at);
    if (!Number.isNaN(cancelled.getTime()) && cancelled <= asOf) return false;
  }
  return true;
}

function inTrialAt(sub: ChargebeeSubscription, asOf: Date): boolean {
  if (sub.status === 'in_trial') return true;
  if (!sub.plan.trial_end) return false;
  return new Date(sub.plan.trial_end) > asOf;
}

function arrUsdForSub(sub: ChargebeeSubscription, fxDate: Date, fx: LoadedData['fxRates']): number {
  if (sub.mrr <= 0) return 0;
  if (sub.plan.billing_period_unit === 'year') {
    return convertToUSD(sub.plan.price, sub.plan.currency, fxDate, fx);
  }
  const mrrUsd = convertToUSD(sub.mrr, sub.plan.currency, fxDate, fx);
  return mrrUsd * 12;
}

/**
 * Net Revenue Retention (NRR) calculation.
 *
 * Cohort = Chargebee customers with any subscription active at `startDate`.
 * Start and end ARR are restated using FX rates as of `endDate` (period-end).
 *
 * @param data - Loaded datasets
 * @param startDate - Beginning of the measurement period
 * @param endDate - End of the measurement period
 * @param options - Calculation options
 * @returns NRR result with percentage and component breakdown
 */
export async function calculateNRR(
  data: LoadedData,
  startDate: Date,
  endDate: Date,
  options?: MetricOptions,
): Promise<NRRResult> {
  if (startDate >= endDate) {
    throw new RangeError('startDate must be before endDate');
  }

  const excludeTrials = options?.excludeTrials !== false;
  const fxDate = endDate;
  const fx = data.fxRates;

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

  function netArrForCustomer(customerId: string, asOf: Date): number {
    let gross = 0;
    for (const sub of data.chargebeeSubscriptions) {
      if (sub.customer.customer_id !== customerId) continue;
      if (!wasActiveOn(sub, asOf)) continue;
      if (excludeTrials && inTrialAt(sub, asOf)) continue;
      gross += arrUsdForSub(sub, fxDate, fx);
    }
    const acct = accountByChargebeeId.get(customerId);
    const comm = partnerCommissionRate(acct?.account_id);
    return gross * (1 - comm);
  }

  function displayName(customerId: string): string {
    const sub = data.chargebeeSubscriptions.find((s) => s.customer.customer_id === customerId);
    return sub?.customer.company ?? customerId;
  }

  const cohortIds = new Set<string>();
  for (const sub of data.chargebeeSubscriptions) {
    if (!wasActiveOn(sub, startDate)) continue;
    if (excludeTrials && inTrialAt(sub, startDate)) continue;
    if (arrUsdForSub(sub, fxDate, fx) <= 0) continue;
    cohortIds.add(sub.customer.customer_id);
  }

  let startingARR = 0;
  let endingARR = 0;
  let expansion = 0;
  let contraction = 0;
  let churn = 0;
  const breakdown: NRRBreakdownItem[] = [];

  for (const cid of cohortIds) {
    const startArr = netArrForCustomer(cid, startDate);
    if (startArr <= 0) continue;
    startingARR += startArr;

    const subs = data.chargebeeSubscriptions.filter((s) => s.customer.customer_id === cid);
    const churnedInPeriod = subs.some((s) => {
      if (!s.cancelled_at) return false;
      const c = new Date(s.cancelled_at);
      return !Number.isNaN(c.getTime()) && c >= startDate && c < endDate;
    });

    const endArr = netArrForCustomer(cid, endDate);
    const delta = endArr - startArr;

    if (churnedInPeriod && endArr <= 0) {
      churn += startArr;
      breakdown.push({
        customerName: displayName(cid),
        startingARR: startArr,
        endingARR: 0,
        change: -startArr,
        changeType: 'churn',
        reason: subs.find((s) => s.cancel_reason)?.cancel_reason ?? null,
      });
      continue;
    }

    endingARR += endArr;

    if (delta > 1) {
      expansion += delta;
      breakdown.push({
        customerName: displayName(cid),
        startingARR: startArr,
        endingARR: endArr,
        change: delta,
        changeType: 'expansion',
        reason: null,
      });
    } else if (delta < -1) {
      contraction += -delta;
      breakdown.push({
        customerName: displayName(cid),
        startingARR: startArr,
        endingARR: endArr,
        change: delta,
        changeType: 'contraction',
        reason: null,
      });
    } else {
      breakdown.push({
        customerName: displayName(cid),
        startingARR: startArr,
        endingARR: endArr,
        change: delta,
        changeType: 'unchanged',
        reason: null,
      });
    }
  }

  const denominator = startingARR > 0 ? startingARR : 1;
  const percentage = ((startingARR + expansion - contraction - churn) / denominator) * 100;

  return {
    percentage: Math.round(percentage * 100) / 100,
    expansion,
    contraction,
    churn,
    startingARR,
    endingARR,
    breakdown,
    periodStart: startDate.toISOString().slice(0, 10),
    periodEnd: endDate.toISOString().slice(0, 10),
  };
}

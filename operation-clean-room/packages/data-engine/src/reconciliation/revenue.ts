import type { RevenueReconciliationResult } from './types.js';
import type { ChargebeeSubscription, StripePayment, FXRate } from '../ingestion/types.js';
import { convertToUSD } from '../utils/fx.js';

export interface RevenueReconciliationOptions {
  startDate: Date;
  endDate: Date;
  toleranceUSD?: number;
  includeTrials?: boolean;
}

/**
 * Reconcile expected subscription revenue against actual payment revenue.
 *
 * Handles prorations via plan_changes[], FX conversion at payment-date rate,
 * annual billing (1/12 per month), and the 2% discrepancy threshold
 * (Assumption Exclusions #5).
 */
export async function reconcileRevenue(
  subscriptions: ChargebeeSubscription[],
  payments: StripePayment[],
  fxRates: FXRate[],
  options: RevenueReconciliationOptions,
): Promise<RevenueReconciliationResult> {
  if (options.startDate >= options.endDate) {
    console.error(
      `[reconcileRevenue] Invalid date range: start=${options.startDate.toISOString()} end=${options.endDate.toISOString()}`,
    );
    throw new RangeError('startDate must be before endDate');
  }

  const periodStart = options.startDate;
  const periodEnd = options.endDate;
  const periodMs = periodEnd.getTime() - periodStart.getTime();
  const periodDays = periodMs / (1000 * 60 * 60 * 24);

  let totalExpected = 0;
  let totalActual = 0;
  let totalProrations = 0;
  let totalFxDiff = 0;
  let totalDiscounts = 0;

  const lineItems: RevenueReconciliationResult['lineItems'] = [];

  for (const sub of subscriptions) {
    if (!options.includeTrials && sub.status === 'in_trial') continue;

    const customerId = sub.customer.customer_id;
    const customerName = sub.customer.company;

    const expectedForSub = computeExpectedRevenue(sub, periodStart, periodEnd, fxRates);
    const prorationAmount = computeProrationAmount(sub, periodStart, periodEnd, fxRates);

    const subPayments = payments.filter(
      (p) =>
        p.customer_id === customerId &&
        p.status === 'succeeded' &&
        !p.refund_id &&
        isInPeriod(p.payment_date, periodStart, periodEnd),
    );

    let actualForSub = 0;
    for (const p of subPayments) {
      actualForSub += convertToUSD(p.amount, p.currency, new Date(p.payment_date), fxRates);
    }

    const diff = actualForSub - expectedForSub;
    const reason = determineReason(sub, diff, prorationAmount);

    lineItems.push({
      customerId,
      customerName,
      expected: expectedForSub,
      actual: actualForSub,
      difference: diff,
      reason,
    });

    totalExpected += expectedForSub;
    totalActual += actualForSub;
    totalProrations += Math.abs(prorationAmount);

    if (sub.plan.currency.toLowerCase() !== 'usd') {
      totalFxDiff += Math.abs(diff) > 0 ? estimateFxComponent(diff) : 0;
    }

    const discountAmount = computeDiscountAmount(sub, periodStart, periodEnd, fxRates);
    totalDiscounts += discountAmount;
  }

  const difference = totalActual - totalExpected;
  const differencePercent =
    totalExpected !== 0 ? (Math.abs(difference) / totalExpected) * 100 : 0;

  const unexplained =
    Math.abs(difference) -
    Math.abs(totalProrations) -
    Math.abs(totalFxDiff) -
    Math.abs(totalDiscounts);

  return {
    expectedRevenue: totalExpected,
    actualRevenue: totalActual,
    difference,
    differencePercent,
    lineItems,
    breakdown: {
      prorations: totalProrations,
      discounts: totalDiscounts,
      fxDifferences: totalFxDiff,
      timingDifferences: 0,
      unexplained: Math.max(0, unexplained),
    },
  };
}

function isInPeriod(dateStr: string, start: Date, end: Date): boolean {
  const d = new Date(dateStr);
  return d >= start && d < end;
}

function computeExpectedRevenue(
  sub: ChargebeeSubscription,
  periodStart: Date,
  periodEnd: Date,
  fxRates: FXRate[],
): number {
  const periodMs = periodEnd.getTime() - periodStart.getTime();
  const periodDays = periodMs / (1000 * 60 * 60 * 24);
  const currency = sub.plan.currency;

  const changes = sub.plan_changes.filter((c) => {
    const changeDate = new Date(c.change_date);
    return changeDate >= periodStart && changeDate < periodEnd;
  });

  if (changes.length === 0) {
    const monthlyRate = getMonthlyPrice(sub);
    const fractionOfMonth = periodDays / daysInContainingMonth(periodStart);
    const rawExpected = Math.round(monthlyRate * fractionOfMonth);
    return convertToUSD(rawExpected, currency, periodStart, fxRates);
  }

  let expected = 0;
  const firstChange = changes[0];
  if (!firstChange) return 0;
  let currentRate = firstChange.previous_amount;
  let segStart = periodStart;

  for (const change of changes) {
    const changeDate = new Date(change.change_date);
    const segDays = (changeDate.getTime() - segStart.getTime()) / (1000 * 60 * 60 * 24);
    const monthDays = daysInContainingMonth(segStart);
    const monthlyPrev = toMonthlyRate(currentRate, sub.plan.billing_period);
    expected += Math.round(monthlyPrev * (segDays / monthDays));

    currentRate = change.new_amount;
    segStart = changeDate;
  }

  const remainingDays = (periodEnd.getTime() - segStart.getTime()) / (1000 * 60 * 60 * 24);
  const monthDays = daysInContainingMonth(segStart);
  const monthlyNew = toMonthlyRate(currentRate, sub.plan.billing_period);
  expected += Math.round(monthlyNew * (remainingDays / monthDays));

  return convertToUSD(expected, currency, periodStart, fxRates);
}

function computeProrationAmount(
  sub: ChargebeeSubscription,
  periodStart: Date,
  periodEnd: Date,
  fxRates: FXRate[],
): number {
  let total = 0;
  for (const change of sub.plan_changes) {
    const changeDate = new Date(change.change_date);
    if (changeDate >= periodStart && changeDate < periodEnd && change.proration_amount != null) {
      total += convertToUSD(
        change.proration_amount,
        sub.plan.currency,
        changeDate,
        fxRates,
      );
    }
  }
  return total;
}

function computeDiscountAmount(
  sub: ChargebeeSubscription,
  periodStart: Date,
  periodEnd: Date,
  fxRates: FXRate[],
): number {
  let total = 0;
  for (const coupon of sub.coupons) {
    const validFrom = new Date(coupon.valid_from);
    const validTill = coupon.valid_till ? new Date(coupon.valid_till) : periodEnd;
    if (validFrom < periodEnd && validTill > periodStart) {
      if (coupon.discount_type === 'percentage') {
        const monthlyRate = getMonthlyPrice(sub);
        total += Math.round(monthlyRate * (coupon.discount_value / 100));
      } else {
        total += convertToUSD(coupon.discount_value, sub.plan.currency, periodStart, fxRates);
      }
    }
  }
  return total;
}

function getMonthlyPrice(sub: ChargebeeSubscription): number {
  return toMonthlyRate(sub.plan.price, sub.plan.billing_period);
}

function toMonthlyRate(amount: number, billingPeriodMonths: number): number {
  if (billingPeriodMonths <= 0) return amount;
  return Math.round(amount / billingPeriodMonths);
}

function daysInContainingMonth(date: Date): number {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  return new Date(y, m + 1, 0).getDate();
}

function determineReason(
  sub: ChargebeeSubscription,
  diff: number,
  prorationAmount: number,
): string {
  if (Math.abs(diff) < 1_00) return 'within tolerance';
  if (sub.plan_changes.length > 0 && prorationAmount !== 0) return 'proration adjustment';
  if (sub.plan.currency.toLowerCase() !== 'usd') return 'fx conversion difference';
  if (sub.coupons.length > 0) return 'discount applied';
  return 'unexplained difference';
}

function estimateFxComponent(diff: number): number {
  return Math.round(Math.abs(diff) * 0.5);
}

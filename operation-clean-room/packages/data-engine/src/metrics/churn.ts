import type { ChurnBreakdown, ChurnResult, MetricOptions } from './types.js';
import type { LoadedData } from '../data/bootstrap.js';
import type { ChargebeeSubscription } from '../ingestion/types.js';
import { convertToUSD } from '../utils/fx.js';

const MS_DAY = 86_400_000;

/**
 * Churn metrics calculation.
 *
 * @param data - Loaded datasets
 * @param startDate - Beginning of the measurement period
 * @param endDate - End of the measurement period
 * @param options - Calculation options
 * @returns Comprehensive churn metrics with breakdowns
 */
export async function calculateChurn(
  data: LoadedData,
  startDate: Date,
  endDate: Date,
  options?: MetricOptions,
): Promise<ChurnResult> {
  const fxDate = options?.endDate ?? endDate;
  const accountByChargebeeId = new Map(
    data.salesforceAccounts
      .filter((a) => a.chargebee_customer_id)
      .map((a) => [a.chargebee_customer_id!, a]),
  );

  function segmentLabel(sub: ChargebeeSubscription): string {
    const acct = accountByChargebeeId.get(sub.customer.customer_id);
    return acct?.segment ?? 'unknown';
  }

  function tenureMonths(sub: ChargebeeSubscription, end: Date): number {
    const created = new Date(sub.created_at);
    return Math.max(0, Math.floor((end.getTime() - created.getTime()) / (MS_DAY * 30)));
  }

  function activeAt(sub: ChargebeeSubscription, d: Date): boolean {
    if (new Date(sub.created_at) > d) return false;
    if (sub.cancelled_at) {
      const c = new Date(sub.cancelled_at);
      if (c <= d) return false;
    }
    return true;
  }

  function effectiveMrrMinor(sub: ChargebeeSubscription): number {
    if (sub.mrr > 0) return sub.mrr;
    const p = sub.plan.price;
    return sub.plan.billing_period_unit === 'year' ? Math.round(p / 12) : p;
  }

  function arrUsd(sub: ChargebeeSubscription): number {
    const mrrUsd = convertToUSD(effectiveMrrMinor(sub), sub.plan.currency, fxDate, data.fxRates);
    return mrrUsd * 12;
  }

  const startingCustomers = new Set<string>();
  let startingRevenue = 0;
  for (const sub of data.chargebeeSubscriptions) {
    if (!activeAt(sub, startDate)) continue;
    if (sub.mrr <= 0) continue;
    const cid = sub.customer.customer_id;
    startingCustomers.add(cid);
    startingRevenue += arrUsd(sub);
  }

  const startMs = startDate.getTime();
  const endMs = endDate.getTime();

  const churnedCustomers = new Set<string>();
  let revenueChurned = 0;
  const reasonAgg = new Map<string, { logos: Set<string>; revenue: number }>();
  const segmentAgg = new Map<string, { logos: Set<string>; revenue: number }>();
  const planAgg = new Map<string, { logos: Set<string>; revenue: number }>();
  const tenureAgg = new Map<string, { logos: Set<string>; revenue: number }>();

  function bump(
    map: Map<string, { logos: Set<string>; revenue: number }>,
    label: string,
    customerId: string,
    rev: number,
  ) {
    const cur = map.get(label) ?? { logos: new Set<string>(), revenue: 0 };
    cur.logos.add(customerId);
    cur.revenue += rev;
    map.set(label, cur);
  }

  for (const sub of data.chargebeeSubscriptions) {
    if (sub.status !== 'cancelled' || !sub.cancelled_at) continue;
    const cAt = new Date(sub.cancelled_at).getTime();
    if (cAt < startMs || cAt > endMs) continue;

    const cid = sub.customer.customer_id;
    if (!startingCustomers.has(cid)) continue;

    const hadResign = data.chargebeeSubscriptions.some(
      (s) =>
        s.customer.customer_id === cid &&
        s.subscription_id !== sub.subscription_id &&
        new Date(s.created_at) > new Date(sub.cancelled_at!),
    );

    const rev = arrUsd(sub);
    revenueChurned += rev;
    churnedCustomers.add(cid);

    const reason = sub.cancel_reason?.trim() || 'unknown';
    bump(reasonAgg, reason, cid, rev);
    bump(segmentAgg, segmentLabel(sub), cid, rev);
    bump(planAgg, sub.plan.plan_name, cid, rev);
    const tBucket =
      tenureMonths(sub, new Date(sub.cancelled_at!)) < 6
        ? '0-6 mo'
        : tenureMonths(sub, new Date(sub.cancelled_at!)) < 12
          ? '6-12 mo'
          : '12+ mo';
    bump(tenureAgg, tBucket, cid, rev);

    if (hadResign) {
      // Count as churn + new logo: already counted in churn; logo set dedupes customer.
    }
  }

  let contractionRevenue = 0;
  let expansionRevenue = 0;
  for (const sub of data.chargebeeSubscriptions) {
    for (const ch of sub.plan_changes) {
      const cd = new Date(ch.change_date).getTime();
      if (cd < startMs || cd > endMs) continue;
      const prevMinor =
        sub.plan.billing_period_unit === 'year'
          ? Math.round(ch.previous_amount / 12)
          : ch.previous_amount;
      const newMinor =
        sub.plan.billing_period_unit === 'year' ? Math.round(ch.new_amount / 12) : ch.new_amount;
      const prevUsd = convertToUSD(prevMinor, sub.plan.currency, fxDate, data.fxRates);
      const newUsd = convertToUSD(newMinor, sub.plan.currency, fxDate, data.fxRates);
      const deltaMrr = newUsd - prevUsd;
      if (ch.change_type === 'downgrade' && deltaMrr < 0) {
        contractionRevenue += Math.abs(deltaMrr * 12);
      }
      if (ch.change_type === 'upgrade' && deltaMrr > 0) {
        expansionRevenue += deltaMrr * 12;
      }
    }
  }

  const startingCount = startingCustomers.size || 1;
  const logoChurnCount = churnedCustomers.size;
  const logoChurnRate = (logoChurnCount / startingCount) * 100;

  const grossChurn =
    startingRevenue > 0 ? (revenueChurned / startingRevenue) * 100 : 0;
  const netChurn =
    startingRevenue > 0
      ? ((revenueChurned + contractionRevenue - expansionRevenue) / startingRevenue) * 100
      : 0;

  function toBreakdown(
    map: Map<string, { logos: Set<string>; revenue: number }>,
  ): ChurnBreakdown[] {
    return [...map.entries()]
      .map(([label, v]) => ({
        label,
        logoChurn: v.logos.size,
        revenueChurn: v.revenue,
        churnRate: startingRevenue > 0 ? (v.revenue / startingRevenue) * 100 : 0,
      }))
      .sort((a, b) => b.revenueChurn - a.revenueChurn);
  }

  return {
    grossRevenueChurnBreachesThreshold: grossChurn > 3.0,
    grossChurn,
    netChurn,
    logoChurnRate,
    logoChurnCount,
    revenueChurned,
    byReason: toBreakdown(reasonAgg),
    bySegment: toBreakdown(segmentAgg),
    byPlan: toBreakdown(planAgg),
    byTenure: toBreakdown(tenureAgg),
    periodStart: startDate.toISOString().slice(0, 10),
    periodEnd: endDate.toISOString().slice(0, 10),
  };
}

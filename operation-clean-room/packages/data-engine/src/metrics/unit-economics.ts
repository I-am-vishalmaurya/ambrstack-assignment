import type { LoadedData } from '../data/bootstrap.js';
import type { ChannelEconomics, MetricOptions, UnitEconomics } from './types.js';
import { convertToUSD } from '../utils/fx.js';
import { calculateChurn } from './churn.js';

function parsePeriod(period: string): { start: Date; end: Date; months: string[] } {
  const trimmed = period.trim();
  const q = /^(\d{4})-Q([1-4])$/i.exec(trimmed);
  if (q) {
    const y = parseInt(q[1]!, 10);
    const qi = parseInt(q[2]!, 10);
    const startMonth = (qi - 1) * 3;
    const start = new Date(Date.UTC(y, startMonth, 1));
    const end = new Date(Date.UTC(y, startMonth + 3, 0, 23, 59, 59, 999));
    const months: string[] = [];
    for (let m = 0; m < 3; m++) {
      const d = new Date(Date.UTC(y, startMonth + m, 1));
      months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
    }
    return { start, end, months };
  }
  const mo = /^(\d{4})-(\d{2})$/.exec(trimmed);
  if (mo) {
    const y = parseInt(mo[1]!, 10);
    const mi = parseInt(mo[2]!, 10) - 1;
    const start = new Date(Date.UTC(y, mi, 1));
    const end = new Date(Date.UTC(y, mi + 1, 0, 23, 59, 59, 999));
    const label = `${y}-${String(mi + 1).padStart(2, '0')}`;
    return { start, end, months: [label] };
  }
  throw new RangeError(`Invalid period: ${period}`);
}

function grossMarginForPlan(planName: string): number {
  const n = planName.toLowerCase();
  if (n.includes('starter')) return 0.65;
  if (n.includes('growth') || n.includes('enterprise') || n.includes('scale')) {
    return 0.78;
  }
  return 0.72;
}

/**
 * Unit economics calculation (CAC, LTV, LTV/CAC ratio, payback period).
 *
 * @param data - Loaded datasets
 * @param period - The period for calculation (e.g. "2024-Q1", "2024-03")
 * @param options - Calculation options
 * @returns Unit economics with blended and per-channel breakdown
 */
export async function calculateUnitEconomics(
  data: LoadedData,
  period: string,
  options?: MetricOptions,
): Promise<UnitEconomics> {
  const { start, end, months } = parsePeriod(period);
  const fxDate = end;

  const spendRows = data.marketingSpend.filter((m) => months.includes(m.period));
  const totalSpend = spendRows.reduce((s, r) => s + r.spend, 0);

  const newCustomerIds = new Set(
    data.chargebeeSubscriptions
      .filter((s) => {
        const c = new Date(s.created_at);
        return c >= start && c <= end && s.status !== 'cancelled';
      })
      .map((s) => s.customer.customer_id),
  );
  const newLogos = newCustomerIds.size;
  const cac = newLogos > 0 ? totalSpend / newLogos : 0;

  const activeSubs = data.chargebeeSubscriptions.filter(
    (s) => s.status === 'active' && s.mrr > 0,
  );
  let totalMrrUsd = 0;
  let weightedGm = 0;
  for (const s of activeSubs) {
    const m = convertToUSD(s.mrr, s.plan.currency, fxDate, data.fxRates);
    const gm = grossMarginForPlan(s.plan.plan_name);
    totalMrrUsd += m;
    weightedGm += m * gm;
  }
  const grossMargin = totalMrrUsd > 0 ? weightedGm / totalMrrUsd : 0.72;
  const arpa = activeSubs.length > 0 ? totalMrrUsd / activeSubs.length : 0;

  const churn = await calculateChurn(data, start, end, options);
  const monthlyChurnRate = Math.max(0.001, (churn.grossChurn / 100) / 12);

  const ltv = (arpa * grossMargin) / monthlyChurnRate;
  const paybackMonths = arpa * grossMargin > 0 ? cac / (arpa * grossMargin) : 0;
  const paybackTargetMonths = 18;
  const paybackOnTarget = paybackMonths > 0 && paybackMonths <= paybackTargetMonths;
  const ltvCacRatio = cac > 0 ? ltv / cac : 0;

  const byChannelMap = new Map<string, { spend: number; customers: number }>();
  for (const row of spendRows) {
    const cur = byChannelMap.get(row.channel) ?? { spend: 0, customers: 0 };
    cur.spend += row.spend;
    cur.customers += row.conversions;
    byChannelMap.set(row.channel, cur);
  }

  const byChannel: ChannelEconomics[] = [...byChannelMap.entries()].map(([channel, v]) => {
    const cacCh = v.customers > 0 ? v.spend / v.customers : 0;
    const ltvCh = (arpa * grossMargin) / monthlyChurnRate;
    const paybackCh = arpa * grossMargin > 0 ? cacCh / (arpa * grossMargin) : 0;
    return {
      channel,
      cac: cacCh,
      ltv: ltvCh,
      ltvCacRatio: cacCh > 0 ? ltvCh / cacCh : 0,
      paybackMonths: paybackCh,
      customersAcquired: v.customers,
      totalSpend: v.spend,
    };
  });

  return {
    paybackTargetMonths,
    paybackOnTarget,
    cac,
    ltv,
    ltvCacRatio,
    paybackMonths,
    grossMargin,
    arpa,
    byChannel,
    period,
  };
}

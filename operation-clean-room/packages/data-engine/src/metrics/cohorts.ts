import type { LoadedData } from '../data/bootstrap.js';
import type { ChargebeeSubscription } from '../ingestion/types.js';
import type { CohortData, MetricOptions } from './types.js';
import { addMonths, endOfMonth } from 'date-fns';
import { convertToUSD } from '../utils/fx.js';

function cohortMonthKey(createdAt: string): string {
  return createdAt.slice(0, 7);
}

function wasActiveOnDate(sub: ChargebeeSubscription, snapshot: Date): boolean {
  const created = new Date(sub.created_at);
  if (Number.isNaN(created.getTime()) || created > snapshot) return false;
  if (sub.cancelled_at) {
    const c = new Date(sub.cancelled_at);
    if (!Number.isNaN(c.getTime()) && c <= snapshot) return false;
  }
  return true;
}

function mrrUsd(sub: ChargebeeSubscription, asOf: Date, fx: LoadedData['fxRates']): number {
  if (sub.mrr <= 0) return 0;
  return convertToUSD(sub.mrr, sub.plan.currency, asOf, fx);
}

/**
 * Cohort retention analysis for Chargebee subscriptions.
 *
 * @param data - Loaded datasets
 * @param options - Calculation options (`endDate` bounds how far retention is computed)
 * @returns One entry per signup cohort month
 */
export async function buildCohortAnalysis(
  data: LoadedData,
  options?: MetricOptions,
): Promise<CohortData[]> {
  const horizonEnd = options?.endDate ?? new Date();
  const fx = data.fxRates;

  const byMonth = new Map<string, ChargebeeSubscription[]>();
  for (const sub of data.chargebeeSubscriptions) {
    const key = cohortMonthKey(sub.created_at);
    const list = byMonth.get(key) ?? [];
    list.push(sub);
    byMonth.set(key, list);
  }

  const cohortKeys = [...byMonth.keys()].sort();
  const out: CohortData[] = [];

  for (const cohortMonth of cohortKeys) {
    const subs = byMonth.get(cohortMonth)!;
    const cohortStart = new Date(`${cohortMonth}-01T00:00:00.000Z`);
    const cohortMonthEnd = endOfMonth(cohortStart);

    let startRev = 0;
    let logosAtStart = 0;
    for (const sub of subs) {
      if (!wasActiveOnDate(sub, cohortMonthEnd)) continue;
      startRev += mrrUsd(sub, cohortMonthEnd, fx);
      logosAtStart += 1;
    }

    if (logosAtStart === 0 || startRev <= 0) continue;

    const retention: number[] = [];
    const customerRetention: number[] = [];

    let offset = 0;
    while (offset <= 36) {
      const snap = endOfMonth(addMonths(cohortStart, offset));
      if (snap > horizonEnd) break;

      if (offset === 0) {
        retention.push(100);
        customerRetention.push(100);
        offset += 1;
        continue;
      }

      let rev = 0;
      let logos = 0;
      for (const sub of subs) {
        if (!wasActiveOnDate(sub, snap)) continue;
        rev += mrrUsd(sub, snap, fx);
        logos += 1;
      }

      retention.push(startRev > 0 ? (rev / startRev) * 100 : 0);
      customerRetention.push(logosAtStart > 0 ? (logos / logosAtStart) * 100 : 0);
      offset += 1;
    }

    const lastSnap = endOfMonth(addMonths(cohortStart, Math.max(0, retention.length - 1)));
    let latestRev = 0;
    let latestLogos = 0;
    for (const sub of subs) {
      if (!wasActiveOnDate(sub, lastSnap)) continue;
      latestRev += mrrUsd(sub, lastSnap, fx);
      latestLogos += 1;
    }

    out.push({
      cohortMonth,
      customers: logosAtStart,
      revenue: startRev,
      retention,
      customerRetention,
      avgRevenueAtSignup: logosAtStart > 0 ? startRev / logosAtStart : 0,
      avgRevenueLatest: latestLogos > 0 ? latestRev / latestLogos : 0,
    });
  }

  return out;
}

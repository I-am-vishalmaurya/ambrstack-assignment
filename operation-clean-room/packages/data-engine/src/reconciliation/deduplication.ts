import type { DuplicateResult, MatchConfidence } from './types.js';
import type { StripePayment, ChargebeeSubscription } from '../ingestion/types.js';
import { calculateConfidence } from './matcher.js';

export interface DeduplicationOptions {
  nameThreshold?: number;
  migrationGapDays?: number;
  includeCancelled?: boolean;
}

interface StripeWindow {
  customerId: string;
  customerName: string;
  subscriptionId: string;
  start: Date;
  end: Date;
  mrr: number;
  status: string;
}

function buildStripeWindows(payments: StripePayment[]): StripeWindow[] {
  const groups = new Map<string, StripePayment[]>();
  for (const p of payments) {
    if (p.status !== 'succeeded') continue;
    const key = p.subscription_id ?? p.customer_id;
    const list = groups.get(key) ?? [];
    list.push(p);
    groups.set(key, list);
  }

  const windows: StripeWindow[] = [];
  for (const [key, group] of groups) {
    const dates = group.map((p) => new Date(p.payment_date).getTime());
    const start = new Date(Math.min(...dates));
    // Extend end by ~30 days past last payment to cover the billing period
    const lastPaymentDate = new Date(Math.max(...dates));
    const end = new Date(lastPaymentDate.getTime() + 30 * 24 * 60 * 60 * 1000);
    const last = group.reduce((a, b) =>
      new Date(a.payment_date) > new Date(b.payment_date) ? a : b,
    );
    windows.push({
      customerId: last.customer_id,
      customerName: last.customer_name,
      subscriptionId: last.subscription_id ?? key,
      start,
      end,
      mrr: last.amount,
      status: last.status,
    });
  }
  return windows;
}

function overlapDays(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): number {
  const start = Math.max(aStart.getTime(), bStart.getTime());
  const end = Math.min(aEnd.getTime(), bEnd.getTime());
  if (end <= start) return 0;
  return Math.ceil((end - start) / (1000 * 60 * 60 * 24));
}

function gapDays(aEnd: Date, bStart: Date): number {
  const gap = bStart.getTime() - aEnd.getTime();
  return Math.ceil(gap / (1000 * 60 * 60 * 24));
}

/**
 * Detect potential duplicates across Stripe and Chargebee.
 */
export async function detectDuplicates(
  stripeData: StripePayment[],
  chargebeeData: ChargebeeSubscription[],
  options?: DeduplicationOptions,
): Promise<DuplicateResult[]> {
  const nameThreshold = options?.nameThreshold ?? 0.7;
  const migrationGapMax = options?.migrationGapDays ?? 30;

  const stripeWindows = buildStripeWindows(stripeData);
  const results: DuplicateResult[] = [];

  for (const sw of stripeWindows) {
    for (const cb of chargebeeData) {
      const conf = await calculateConfidence(
        { id: sw.customerId, name: sw.customerName },
        { id: cb.customer.customer_id, name: cb.customer.company },
      );

      if (conf.score < nameThreshold) continue;

      const cbStart = new Date(cb.current_term_start);
      const cbEnd = cb.current_term_end
        ? new Date(cb.current_term_end)
        : new Date('2099-12-31');

      const overlap = overlapDays(sw.start, sw.end, cbStart, cbEnd);
      const hasOverlap = overlap > 7;

      const dup: DuplicateResult = {
        stripeRecord: {
          customerId: sw.customerId,
          customerName: sw.customerName,
          subscriptionId: sw.subscriptionId,
          status: sw.status,
          startDate: sw.start.toISOString().slice(0, 10),
          endDate: sw.end.toISOString().slice(0, 10),
          mrr: sw.mrr,
        },
        chargebeeRecord: {
          customerId: cb.customer.customer_id,
          customerName: cb.customer.company,
          subscriptionId: cb.subscription_id,
          status: cb.status,
          startDate: cb.current_term_start,
          endDate: cb.current_term_end,
          mrr: cb.mrr,
        },
        confidence: conf,
        hasOverlap,
        overlapDays: overlap,
        classification: classifyDuplicate({
          stripeRecord: {
            customerId: sw.customerId,
            customerName: sw.customerName,
            subscriptionId: sw.subscriptionId,
            status: sw.status,
            startDate: sw.start.toISOString().slice(0, 10),
            endDate: sw.end.toISOString().slice(0, 10),
            mrr: sw.mrr,
          },
          chargebeeRecord: {
            customerId: cb.customer.customer_id,
            customerName: cb.customer.company,
            subscriptionId: cb.subscription_id,
            status: cb.status,
            startDate: cb.current_term_start,
            endDate: cb.current_term_end,
            mrr: cb.mrr,
          },
          confidence: conf,
          hasOverlap,
          overlapDays: overlap,
          classification: 'uncertain',
        }),
      };

      results.push(dup);
    }
  }

  return results;
}

/**
 * Classify a detected duplicate as true_duplicate, migration, or uncertain.
 *
 * - true_duplicate: overlapping active periods (> 7 days).
 * - migration: sequential with gap <= migrationGapDays.
 * - uncertain: neither rule applies clearly.
 */
export function classifyDuplicate(
  duplicate: DuplicateResult,
  migrationGapDays = 30,
): 'true_duplicate' | 'migration' | 'uncertain' {
  if (duplicate.hasOverlap) return 'true_duplicate';

  const stripeEnd = new Date(duplicate.stripeRecord.endDate ?? duplicate.stripeRecord.startDate);
  const cbStart = new Date(duplicate.chargebeeRecord.startDate);
  const gap = gapDays(stripeEnd, cbStart);

  if (gap >= 0 && gap <= migrationGapDays) return 'migration';

  return 'uncertain';
}

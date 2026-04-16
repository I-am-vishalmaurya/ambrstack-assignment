import { join } from 'node:path';
import { z } from 'zod';
import { DATA_FILES } from '../data/paths.js';
import { loadCSV } from './csv-loader.js';
import type { StripePayment } from './types.js';

const stripeStatusSchema = z.enum(['succeeded', 'failed', 'pending', 'refunded', 'disputed']);

const stripeRowSchema = z.object({
  payment_id: z.string().min(1),
  customer_id: z.string().min(1),
  customer_name: z.string(),
  amount: z.coerce.number(),
  currency: z.string().min(1),
  status: stripeStatusSchema,
  payment_date: z.string().min(1),
  subscription_id: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  failure_code: z.string().nullable().optional(),
  refund_id: z.string().nullable().optional(),
  dispute_id: z.string().nullable().optional(),
});

function emptyToNull(s: string | undefined | null): string | null {
  if (s === undefined || s === null) return null;
  const t = s.trim();
  return t.length === 0 ? null : t;
}

function mapRow(row: Record<string, string>): StripePayment {
  const parsed = stripeRowSchema.safeParse(row);
  if (!parsed.success) {
    console.error('[loadStripePayments] Zod validation failed:', parsed.error.flatten());
    throw new Error(`Invalid Stripe payment row for ${row.payment_id ?? '(unknown)'}: ${parsed.error.message}`);
  }
  const r = parsed.data;
  return {
    payment_id: r.payment_id,
    customer_id: r.customer_id,
    customer_name: r.customer_name,
    amount: r.amount,
    currency: r.currency.toLowerCase(),
    status: r.status,
    payment_date: r.payment_date,
    subscription_id: emptyToNull(r.subscription_id ?? null),
    description: emptyToNull(r.description ?? null),
    failure_code: emptyToNull(r.failure_code ?? null),
    refund_id: emptyToNull(r.refund_id ?? null),
    dispute_id: emptyToNull(r.dispute_id ?? null),
  };
}

/**
 * Load and normalize Stripe payment data from `stripe_payments.csv`.
 */
export async function loadStripePayments(dataDir: string): Promise<StripePayment[]> {
  const filePath = join(dataDir, DATA_FILES.stripePayments);
  try {
    return await loadCSV<StripePayment>(filePath, {
      transform: (rec) => mapRow(rec),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[loadStripePayments]', msg);
    throw new Error(`loadStripePayments failed for ${filePath}: ${msg}`);
  }
}

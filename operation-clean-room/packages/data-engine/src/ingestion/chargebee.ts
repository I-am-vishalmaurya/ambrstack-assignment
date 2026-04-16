import { join } from 'node:path';
import { z } from 'zod';
import { DATA_FILES } from '../data/paths.js';
import { loadJSON } from './json-loader.js';
import type {
  ChargebeeCoupon,
  ChargebeePlanChange,
  ChargebeeSubscription,
} from './types.js';

const subscriptionStatusSchema = z.enum([
  'active',
  'in_trial',
  'cancelled',
  'non_renewing',
  'paused',
  'future',
]);

const couponSchema = z.object({
  coupon_id: z.string(),
  coupon_name: z.string(),
  discount_type: z.enum(['percentage', 'fixed_amount']),
  discount_value: z.coerce.number(),
  apply_on: z.enum(['invoice_amount', 'each_specified_item']),
  valid_from: z.string(),
  valid_till: z.string().nullable().optional(),
});

const planChangeSchema = z.object({
  from_plan: z.string(),
  to_plan: z.string(),
  changed_at: z.string(),
  previous_price: z.coerce.number(),
  new_price: z.coerce.number(),
  change_type: z.enum(['upgrade', 'downgrade', 'lateral']),
  prorated: z.coerce.number().nullable().optional(),
});

const addonSchema = z.object({
  addon_id: z.string(),
  addon_name: z.string(),
  quantity: z.coerce.number(),
  unit_price: z.coerce.number(),
});

const rawPlanSchema = z.object({
  id: z.string(),
  name: z.string(),
  price: z.coerce.number(),
  currency: z.string(),
  interval: z.enum(['month', 'year']),
});

const rawCustomerSchema = z.object({
  id: z.string(),
  company: z.string().optional().default(''),
  email: z.string(),
});

const rawSubscriptionSchema = z.object({
  id: z.string(),
  customer: rawCustomerSchema,
  plan: rawPlanSchema,
  status: subscriptionStatusSchema,
  trial_end: z.string().nullable().optional(),
  created_at: z.string(),
  cancelled_at: z.string().nullable().optional(),
  current_term_start: z.string(),
  current_term_end: z.string(),
  addons: z.array(addonSchema).optional().default([]),
  coupons: z.array(couponSchema).optional().default([]),
  plan_changes: z.array(planChangeSchema).optional().default([]),
  cancel_reason: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const chargebeeFileSchema = z.union([
  z.array(rawSubscriptionSchema),
  z.object({ subscriptions: z.array(rawSubscriptionSchema) }),
]);

function emptyBillingAddress(): ChargebeeSubscription['customer']['billing_address'] {
  return { line1: '', city: '', state: '', country: '', zip: '' };
}

function namesFromEmail(email: string): { first_name: string; last_name: string } {
  const local = email.split('@')[0]?.trim() ?? '';
  if (local.length === 0) {
    return { first_name: '', last_name: '' };
  }
  const tokens = local.split(/[._+-]+/).filter(Boolean);
  if (tokens.length === 0) {
    return { first_name: '', last_name: '' };
  }
  if (tokens.length === 1) {
    return { first_name: tokens[0]!, last_name: '' };
  }
  return { first_name: tokens[0]!, last_name: tokens.slice(1).join(' ') };
}

function mapCoupon(c: z.infer<typeof couponSchema>): ChargebeeCoupon {
  return {
    coupon_id: c.coupon_id,
    coupon_name: c.coupon_name,
    discount_type: c.discount_type,
    discount_value: c.discount_value,
    apply_on: c.apply_on,
    valid_from: c.valid_from,
    valid_till: c.valid_till?.trim() ? c.valid_till : null,
  };
}

function mapPlanChange(pc: z.infer<typeof planChangeSchema>): ChargebeePlanChange {
  return {
    change_date: pc.changed_at,
    previous_plan: pc.from_plan,
    new_plan: pc.to_plan,
    previous_amount: pc.previous_price,
    new_amount: pc.new_price,
    change_type: pc.change_type,
    proration_amount: pc.prorated == null ? null : pc.prorated,
  };
}

function computeMrr(
  planPrice: number,
  interval: 'month' | 'year',
  addons: z.infer<typeof addonSchema>[],
): number {
  const base = interval === 'year' ? planPrice / 12 : planPrice;
  const addonMrr = addons.reduce((sum, a) => sum + a.unit_price * a.quantity, 0);
  return base + addonMrr;
}

function mapSubscription(raw: z.infer<typeof rawSubscriptionSchema>): ChargebeeSubscription {
  const { first_name, last_name } = namesFromEmail(raw.customer.email);
  const billing_period_unit: 'month' | 'year' =
    raw.plan.interval === 'year' ? 'year' : 'month';

  return {
    subscription_id: raw.id,
    customer: {
      customer_id: raw.customer.id,
      first_name,
      last_name,
      email: raw.customer.email,
      company: raw.customer.company,
      billing_address: emptyBillingAddress(),
    },
    plan: {
      plan_id: raw.plan.id,
      plan_name: raw.plan.name,
      price: raw.plan.price,
      currency: raw.plan.currency,
      billing_period: 1,
      billing_period_unit,
      trial_end: raw.trial_end?.trim() ? raw.trial_end : null,
    },
    status: raw.status,
    current_term_start: raw.current_term_start,
    current_term_end: raw.current_term_end,
    created_at: raw.created_at,
    cancelled_at: raw.cancelled_at?.trim() ? raw.cancelled_at : null,
    cancel_reason: raw.cancel_reason?.trim() ? raw.cancel_reason : null,
    mrr: computeMrr(raw.plan.price, raw.plan.interval, raw.addons ?? []),
    coupons: (raw.coupons ?? []).map(mapCoupon),
    plan_changes: (raw.plan_changes ?? []).map(mapPlanChange),
    addons: (raw.addons ?? []).map((a) => ({
      addon_id: a.addon_id,
      addon_name: a.addon_name,
      quantity: a.quantity,
      unit_price: a.unit_price,
    })),
    metadata: raw.metadata ?? {},
  };
}

/**
 * Load and normalize Chargebee subscription data from `chargebee_subscriptions.json`.
 */
export async function loadChargebeeSubscriptions(
  dataDir: string,
): Promise<ChargebeeSubscription[]> {
  const filePath = join(dataDir, DATA_FILES.chargebeeSubscriptions);
  try {
    const parsedFile = chargebeeFileSchema.safeParse(await loadJSON<unknown>(filePath));
    if (!parsedFile.success) {
      console.error('[loadChargebeeSubscriptions] File validation failed:', parsedFile.error.flatten());
      throw new Error(`Invalid Chargebee subscriptions file ${filePath}: ${parsedFile.error.message}`);
    }

    const rawList = Array.isArray(parsedFile.data)
      ? parsedFile.data
      : parsedFile.data.subscriptions;

    return rawList.map((row) => mapSubscription(row));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[loadChargebeeSubscriptions]', msg);
    throw new Error(`loadChargebeeSubscriptions failed for ${filePath}: ${msg}`);
  }
}

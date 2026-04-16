import { differenceInCalendarDays, parseISO, subDays } from 'date-fns';
import type { LoadedData } from '../data/bootstrap.js';
import type {
  ChargebeeCoupon,
  ChargebeeSubscription,
  NPSSurvey,
  SalesforceAccount,
} from '../ingestion/types.js';
import type { HealthScore, HealthScoringOptions, HealthSignal } from './types.js';
import { RiskLevel } from './types.js';

const DEFAULT_WEIGHTS = {
  productUsage: 0.3,
  supportSentiment: 0.2,
  billingHealth: 0.2,
  nps: 0.15,
  engagement: 0.15,
} as const;

function normalizeCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,'"]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalNpsAccountId(raw: string): string | null {
  const t = String(raw ?? '').trim();
  if (t.length === 0) return null;
  if (/^acc-/i.test(t)) {
    const suffix = t.replace(/^acc-/i, '');
    const num = Number(suffix);
    if (Number.isFinite(num)) {
      return `ACC-${String(Math.trunc(num)).padStart(5, '0')}`;
    }
    return t;
  }
  const num = Number(t);
  if (Number.isFinite(num) && num > 0 && Number.isInteger(num)) {
    return `ACC-${String(Math.trunc(num)).padStart(5, '0')}`;
  }
  return t;
}

function buildSalesforceNameIndex(accounts: SalesforceAccount[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const a of accounts) {
    const key = normalizeCompanyName(a.account_name);
    if (key.length === 0) continue;
    if (!map.has(key)) {
      map.set(key, a.account_id);
    }
  }
  return map;
}

function buildChargebeeCustomerIndex(accounts: SalesforceAccount[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const a of accounts) {
    const id = a.chargebee_customer_id?.trim();
    if (id) map.set(id, a.account_id);
  }
  return map;
}

function findSalesforceAccount(
  accounts: SalesforceAccount[],
  sub: ChargebeeSubscription,
  byChargebeeId: Map<string, string>,
  byCompany: Map<string, string>,
): SalesforceAccount | null {
  const accId =
    byChargebeeId.get(sub.customer.customer_id) ??
    byCompany.get(normalizeCompanyName(sub.customer.company));
  if (!accId) return null;
  return accounts.find((a) => a.account_id === accId) ?? null;
}

function activeCouponRisk(coupons: ChargebeeCoupon[], now: Date): boolean {
  return coupons.some((c) => {
    const from = parseISO(c.valid_from);
    if (Number.isNaN(from.getTime())) return false;
    const till = c.valid_till ? parseISO(c.valid_till) : null;
    const tillOk = till == null || Number.isNaN(till.getTime()) || till >= now;
    return from <= now && tillOk;
  });
}

function scoreProductUsage(activeDays: number): number {
  if (activeDays > 20) return 100;
  if (activeDays >= 10) return 70;
  if (activeDays >= 5) return 40;
  return 15;
}

function scoreOpenTicketsBase(openCount: number): number {
  if (openCount === 0) return 100;
  if (openCount <= 2) return 75;
  if (openCount <= 5) return 50;
  return 20;
}

function engagementTrendScore(lastCount: number, priorCount: number): { value: number; trend: HealthSignal['trend'] } {
  if (priorCount === 0 && lastCount === 0) return { value: 60, trend: 'stable' };
  if (priorCount === 0 && lastCount > 0) return { value: 90, trend: 'improving' };
  const change = (lastCount - priorCount) / priorCount;
  if (change > 0.1) return { value: 90, trend: 'improving' };
  if (change < -0.1) return { value: 25, trend: 'declining' };
  return { value: 60, trend: 'stable' };
}

function mapNpsCategoryToScore(category: NPSSurvey['category']): number {
  if (category === 'promoter') return 100;
  if (category === 'passive') return 60;
  return 20;
}

function riskLevelFromScore(score: number): RiskLevel {
  if (score >= 80) return RiskLevel.LOW;
  if (score >= 50) return RiskLevel.MEDIUM;
  if (score >= 25) return RiskLevel.HIGH;
  return RiskLevel.CRITICAL;
}

function weightedComposite(signals: HealthSignal[]): number {
  let num = 0;
  let den = 0;
  for (const s of signals) {
    if (s.weight <= 0) continue;
    num += s.weight * s.value;
    den += s.weight;
  }
  if (den === 0) return 0;
  return Math.round(num / den);
}

function buildRiskSummary(
  risk: RiskLevel,
  signals: HealthSignal[],
  productUnavailable: boolean,
  highUrgentOpens: boolean,
  billingWeak: boolean,
  npsWeak: boolean,
  engagementDeclining: boolean,
): string {
  const parts: string[] = [];
  if (risk === RiskLevel.LOW) {
    parts.push('Low risk');
    const usage = signals.find((s) => s.name === 'Product Usage')?.value ?? 0;
    if (!productUnavailable && usage >= 70) {
      parts.push('strong product engagement');
    }
    if (!billingWeak) parts.push('solid billing health');
    return `${parts[0]} — ${parts.slice(1).join(' and ') || 'healthy signals across dimensions'}.`;
  }
  if (risk === RiskLevel.MEDIUM) {
    return `Medium risk — ${[
      productUnavailable && 'limited product telemetry',
      highUrgentOpens && 'notable support load',
      billingWeak && 'some billing friction',
      npsWeak && 'mixed customer sentiment',
      engagementDeclining && 'softening usage trend',
    ]
      .filter(Boolean)
      .join('; ') || 'a few signals warrant proactive outreach'}.`;
  }
  if (risk === RiskLevel.HIGH) {
    return `High risk — ${[
      engagementDeclining && 'declining usage',
      highUrgentOpens && 'multiple support escalations',
      billingWeak && 'payment or discount risk',
      npsWeak && 'weak NPS',
      productUnavailable && 'missing usage visibility',
    ]
      .filter(Boolean)
      .join('; ') || 'several health signals are flashing yellow or red'}.`;
  }
  return `Critical risk — ${[
    engagementDeclining && 'sharp usage decline',
    highUrgentOpens && 'severe support backlog',
    billingWeak && 'billing stress or heavy discounting',
    npsWeak && 'detractor-heavy sentiment',
    productUnavailable && 'no product usage signal',
  ]
    .filter(Boolean)
    .join('; ') || 'multiple severe risk drivers detected'}.`;
}

/**
 * Multi-signal customer health scoring model.
 *
 * @param data - Loaded datasets (Chargebee, Stripe, product events, etc.)
 * @param options - Scoring options (weight overrides, filters, etc.)
 * @returns Array of health scores, one per qualifying account
 */
export async function calculateHealthScores(
  data: LoadedData,
  options?: HealthScoringOptions,
): Promise<HealthScore[]> {
  const now = new Date();
  const trendDays = options?.trendWindowDays ?? 30;
  const windowStart = subDays(now, trendDays);
  const priorWindowStart = subDays(now, trendDays * 2);
  const priorWindowEnd = windowStart;

  const w = { ...DEFAULT_WEIGHTS, ...options?.weights };
  const minMrr = options?.minMRR ?? 0;
  const segmentFilter = options?.segments?.map((s) => s.toLowerCase()) ?? null;

  const byChargebeeId = buildChargebeeCustomerIndex(data.salesforceAccounts);
  const byCompany = buildSalesforceNameIndex(data.salesforceAccounts);

  const activeSubs = data.chargebeeSubscriptions.filter((s) => s.status === 'active');
  const groups = new Map<string, ChargebeeSubscription[]>();
  for (const sub of activeSubs) {
    const sf = findSalesforceAccount(data.salesforceAccounts, sub, byChargebeeId, byCompany);
    const key = sf?.account_id ?? `cb:${sub.customer.customer_id}`;
    const list = groups.get(key) ?? [];
    list.push(sub);
    groups.set(key, list);
  }

  const npsByAccount = new Map<string, NPSSurvey[]>();
  for (const survey of data.npsSurveys) {
    const aid = canonicalNpsAccountId(survey.account_id);
    if (!aid) continue;
    const list = npsByAccount.get(aid) ?? [];
    list.push(survey);
    npsByAccount.set(aid, list);
  }
  for (const [, list] of npsByAccount) {
    list.sort((a, b) => parseISO(b.survey_date).getTime() - parseISO(a.survey_date).getTime());
  }

  const eventsByAccount = new Map<string, typeof data.productEvents>();
  for (const ev of data.productEvents) {
    const list = eventsByAccount.get(ev.account_id) ?? [];
    list.push(ev);
    eventsByAccount.set(ev.account_id, list);
  }

  const ticketsByAccount = new Map<string, typeof data.supportTickets>();
  for (const t of data.supportTickets) {
    const list = ticketsByAccount.get(t.account_id) ?? [];
    list.push(t);
    ticketsByAccount.set(t.account_id, list);
  }

  const stripeByCustomerName = new Map<string, typeof data.stripePayments>();
  for (const p of data.stripePayments) {
    const k = normalizeCompanyName(p.customer_name);
    if (!k) continue;
    const list = stripeByCustomerName.get(k) ?? [];
    list.push(p);
    stripeByCustomerName.set(k, list);
  }

  const results: HealthScore[] = [];

  for (const [, subs] of groups) {
    const primary = subs.reduce((a, b) => (a.mrr >= b.mrr ? a : b));
    const totalMrr = subs.reduce((sum, s) => sum + s.mrr, 0);
    if (totalMrr < minMrr) continue;

    const sf = findSalesforceAccount(data.salesforceAccounts, primary, byChargebeeId, byCompany);
    const accountId = sf?.account_id ?? `cb:${primary.customer.customer_id}`;
    const segment = sf?.segment ?? 'unknown';
    if (segmentFilter && !segmentFilter.includes(segment)) continue;

    const renewalEnd = subs
      .map((s) => parseISO(s.current_term_end))
      .filter((d) => !Number.isNaN(d.getTime()))
      .sort((a, b) => a.getTime() - b.getTime())[0];
    const daysUntilRenewal =
      renewalEnd != null ? Math.round(differenceInCalendarDays(renewalEnd, now)) : null;

    const resolvedAccountId = sf?.account_id ?? null;
    const productEvents = resolvedAccountId ? eventsByAccount.get(resolvedAccountId) ?? [] : [];

    const inLast = productEvents.filter((e) => {
      const d = parseISO(e.timestamp);
      return !Number.isNaN(d.getTime()) && d >= windowStart && d <= now;
    });
    const inPrior = productEvents.filter((e) => {
      const d = parseISO(e.timestamp);
      return !Number.isNaN(d.getTime()) && d >= priorWindowStart && d < priorWindowEnd;
    });

    const activeDayKeys = new Set<string>();
    const features = new Set<string>();
    for (const e of inLast) {
      const d = parseISO(e.timestamp);
      if (!Number.isNaN(d.getTime())) {
        activeDayKeys.add(d.toISOString().slice(0, 10));
      }
      if (e.feature?.trim()) features.add(e.feature);
    }
    const activeDays = activeDayKeys.size;
    const uniqueFeatures = features.size;
    const totalEvents = inLast.length;

    let productSignal: HealthSignal;
    let productUnavailable = false;
    if (!resolvedAccountId || productEvents.length === 0) {
      productUnavailable = true;
      productSignal = {
        name: 'Product Usage',
        weight: w.productUsage,
        value: 0,
        source: 'product_events',
        rawValue: 'unavailable',
      };
    } else {
      productSignal = {
        name: 'Product Usage',
        weight: w.productUsage,
        value: scoreProductUsage(activeDays),
        source: 'product_events',
        rawValue: JSON.stringify({ activeDays, uniqueFeatures, totalEvents }),
      };
    }

    const supportList = resolvedAccountId ? ticketsByAccount.get(resolvedAccountId) ?? [] : [];
    const openTickets = supportList.filter((t) => t.status === 'open' || t.status === 'pending');
    const openUrgent = openTickets.filter((t) => t.priority === 'urgent').length;
    const openHigh = openTickets.filter((t) => t.priority === 'high').length;

    let supportScore = scoreOpenTicketsBase(openTickets.length);
    supportScore -= openUrgent * 12;
    supportScore -= openHigh * 6;
    const ratedResolved = supportList.filter(
      (t) =>
        (t.status === 'solved' || t.status === 'closed') &&
        t.satisfaction_rating != null &&
        t.satisfaction_rating >= 1 &&
        t.satisfaction_rating <= 5,
    );
    if (ratedResolved.length > 0) {
      const avg =
        ratedResolved.reduce((s, t) => s + (t.satisfaction_rating as number), 0) / ratedResolved.length;
      if (avg <= 2) supportScore -= 25;
      else if (avg <= 3) supportScore -= 12;
      else if (avg >= 4.5) supportScore += 8;
    }
    supportScore = Math.max(0, Math.min(100, Math.round(supportScore)));

    const supportSignal: HealthSignal = {
      name: 'Support Sentiment',
      weight: w.supportSentiment,
      value: supportScore,
      source: 'support',
      rawValue: JSON.stringify({
        open: openTickets.length,
        openUrgent,
        openHigh,
        csatTickets: ratedResolved.length,
      }),
    };

    const payNameKey = normalizeCompanyName(primary.customer.company);
    const payments = stripeByCustomerName.get(payNameKey) ?? [];
    const payWindowStart = subDays(now, 90);
    const recent = payments.filter((p) => {
      const d = parseISO(p.payment_date);
      return !Number.isNaN(d.getTime()) && d >= payWindowStart;
    });
    const attempted = recent.filter((p) => p.status === 'succeeded' || p.status === 'failed').length;
    const failed = recent.filter((p) => p.status === 'failed').length;
    const failRate = attempted === 0 ? 0 : failed / attempted;

    let billingScore = 100;
    if (attempted === 0) billingScore = 85;
    else if (failRate === 0) billingScore = 100;
    else if (failRate < 0.05) billingScore = 80;
    else if (failRate <= 0.15) billingScore = 50;
    else billingScore = 20;

    const couponRisk = subs.some((s) => activeCouponRisk(s.coupons, now));
    if (couponRisk) billingScore = Math.max(0, billingScore - 15);

    const billingSignal: HealthSignal = {
      name: 'Billing Health',
      weight: w.billingHealth,
      value: billingScore,
      source: 'stripe',
      rawValue: JSON.stringify({
        paymentsInWindow: recent.length,
        failureRate: attempted ? Math.round(failRate * 1000) / 1000 : 0,
        activeCoupons: couponRisk,
      }),
    };

    let npsValue = 50;
    let npsTrend: HealthSignal['trend'] = 'stable';
    const npsList = resolvedAccountId ? npsByAccount.get(resolvedAccountId) ?? [] : [];
    const latest = npsList[0];
    if (latest) {
      const mapped = mapNpsCategoryToScore(latest.category);
      const surveyAt = parseISO(latest.survey_date);
      const ageDays = Number.isNaN(surveyAt.getTime())
        ? 0
        : differenceInCalendarDays(now, surveyAt);
      if (ageDays > 180) {
        npsValue = Math.round(mapped * 0.5 + 50 * 0.5);
      } else {
        npsValue = mapped;
      }
      npsTrend =
        latest.category === 'promoter' ? 'improving' : latest.category === 'detractor' ? 'declining' : 'stable';
    }
    const npsSignal: HealthSignal = {
      name: 'NPS',
      weight: w.nps,
      value: npsValue,
      source: 'nps',
      rawValue: latest ? latest.score : 'none',
      trend: npsTrend,
    };

    const { value: engValue, trend: engTrend } = engagementTrendScore(inLast.length, inPrior.length);
    const engagementSignal: HealthSignal = {
      name: 'Engagement Trend',
      weight: w.engagement,
      value: engValue,
      source: 'product_events',
      rawValue: JSON.stringify({ last30: inLast.length, prior30: inPrior.length }),
      trend: engTrend,
    };

    const signals = [productSignal, supportSignal, billingSignal, npsSignal, engagementSignal];
    const score = weightedComposite(signals);
    const riskLevel = riskLevelFromScore(score);

    const highUrgentOpens = openUrgent >= 1 || openHigh >= 3;
    const billingWeak = billingScore < 70;
    const npsWeak = npsValue < 55;
    const engagementDeclining = engTrend === 'declining';

    const riskSummary = buildRiskSummary(
      riskLevel,
      signals,
      productUnavailable,
      highUrgentOpens,
      billingWeak,
      npsWeak,
      engagementDeclining,
    );

    results.push({
      accountId,
      accountName: primary.customer.company || sf?.account_name || accountId,
      score,
      signals,
      riskLevel,
      lastUpdated: now.toISOString(),
      mrr: totalMrr,
      plan: primary.plan.plan_name,
      segment,
      daysUntilRenewal,
      riskSummary,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

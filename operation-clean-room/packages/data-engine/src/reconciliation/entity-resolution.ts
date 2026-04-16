import { randomUUID } from 'node:crypto';
import type { LoadedData } from '../data/bootstrap.js';
import {
  DataSource,
  type ChargebeeSubscription,
  type LegacyInvoice,
  type NPSSurvey,
  type SalesforceAccount,
  type StripePayment,
  type UnifiedCustomer,
} from '../ingestion/types.js';
import type { Discrepancy } from './types.js';
import { DiscrepancyType, Severity } from './types.js';
import { normalizeCompanyName } from '../utils/normalization.js';

function tokenizeNormalized(name: string): Set<string> {
  const n = normalizeCompanyName(name);
  return new Set(n.split(/\s+/).filter((t) => t.length > 0));
}

function jaccardSimilarityTokens(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function jaccardNameSimilarity(a: string, b: string): number {
  return jaccardSimilarityTokens(tokenizeNormalized(a), tokenizeNormalized(b));
}

function extractEmailDomain(email: string): string | null {
  const at = email.indexOf('@');
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase().trim();
}

function websiteHost(website: string): string | null {
  const w = website.trim();
  if (!w) return null;
  try {
    const u = w.includes('://') ? new URL(w) : new URL(`https://${w}`);
    let host = u.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    return host || null;
  } catch {
    return null;
  }
}

function domainsAlign(emailDomain: string | null, siteHost: string | null): boolean {
  if (!emailDomain || !siteHost) return false;
  if (emailDomain === siteHost) return true;
  if (emailDomain.endsWith(`.${siteHost}`)) return true;
  if (siteHost.endsWith(`.${emailDomain}`)) return true;
  return false;
}

function keySf(id: string): string {
  return `salesforce:${id}`;
}
function keyCb(subId: string): string {
  return `chargebee:${subId}`;
}
function keyStripe(customerId: string): string {
  return `stripe:${customerId}`;
}
function keyLegacy(invId: string): string {
  return `legacy:${invId}`;
}

function parseTime(isoOrRaw: string): number {
  const t = Date.parse(isoOrRaw);
  return Number.isFinite(t) ? t : 0;
}

const MS_90_DAYS = 90 * 24 * 60 * 60 * 1000;

class UnionFind {
  private readonly parent = new Map<string, string>();
  private readonly clusterConfidence = new Map<string, number>();

  ensure(key: string): void {
    if (!this.parent.has(key)) {
      this.parent.set(key, key);
      this.clusterConfidence.set(key, 1);
    }
  }

  find(key: string): string {
    this.ensure(key);
    const p = this.parent.get(key)!;
    if (p !== key) {
      const root = this.find(p);
      this.parent.set(key, root);
      return root;
    }
    return key;
  }

  /**
   * Merge components; cluster confidence is the minimum of existing roots and the new edge confidence.
   */
  union(a: string, b: string, edgeConfidence: number): void {
    this.ensure(a);
    this.ensure(b);
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) {
      this.clusterConfidence.set(ra, Math.min(this.clusterConfidence.get(ra)!, edgeConfidence));
      return;
    }
    const ca = this.clusterConfidence.get(ra)!;
    const cb = this.clusterConfidence.get(rb)!;
    const mergedConf = Math.min(ca, cb, edgeConfidence);
    // attach smaller id to larger for determinism
    if (ra < rb) {
      this.parent.set(rb, ra);
      this.clusterConfidence.set(ra, mergedConf);
      this.clusterConfidence.delete(rb);
    } else {
      this.parent.set(ra, rb);
      this.clusterConfidence.set(rb, mergedConf);
      this.clusterConfidence.delete(ra);
    }
  }

  getClusterConfidence(root: string): number {
    const r = this.find(root);
    return this.clusterConfidence.get(r) ?? 1;
  }

}

type TokenCandidate = { displayName: string; key: string };

function upperTokens(s: string): string[] {
  return s
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function buildAbbreviationLookup(
  stripeByCustomer: Map<string, { name: string }>,
  chargebeeSubs: ChargebeeSubscription[],
): Map<string, Set<TokenCandidate>> {
  const map = new Map<string, Set<TokenCandidate>>();

  function addFromName(displayName: string, key: string): void {
    const tokens = upperTokens(displayName);
    const seenTok = new Set<string>();
    for (const tok of tokens) {
      if (seenTok.has(tok)) continue;
      seenTok.add(tok);
      let set = map.get(tok);
      if (!set) {
        set = new Set();
        map.set(tok, set);
      }
      set.add({ displayName, key });
    }
  }

  for (const [cid, v] of stripeByCustomer) {
    addFromName(v.name, keyStripe(cid));
  }

  for (const sub of chargebeeSubs) {
    addFromName(sub.customer.company, keyCb(sub.subscription_id));
  }

  return map;
}

function chargebeeCbSfScore(sub: ChargebeeSubscription, acct: SalesforceAccount): number | null {
  const emailDom = extractEmailDomain(sub.customer.email);
  const siteHost = websiteHost(acct.website);
  const domainOk = domainsAlign(emailDom, siteHost);
  const nameJ = jaccardNameSimilarity(sub.customer.company, acct.account_name);

  if (domainOk && nameJ > 0.6) return 0.95;
  if (domainOk && !nameJ) return 0.85;
  if (domainOk && nameJ > 0 && nameJ <= 0.6) return 0.85;
  if (!domainOk && nameJ > 0.6) return 0.85;
  return null;
}

function stripeSfNameScore(stripeName: string, acct: SalesforceAccount): number | null {
  const j = jaccardNameSimilarity(stripeName, acct.account_name);
  if (j > 0.6) return 0.85 + Math.min(0.1, (j - 0.6) * 0.25);
  return null;
}

function deriveSegmentFromPlan(planName: string): UnifiedCustomer['segment'] {
  const p = planName.toLowerCase();
  if (p.includes('enterprise')) return 'enterprise';
  if (p.includes('mid')) return 'mid_market';
  if (p.includes('startup')) return 'startup';
  return 'smb';
}

function makeDiscrepancy(partial: Omit<Discrepancy, 'id' | 'detectedAt' | 'resolved' | 'resolutionNote'> & { id?: string }): Discrepancy {
  const now = new Date().toISOString();
  return {
    id: partial.id ?? randomUUID(),
    type: partial.type,
    severity: partial.severity,
    sourceA: partial.sourceA,
    sourceB: partial.sourceB,
    customerName: partial.customerName,
    amount: partial.amount,
    description: partial.description,
    detectedAt: now,
    resolved: false,
    resolutionNote: null,
  };
}

export async function resolveEntities(data: LoadedData): Promise<{
  customers: UnifiedCustomer[];
  discrepancies: Discrepancy[];
}> {
  const uf = new UnionFind();
  const matched = new Set<string>();
  const discrepancies: Discrepancy[] = [];

  const sfById = new Map(data.salesforceAccounts.map((a) => [a.account_id, a]));
  const cbBySub = new Map(data.chargebeeSubscriptions.map((s) => [s.subscription_id, s]));
  const legacyById = new Map(data.legacyInvoices.map((i) => [i.id, i]));

  const stripeByCustomer = new Map<string, { name: string; payments: StripePayment[] }>();
  for (const p of data.stripePayments) {
    let row = stripeByCustomer.get(p.customer_id);
    if (!row) {
      row = { name: p.customer_name, payments: [] };
      stripeByCustomer.set(p.customer_id, row);
    }
    row.payments.push(p);
    if (p.customer_name) row.name = p.customer_name;
  }

  const allKeys = new Set<string>();
  for (const a of data.salesforceAccounts) allKeys.add(keySf(a.account_id));
  for (const s of data.chargebeeSubscriptions) allKeys.add(keyCb(s.subscription_id));
  for (const [cid] of stripeByCustomer) allKeys.add(keyStripe(cid));
  for (const inv of data.legacyInvoices) allKeys.add(keyLegacy(inv.id));

  for (const k of allKeys) uf.ensure(k);

  // --- Pass 1: Salesforce ID bridge ---
  let pass1 = 0;
  for (const acct of data.salesforceAccounts) {
    const sfk = keySf(acct.account_id);
    if (acct.stripe_customer_id) {
      const sk = keyStripe(acct.stripe_customer_id);
      uf.union(sfk, sk, 1.0);
      matched.add(sfk);
      matched.add(sk);
      pass1++;
    }
    if (acct.chargebee_customer_id) {
      for (const sub of data.chargebeeSubscriptions) {
        if (sub.customer.customer_id === acct.chargebee_customer_id) {
          const ck = keyCb(sub.subscription_id);
          uf.union(sfk, ck, 1.0);
          matched.add(sfk);
          matched.add(ck);
          pass1++;
        }
      }
    }
  }
  console.log(`[entity-resolution] Pass 1: ${pass1} matches`);

  // --- Pass 2: domain + name (Chargebee), name (Stripe) ---
  let pass2 = 0;
  for (const sub of data.chargebeeSubscriptions) {
    const ck = keyCb(sub.subscription_id);
    if (matched.has(ck)) continue;
    let best: { sf: SalesforceAccount; score: number } | null = null;
    for (const acct of data.salesforceAccounts) {
      const sc = chargebeeCbSfScore(sub, acct);
      if (sc != null && (!best || sc > best.score)) {
        best = { sf: acct, score: sc };
      }
    }
    if (best) {
      uf.union(ck, keySf(best.sf.account_id), best.score);
      matched.add(ck);
      matched.add(keySf(best.sf.account_id));
      pass2++;
    }
  }

  for (const [cid, row] of stripeByCustomer) {
    const sk = keyStripe(cid);
    if (matched.has(sk)) continue;
    let best: { sf: SalesforceAccount; score: number } | null = null;
    for (const acct of data.salesforceAccounts) {
      const sc = stripeSfNameScore(row.name, acct);
      if (sc != null && (!best || sc > best.score)) {
        best = { sf: acct, score: sc };
      }
    }
    if (best) {
      uf.union(sk, keySf(best.sf.account_id), best.score);
      matched.add(sk);
      matched.add(keySf(best.sf.account_id));
      pass2++;
    }
  }
  console.log(`[entity-resolution] Pass 2: ${pass2} matches`);

  // --- Pass 3: Legacy ALLCAPS + abbreviation map ---
  const abbrevMap = buildAbbreviationLookup(stripeByCustomer, data.chargebeeSubscriptions);
  let pass3 = 0;
  for (const inv of data.legacyInvoices) {
    const lk = keyLegacy(inv.id);
    if (matched.has(lk)) continue;
    const tokens = upperTokens(inv.customer_name);
    const candidates = new Map<string, TokenCandidate>();
    for (const tok of tokens) {
      const set = abbrevMap.get(tok);
      if (!set) continue;
      for (const c of set) {
        candidates.set(`${c.key}::${c.displayName}`, c);
      }
    }
    let best: { key: string; displayName: string; score: number } | null = null;
    for (const c of candidates.values()) {
      const score = jaccardNameSimilarity(inv.customer_name, c.displayName);
      if (score >= 0.7 && (!best || score > best.score)) {
        best = { key: c.key, displayName: c.displayName, score };
      }
    }
    if (best) {
      const conf = 0.7 + Math.min(0.2, (best.score - 0.7) * (0.2 / 0.3));
      uf.union(lk, best.key, conf);
      matched.add(lk);
      matched.add(best.key);
      pass3++;
    }
  }
  console.log(`[entity-resolution] Pass 3: ${pass3} matches`);

  // --- Pass 4: payment_ref join ---
  const paymentByPi = new Map<string, StripePayment>();
  for (const p of data.stripePayments) {
    paymentByPi.set(p.payment_id, p);
  }
  let pass4 = 0;
  for (const inv of data.legacyInvoices) {
    const lk = keyLegacy(inv.id);
    if (matched.has(lk)) continue;
    const ref = inv.payment_ref?.trim() ?? '';
    if (!ref.startsWith('pi_')) continue;
    const pay = paymentByPi.get(ref);
    if (!pay) continue;
    const sk = keyStripe(pay.customer_id);
    uf.union(lk, sk, 0.95);
    matched.add(lk);
    matched.add(sk);
    pass4++;
  }
  console.log(`[entity-resolution] Pass 4: ${pass4} matches`);

  // --- Pass 5: orphan / needs-review for unmatched billing & legacy ---
  const nameCorpus: { label: string; key: string }[] = [];
  for (const acct of data.salesforceAccounts) {
    nameCorpus.push({ label: acct.account_name, key: keySf(acct.account_id) });
  }
  for (const sub of data.chargebeeSubscriptions) {
    nameCorpus.push({ label: sub.customer.company, key: keyCb(sub.subscription_id) });
  }
  for (const [cid, row] of stripeByCustomer) {
    nameCorpus.push({ label: row.name, key: keyStripe(cid) });
  }

  function bestCorpusScoreForKey(bk: string, rawName: string): number {
    let best = 0;
    for (const { label, key } of nameCorpus) {
      if (key === bk) continue;
      best = Math.max(best, jaccardNameSimilarity(rawName, label));
    }
    return best;
  }

  const pass5ReviewKeys = new Set<string>();
  const reviewScoreByKey = new Map<string, number>();
  const orphanKeys = new Set<string>();
  let pass5Orphans = 0;

  const billingKeys: string[] = [];
  for (const s of data.chargebeeSubscriptions) billingKeys.push(keyCb(s.subscription_id));
  for (const cid of stripeByCustomer.keys()) billingKeys.push(keyStripe(cid));
  for (const inv of data.legacyInvoices) billingKeys.push(keyLegacy(inv.id));

  for (const bk of billingKeys) {
    if (matched.has(bk)) continue;
    const best = bestCorpusScoreForKey(
      bk,
      bk.startsWith('legacy:')
        ? (legacyById.get(bk.slice('legacy:'.length))?.customer_name ?? '')
        : bk.startsWith('chargebee:')
          ? (cbBySub.get(bk.slice('chargebee:'.length))?.customer.company ?? '')
          : (stripeByCustomer.get(bk.slice('stripe:'.length))?.name ?? ''),
    );
    if (best < 0.3) {
      pass5Orphans++;
      orphanKeys.add(bk);
      if (bk.startsWith('legacy:')) {
        const inv = legacyById.get(bk.slice('legacy:'.length))!;
        discrepancies.push(
          makeDiscrepancy({
            type: DiscrepancyType.ORPHAN_RECORD,
            severity: Severity.MEDIUM,
            sourceA: {
              system: DataSource.LEGACY_BILLING,
              recordId: inv.id,
              value: inv.customer_name,
            },
            sourceB: {
              system: 'unresolved',
              recordId: 'n/a',
              value: null,
            },
            customerName: inv.customer_name,
            amount: inv.amount,
            description: `Legacy invoice customer "${inv.customer_name}" could not be linked to any known billing or CRM entity (best score ${best.toFixed(2)}).`,
          }),
        );
      } else {
        const isCb = bk.startsWith('chargebee:');
        discrepancies.push(
          makeDiscrepancy({
            type: DiscrepancyType.ORPHAN_RECORD,
            severity: Severity.MEDIUM,
            sourceA: {
              system: isCb ? DataSource.CHARGEBEE : DataSource.STRIPE,
              recordId: bk.split(':')[1] ?? bk,
              value: bk,
            },
            sourceB: {
              system: 'unresolved',
              recordId: 'n/a',
              value: null,
            },
            customerName: isCb
              ? (cbBySub.get(bk.slice('chargebee:'.length))?.customer.company ?? '')
              : (stripeByCustomer.get(bk.slice('stripe:'.length))?.name ?? ''),
            amount: null,
            description: `Billing record ${bk} had no strong entity-resolution match (best score ${best.toFixed(2)}).`,
          }),
        );
      }
    } else if (best < 0.8) {
      pass5ReviewKeys.add(bk);
      reviewScoreByKey.set(bk, best);
    }
  }
  console.log(
    `[entity-resolution] Pass 5: ${pass5Orphans} orphan discrepancies, ${pass5ReviewKeys.size} records flagged for review`,
  );

  // Build clusters: every key maps to root
  const clusterMembers = new Map<string, Set<string>>();
  for (const k of allKeys) {
    const r = uf.find(k);
    let set = clusterMembers.get(r);
    if (!set) {
      set = new Set();
      clusterMembers.set(r, set);
    }
    set.add(k);
  }

  const customers: UnifiedCustomer[] = [];
  const emittedRoots = new Set<string>();

  function gatherClusterData(memberKeys: Set<string>): {
    sf: SalesforceAccount | null;
    subs: ChargebeeSubscription[];
    stripeIds: string[];
    legacies: LegacyInvoice[];
    aliases: Set<string>;
    sources: Set<DataSource>;
    dates: number[];
    sfIds: Set<string>;
  } {
    const subs: ChargebeeSubscription[] = [];
    const stripeIds: string[] = [];
    const legacies: LegacyInvoice[] = [];
    const aliases = new Set<string>();
    const sources = new Set<DataSource>();
    const dates: number[] = [];
    const sfIds = new Set<string>();
    let sf: SalesforceAccount | null = null;

    for (const k of memberKeys) {
      if (k.startsWith('salesforce:')) {
        const id = k.slice('salesforce:'.length);
        const acct = sfById.get(id)!;
        sf = acct;
        sfIds.add(id);
        aliases.add(acct.account_name);
        sources.add(DataSource.SALESFORCE);
        dates.push(parseTime(acct.created_date));
      } else if (k.startsWith('chargebee:')) {
        const sub = cbBySub.get(k.slice('chargebee:'.length))!;
        subs.push(sub);
        aliases.add(sub.customer.company);
        if (sub.customer.first_name || sub.customer.last_name) {
          aliases.add(`${sub.customer.first_name} ${sub.customer.last_name}`.trim());
        }
        sources.add(DataSource.CHARGEBEE);
        dates.push(parseTime(sub.created_at), parseTime(sub.current_term_start), parseTime(sub.current_term_end));
      } else if (k.startsWith('stripe:')) {
        const cid = k.slice('stripe:'.length);
        stripeIds.push(cid);
        const row = stripeByCustomer.get(cid)!;
        aliases.add(row.name);
        sources.add(DataSource.STRIPE);
        for (const p of row.payments) {
          dates.push(parseTime(p.payment_date));
        }
      } else if (k.startsWith('legacy:')) {
        const inv = legacyById.get(k.slice('legacy:'.length))!;
        legacies.push(inv);
        aliases.add(inv.customer_name);
        sources.add(DataSource.LEGACY_BILLING);
        dates.push(parseTime(inv.date));
      }
    }
    return { sf, subs, stripeIds, legacies, aliases, sources, dates, sfIds };
  }

  function latestNpsForAccounts(sfAccountIds: Set<string>): number | null {
    let best: NPSSurvey | null = null;
    for (const n of data.npsSurveys) {
      if (!sfAccountIds.has(n.account_id)) continue;
      if (!best || parseTime(n.survey_date) > parseTime(best.survey_date)) best = n;
    }
    return best?.score ?? null;
  }

  function openTicketsForAccounts(sfAccountIds: Set<string>): number {
    let c = 0;
    for (const t of data.supportTickets) {
      if (sfAccountIds.has(t.account_id) && t.status === 'open') c++;
    }
    return c;
  }

  function productEventDates(sfAccountIds: Set<string>): number[] {
    const out: number[] = [];
    for (const e of data.productEvents) {
      if (sfAccountIds.has(e.account_id)) out.push(parseTime(e.timestamp));
    }
    return out;
  }

  for (const [root, members] of clusterMembers) {
    if (emittedRoots.has(root)) continue;
    emittedRoots.add(root);

    const memberList = [...members];
    if (memberList.length === 1 && orphanKeys.has(memberList[0]!)) {
      continue;
    }

    const g = gatherClusterData(members);

    const companyName = g.sf
      ? g.sf.account_name
      : g.subs[0]
        ? g.subs[0].customer.company
        : g.stripeIds[0]
          ? stripeByCustomer.get(g.stripeIds[0])!.name
          : g.legacies[0]?.customer_name ?? 'Unknown';

    let matchConf = uf.getClusterConfidence(root);
    if (memberList.length === 1) {
      const only = memberList[0]!;
      const rs = reviewScoreByKey.get(only);
      if (rs != null) matchConf = rs;
    } else {
      for (const m of memberList) {
        const rs = reviewScoreByKey.get(m);
        if (rs != null) matchConf = Math.min(matchConf, rs);
      }
    }

    const needsReview =
      (matchConf >= 0.3 && matchConf <= 0.79) || memberList.some((m) => pass5ReviewKeys.has(m));

    const activeCb = g.subs.filter((s) => s.status === 'active' || s.status === 'in_trial' || s.status === 'future');
    const hasActiveCb = activeCb.some((s) => s.status === 'active' || s.status === 'in_trial');
    const now = Date.now();
    let stripeRecent = false;
    let stripeSucceededTotal = 0;
    for (const cid of g.stripeIds) {
      const row = stripeByCustomer.get(cid)!;
      for (const p of row.payments) {
        if (p.status === 'succeeded') {
          stripeSucceededTotal += p.amount;
          if (now - parseTime(p.payment_date) <= MS_90_DAYS) stripeRecent = true;
        }
      }
    }

    let billing: UnifiedCustomer['billing_system'] = DataSource.LEGACY_BILLING;
    if (hasActiveCb) billing = DataSource.CHARGEBEE;
    else if (stripeRecent || (g.stripeIds.length > 0 && stripeSucceededTotal > 0)) billing = DataSource.STRIPE;
    else if (g.legacies.length > 0) billing = DataSource.LEGACY_BILLING;

    let mrrUsd = 0;
    if (g.subs.length) {
      mrrUsd = g.subs.reduce((sum, s) => sum + s.mrr, 0);
    } else if (g.stripeIds.length) {
      mrrUsd = stripeSucceededTotal / 12;
    }

    let plan = 'unknown';
    if (g.subs.length) {
      plan = g.subs.map((s) => s.plan.plan_name).join(', ');
    }

    let status: UnifiedCustomer['status'] = 'active';
    if (g.subs.length) {
      const hasTrial = g.subs.some((s) => s.status === 'in_trial');
      const hasPaused = g.subs.some((s) => s.status === 'paused');
      const allChurned = g.subs.every((s) => s.status === 'cancelled' || s.status === 'non_renewing');
      if (hasTrial) status = 'trial';
      else if (hasPaused) status = 'paused';
      else if (allChurned && !stripeRecent) status = 'churned';
      else status = 'active';
    } else if (g.stripeIds.length) {
      status = stripeRecent ? 'active' : 'churned';
    } else if (g.legacies.length) {
      status = 'active';
    }

    let segment: UnifiedCustomer['segment'] = g.sf?.segment ?? 'smb';
    if (!g.sf && g.subs.length) {
      segment = deriveSegmentFromPlan(g.subs[0]!.plan.plan_name);
    }

    const allDates = [...g.dates, ...productEventDates(g.sfIds)];
    const firstSeenTs = allDates.length ? Math.min(...allDates.filter((t) => t > 0)) : 0;
    const lastActTs = allDates.length ? Math.max(...allDates) : 0;
    const firstSeen = firstSeenTs > 0 ? new Date(firstSeenTs).toISOString() : new Date(0).toISOString();
    const lastActivity = lastActTs > 0 ? new Date(lastActTs).toISOString() : new Date(0).toISOString();

    const stripeCustomerId = g.stripeIds[0] ?? null;
    const chargebeeCustomerId = g.subs[0]?.customer.customer_id ?? null;
    const salesforceAccountId = g.sf?.account_id ?? [...g.sfIds][0] ?? null;
    const legacyInvoiceId = g.legacies[0]?.id ?? null;

    const customer: UnifiedCustomer = {
      unified_id: randomUUID(),
      company_name: companyName,
      aliases: [...g.aliases].filter(Boolean),
      external_ids: {
        stripe_customer_id: stripeCustomerId,
        chargebee_customer_id: chargebeeCustomerId,
        salesforce_account_id: salesforceAccountId,
        legacy_invoice_id: legacyInvoiceId,
      },
      segment,
      country: g.sf?.billing_country ?? '',
      industry: g.sf?.industry ?? '',
      billing_system: billing,
      mrr_usd: mrrUsd,
      arr_usd: mrrUsd * 12,
      plan,
      status,
      first_seen: firstSeen,
      last_activity: lastActivity,
      nps_score: latestNpsForAccounts(g.sfIds),
      open_tickets: openTicketsForAccounts(g.sfIds),
      usage_score: 0,
      match_confidence: matchConf,
      needs_review: needsReview,
      data_sources: [...g.sources],
    };
    customers.push(customer);
  }

  return { customers, discrepancies };
}

# Architecture Document

## System Overview

The system is a data reconciliation pipeline with an audit-first constraint. Every architectural
decision flows from a single requirement: every number on the dashboard must be traceable back to
a source record.

```
Raw Data Files (data/)
       │
       ▼
┌─────────────────────────────────────┐
│  Ingestion Layer (packages/data-engine/src/ingestion/)   │  Parse + validate + normalize each source
│  Stripe, Chargebee, Legacy, SF...   │  Zod schemas enforce types at the boundary
└─────────────────────────────────────┘
       │ Normalized typed records
       ▼
┌─────────────────────────────────────┐
│  Reconciliation Layer               │  Entity resolution, dedup, revenue matching
│  (packages/data-engine/src/reconciliation/)              │  Every discrepancy gets an audit record
└─────────────────────────────────────┘
       │ UnifiedCustomer[] + Discrepancy[]
       ▼
┌─────────────────────────────────────┐
│  Metrics Layer (packages/data-engine/src/metrics/)       │  ARR, NRR, Churn, Unit Economics, Cohorts
│                                     │  Each metric carries its source lineage
└─────────────────────────────────────┘
       │ Metric results with lineage
       ▼
┌─────────────────────────────────────┐
│  API Layer (packages/data-engine/src/routes/)            │  Express routes, filter params, no logic
│  Health + Scenarios                 │  I/O only — no business logic here
└─────────────────────────────────────┘
       │ JSON over HTTP (port 3001)
       ▼
┌─────────────────────────────────────┐
│  Dashboard (packages/dashboard/)    │  React + TanStack Query + Recharts
│  port 5173                          │  8 routes covering all metric views
└─────────────────────────────────────┘
```

### Data Loading Strategy

Data is loaded **eagerly at startup** into module-level state — one load per process lifetime.
This is correct for a monthly-rerun model where the process is restarted each run. It avoids
per-request file I/O with no meaningful downside given the data size.

Exception: `product_events.jsonl` is 19.8 MB. It is parsed in a streaming fashion during the
initial load to avoid a single large heap allocation, then stored as a typed array. All
downstream usage is read-only over the in-memory array.

### Execution Priority (Tests Drive Order)

The failing test suite defines the implementation priority — not the CFO's list:

```
1. Revenue reconciliation tests  (revenue.test.ts)     → packages/data-engine/src/reconciliation/revenue.ts
2. Entity matching tests         (matchers.test.ts)     → packages/data-engine/src/reconciliation/matcher.ts
3. Deduplication tests           (deduplication.test.ts)→ packages/data-engine/src/reconciliation/deduplication.ts
4. All ingestion parsers         (no tests, but foundation for above)
5. Metrics (ARR, NRR, Churn, Unit Economics, Cohorts)
6. Health scoring
7. Pipeline quality analysis
8. API routes wired up
9. Scenario engine  ← last, it is ~30 lines of math, no test coverage
10. Docs (ASSUMPTIONS.md, ARCHITECTURE.md)
```

---

## Data Model

### Unified Customer Model

The canonical identifier is `unified_id` — a synthetic UUID generated during entity resolution.
It is not sourced from any external system. External system IDs are stored in a keyed map on
`UnifiedCustomer.externalIds`:

```
UnifiedCustomer {
  unified_id: string          // synthetic, generated here
  externalIds: {
    stripe?: string           // cus_xxxxx
    chargebee?: string        // sub_cb_xxxxx
    salesforce?: string       // SF account ID
    legacy?: string           // INV-xxxxx prefix customer
  }
  match_confidence: number    // lowest confidence score in the match chain
  mrr_usd: number             // normalized to USD at transaction date FX rate
  arr_usd: number             // mrr_usd × 12 for monthly billing
}
```

Every `UnifiedCustomer` carries the IDs of all source records that contributed to it, enabling
the audit trail to trace any metric back to raw rows.

### Source Data Mapping

| Source | Key Fields | Links To | Issues Found |
|--------|-----------|----------|-------------|
| Stripe Payments | payment_id, customer_id, amount (cents), currency, payment_date, subscription_id | UnifiedCustomer via customer_id | Amounts in cents (integer), not dollars. Failed payments present — exclude from revenue, include as churn signal. No direct link to Chargebee or legacy. |
| Chargebee Subscriptions | subscription_id, customer.id, plan.id, plan_changes[], coupons[] | UnifiedCustomer via customer.id; plan_pricing_history via plan.id | plan_changes array contains proration data — this is where upgrade/downgrade prorations must be read, not inferred. |
| Legacy Invoices | invoice_id, customer_name (ALLCAPS), amount, date (DD/MM/YYYY), payment_ref | UnifiedCustomer via payment_ref (some contain Stripe payment IDs); name fuzzy match otherwise | ALLCAPS abbreviated names (PIXELWAVE, ACADEMIQ) — cannot be fuzzy-matched to Stripe/Chargebee without normalization. Date format is ambiguous for day ≤ 12. No machine-readable customer ID. FX data starts July 2023; legacy invoices start January 2023 — 6-month gap. |
| Salesforce Opportunities | opportunity_id, account_id, amount (TCV), ACV, contract_term_months, stage | SalesforceAccount via account_id | Amount field is Total Contract Value, not ARR. Must divide by contract_term_months × 12 to get ARR contribution. All sample rows are "Closed Won" — zombie deal detection requires looking at stage + last_activity_date. |
| Salesforce Accounts | account_id, stripe_customer_id, chargebee_customer_id | UnifiedCustomer (this is the primary bridge table) | stripe_customer_id and chargebee_customer_id act as the primary cross-system link. Entity resolution should start here before any fuzzy matching. |
| Product Events | account_id, event_type, feature, timestamp | UnifiedCustomer via account_id | 19.8 MB JSONL. Load streaming. Only used for health scoring signals (DAU/MAU, feature breadth, trend). |
| Support Tickets | ticket_id, account_id, priority, status, satisfaction_rating | UnifiedCustomer via account_id | satisfaction_rating is a health signal. Open high-priority tickets are a churn predictor. |
| NPS Surveys | survey_id, account_id, score (0-10), category | UnifiedCustomer via account_id | Recency matters — a 6-month-old promoter response is weaker signal than a recent detractor. Apply recency decay. |
| Marketing Spend | channel, period, spend, signups, conversions | Contributes to CAC calculation only | Multi-touch attribution is described as "messy" in CFO brief. Use last-touch as default, document as assumption. |
| Plan Pricing | plan_id, price_usd_monthly, effective_date, end_date, billing_model | Chargebee subscriptions via plan_id | No "Meridian" plan exists here — CFO brief references it as a tier. Likely a customer name (Meridian Health) conflated as a tier. Flag as data contradiction. |
| FX Rates | date, eur_usd, gbp_usd, jpy_usd, aud_usd | Applied at ingestion time to normalize all amounts to USD | Coverage starts July 2023. Legacy invoices start January 2023. For pre-July 2023 foreign currency records, use the earliest available rate (July 1 2023) and flag with `fxRateApproximated: true`. |
| Partner Deals | deal_id, commission_rate (15–30%), status, deal_type | UnifiedCustomer; affects ARR (net of commission) and NRR | Commission rate varies per deal. ARR must be net of commission for partner-sourced accounts. |

---

## Matching Strategy

### Entity Resolution Approach

Entity resolution runs in passes. Each pass assigns a confidence score. A record matched in an
earlier pass is not re-evaluated by later passes.

**Pass 1 — Structured ID bridge (confidence: 1.0)**
Use `salesforce_accounts.stripe_customer_id` and `salesforce_accounts.chargebee_customer_id` as
the primary cross-system link. Salesforce is the CRM of record and was designed to hold these
foreign keys. This is the only zero-ambiguity path.

**Pass 2 — Email domain + normalized company name (confidence: 0.85–0.95)**
Normalize: lowercase, strip legal suffixes (Inc, LLC, Corp, Ltd, GmbH, BV), strip punctuation.
Match on exact normalized name + matching email domain. Handles "Acme Corp" vs "ACME Corporation."
Does NOT handle legacy ALLCAPS abbreviated names (separate pass needed).

**Pass 3 — Legacy ALLCAPS normalization (confidence: 0.70–0.90)**
Legacy names are uppercase and abbreviated. Apply a dedicated normalization step:
- Expand known abbreviations against a lookup table built from data exploration
- Match normalized legacy name against normalized Stripe/Chargebee names using Fuse.js
- Any match below 0.70 is flagged as `MISSING_ACCOUNT` discrepancy, not silently dropped

**Pass 4 — Fuzzy match on payment reference (confidence: 0.95)**
Some legacy invoices contain a Stripe payment_id in the `payment_ref` field (e.g., `pi_8c64dd40e6c55a`).
A direct join on this field produces a near-certain match regardless of name format.

**Pass 5 — Orphan flagging**
Any record that reaches this pass without a match becomes an `ORPHAN_RECORD` discrepancy with
severity based on its revenue value.

### Confidence Scoring

The test suite (`matchers.test.ts`) defines the boundary conditions:
- Same company, variant names + same domain → must score `> 0.8`
- Different companies, different domains → must score `< 0.3`

Behavior by confidence band:

| Band | Action |
|------|--------|
| ≥ 0.80 | Auto-match, included in UnifiedCustomer |
| 0.30 – 0.79 | Flag as `needsReview: true`, included with warning in reconciliation output |
| < 0.30 | Rejected as match, flagged as ORPHAN_RECORD discrepancy |

The 0.30–0.79 band is explicitly undefined by the tests. Surfacing it as "needs review" rather
than auto-accepting or auto-rejecting is the conservative and auditor-safe choice.

---

## Metric Definitions

### ARR (Annual Recurring Revenue)

**Definition:** The annualized value of all active recurring subscriptions as of the measurement
date, net of partner commissions, in USD at the measurement date's FX rate. Excludes one-time
fees, prorations, trial periods, and failed payments.

**Formula:**
```
ARR = Σ (active_subscription.mrr_usd × 12) - Σ (partner_deal.commission_rate × arr_contribution)
```

Where `mrr_usd` is:
- For monthly billing: `plan_price_usd` (at the effective date from plan_pricing_history)
- For annual billing: `annual_price_usd / 12`
- For multi-year deals with escalators: amortized using the escalator schedule, not flat annual / term

**Edge cases:**
- Multi-year upfront payments: recognize monthly, not as lump sum. Use contract_term_months from
  Salesforce opportunity and the escalator schedule if present.
- Trials ($0 MRR): excluded entirely until converted.
- Duplicate accounts (Stripe + Chargebee active simultaneously): count once only (the
  deduplication pass resolves which record is canonical).
- Failed Stripe payments: exclude from ARR (the subscription may still be active; this is a
  billing health signal, not a revenue event).
- Chargebee `plan_changes[]`: use the current plan at measurement date, not the plan at creation.

**Known contradiction:** CFO brief requests ARR by tier including "Meridian" — no Meridian plan
exists in plan_pricing_history.csv. "Meridian Health" is a customer name. Resolution: report ARR
by the four actual tiers (Starter, Growth, Scale, Enterprise) and note the discrepancy. Do not
invent a Meridian tier.

### NRR (Net Revenue Retention)

**Definition:** The percentage of ARR retained from an existing customer cohort over a 12-month
period, including expansion, contraction, and churn. Excludes new logo ARR.

**Formula:**
```
NRR = (ARR_end - ARR_new_logos) / ARR_start × 100
    = (ARR_start + Expansion - Contraction - Churn) / ARR_start × 100
```

**Edge cases:**
- Partner deals: use net-of-commission ARR in both numerator and denominator for consistency.
- Currency: normalize all to USD at the period-end FX rate (or period-start — must be consistent;
  document whichever is chosen).
- CFO brief says "quarterly NRR" but trailing 12-month is the industry standard. Provide both.
  The trailing 12-month is the primary figure; quarterly is supplementary.

### Gross Churn / Net Churn

**Gross Churn:**
```
Gross Logo Churn Rate = churned_customers / starting_customers × 100
Gross Revenue Churn Rate = churned_ARR / starting_ARR × 100
```

**Net Churn:**
```
Net Revenue Churn Rate = (churned_ARR - expansion_ARR) / starting_ARR × 100
```

**Edge cases:**
- A customer who cancels and re-signs in the same period: counts as churn + new logo, not
  expansion. This prevents masking churn with re-sign ARR.
- Contraction (downgrade): counted separately from churn, not conflated.
- CFO brief flags >3% monthly churn as a threshold — this is gross revenue churn rate.

### Unit Economics (CAC, LTV, Payback)

**CAC:**
```
CAC = total_sales_marketing_spend / new_customers_acquired
```

Marketing spend from `marketing_spend.csv`. Attribution: last-touch by default (see Assumptions).

**Headcount ambiguity:** CFO brief provides two headcount figures (823 and 847). Use 823 as
the baseline (lower number = more conservative CAC), document as assumption, flag for CFO
clarification.

**LTV:**
```
LTV = ARPA / gross_churn_rate × gross_margin
```

Gross margin by segment (from CFO brief):
- Growth / Enterprise: 78%
- Starter: 65%
- Scale: not specified — use Growth margin (78%) as proxy, document assumption

**Payback Period:**
```
Payback = CAC / (ARPA × gross_margin)  [in months]
```

Target from CFO brief: < 18 months.

**Edge cases:**
- Partner-sourced customers: CAC includes partner commission paid, not just internal S&M spend.
- Multi-touch attribution: Marketing data is acknowledged as "messy." Last-touch is documented
  as the default. The audit trail must make this visible.

---

## Known Limitations

1. **FX gap for pre-July 2023 foreign currency records:** Legacy invoices in EUR or GBP before
   July 2023 use the earliest available rate. Revenue for this period may be slightly
   misrepresented.

2. **Legacy ALLCAPS name matching:** Without a complete abbreviation lookup table derived from
   data exploration, some legacy accounts may remain as ORPHAN_RECORD discrepancies. These are
   surfaced explicitly, not silently dropped.

3. **"Meridian" plan tier:** Does not exist in the source data. The CFO brief contains a
   contradiction. Reported as a data quality finding.

4. **Marketing attribution:** Last-touch is a simplification. Multi-touch would require session-
   level event data not present in marketing_spend.csv.

5. **Headcount for CAC:** Two figures provided (823, 847). Using 823 pending clarification.

6. **Scenario engine:** Purely formulaic (no ML). Assumes constant churn and expansion rates
   within each month of projection. Sufficient for board planning; not suitable for
   month-level operational decisions.

7. **Health scoring confidence:** Configurable signal weights default to the values in
   `HealthScoringOptions`. No backtesting was done against actual churn outcomes to validate
   weight selection. Weights should be calibrated once historical churn data is confirmed clean.

---

## Future Extensibility

**Adding a new billing source (e.g., Paddle):**
1. Add a `PaddleSubscription` interface to `packages/data-engine/src/ingestion/types.ts`
2. Create `packages/data-engine/src/ingestion/paddle.ts` implementing the same normalized output shape
3. Add `DataSource.paddle` to the enum
4. Add a Pass in entity resolution if Paddle customer IDs appear in Salesforce accounts
5. Add a `paddle` entry to the source data mapping table in this document

**Adding a new metric:**
1. Define the result type in `packages/data-engine/src/metrics/types.ts`
2. Implement in `packages/data-engine/src/metrics/<metric>.ts`
3. Add a route in `packages/data-engine/src/routes/metrics.ts`
4. Add the API call in `packages/dashboard/src/api/client.ts`
5. Document definition and edge cases in this file

**Changing reconciliation schedule from monthly to weekly:**
The ingestion layer reads from flat files — changing the schedule requires only that the source
files are refreshed weekly. The pipeline itself has no hard monthly dependency. The `processedAt`
timestamp in `ReconciliationResult.metadata` records the run time for the audit trail.

**Adding a new segmentation dimension:**
1. Add the dimension field to `UnifiedCustomer`
2. Add it to `MetricOptions.segmentation`
3. Each metric calculator iterates `segmentation` options to group results — extend the groupBy
   logic in each metric file
4. Add a filter control in the dashboard `useFilters` hook

---

## Implementation Map

| Architecture Layer | Module Path | Responsibility |
|---|---|---|
| Data Ingestion | `packages/data-engine/src/ingestion/` | CSV, JSON, XML, JSONL loaders with Zod validation |
| Data Bootstrap | `packages/data-engine/src/data/bootstrap.ts` | `loadAllDatasets()` — eager load all 12 data sources |
| Data Singleton | `packages/data-engine/src/data/singleton.ts` | `getData()` — cached singleton for server lifetime |
| Entity Resolution | `packages/data-engine/src/reconciliation/entity-resolution.ts` | Five-pass matcher producing `UnifiedCustomer[]` |
| Revenue Reconciliation | `packages/data-engine/src/reconciliation/revenue.ts` | Expected vs actual revenue with 2% threshold |
| Duplicate Detection | `packages/data-engine/src/reconciliation/deduplication.ts` | Stripe/Chargebee overlap detection + classification |
| Pipeline Quality | `packages/data-engine/src/reconciliation/pipeline.ts` | Zombie deals, stage mismatches, unbooked revenue |
| ARR Metrics | `packages/data-engine/src/metrics/arr.ts` | Annual recurring revenue with segment breakdowns |
| NRR Metrics | `packages/data-engine/src/metrics/nrr.ts` | Net revenue retention with period-end FX |
| Churn Metrics | `packages/data-engine/src/metrics/churn.ts` | Gross/net/logo churn with >3% threshold flag |
| Unit Economics | `packages/data-engine/src/metrics/unit-economics.ts` | CAC, LTV, payback with 18-month target |
| Cohort Analysis | `packages/data-engine/src/metrics/cohorts.ts` | Revenue and logo retention by signup month |
| Health Scoring | `packages/data-engine/src/health/scorer.ts` | Multi-signal model with NPS 180-day decay |
| Scenario Engine | `packages/data-engine/src/scenarios/engine.ts` | 12-month what-if projection with impact breakdown |
| FX Conversion | `packages/data-engine/src/utils/fx.ts` | `convertToUSD()` with earliest-rate fallback |
| Date Parsing | `packages/data-engine/src/utils/date-parser.ts` | Ambiguous DD/MM vs MM/DD with neighbor voting |
| Name Normalization | `packages/data-engine/src/utils/normalization.ts` | Legal suffix stripping, amount normalization |
| Audit Store | `packages/data-engine/src/audit/store.ts` | In-memory append-only audit log |
| API Layer | `packages/data-engine/src/routes/` | Express REST endpoints for all services |
| Dashboard | `packages/dashboard/src/` | React + TanStack Query consuming API |

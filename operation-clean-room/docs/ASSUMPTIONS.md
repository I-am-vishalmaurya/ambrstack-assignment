# Assumptions Log

Every decision made about ambiguous data, unclear requirements, or edge case handling is logged
here. This document is as important as the code.

Each assumption includes: the decision, the evidence or rationale, the impact if wrong, and the
date it was made.

---

## Data Interpretation

| # | Assumption | Rationale | Impact if Wrong | Date |
|---|-----------|-----------|----------------|------|
| 1 | Legacy invoice dates use DD/MM/YYYY format throughout | CFO brief explicitly states "the legacy system uses DD/MM/YYYY." This overrides any heuristic. | Revenue attribution by month could shift for invoices where day ≤ 12 (ambiguous dates). At most ~30% of legacy invoices are affected. | 2026-04-15 |
| 2 | Legacy ALLCAPS customer names (e.g., PIXELWAVE, ACADEMIQ) are abbreviated forms of the legal entity names in Stripe/Chargebee | The legacy system predates the acquisition and used a different data entry convention. No shared customer ID exists between legacy and other systems (except where payment_ref contains a Stripe ID). | Some legacy accounts may not be matched and will appear as ORPHAN_RECORD discrepancies. Revenue attributed to them cannot be reconciled. | 2026-04-15 |
| 3 | For legacy invoices with a Stripe payment_id in the payment_ref field, that ID is a direct match to the corresponding Stripe payment record | The acquired company's system cross-referenced Stripe payments at the time of invoicing. This is the highest-confidence link available for legacy records. | If payment_ref is unreliable (e.g., copy-paste errors in the legacy system), some links will be incorrect. Impact: revenue double-counted for that customer. | 2026-04-15 |
| 4 | FX rates before July 2023 are not available in fx_rates.csv. For foreign currency (EUR, GBP) legacy invoices dated January–June 2023, the earliest available rate (July 1 2023) is used. | fx_rates.csv coverage starts July 2023. Legacy invoices start January 2023. No alternative source is available. | Revenue for this 6-month period in non-USD currencies may be slightly misrepresented. Estimate: < 2% of total revenue given the legacy system's volume. Flagged with `fxRateApproximated: true` on affected records. | 2026-04-15 |
| 5 | Stripe payment amounts are in cents (integer), not dollars | Stripe's standard API response uses smallest currency unit. Confirmed by inspecting raw data: value of 63 for a Starter plan ($0.63 would be invalid; $63 is the Starter price). Division by 100 applied at ingestion. | If any amounts are already in dollars, they will be inflated by 100×. Cross-check against plan_pricing_history during ingestion validation. | 2026-04-15 |
| 6 | Product events (product_events.jsonl) use account_id values that correspond to UnifiedCustomer.externalIds.salesforce or chargebee | No explicit key mapping documented in the data schema. Inferred from field name convention. | Health scores cannot be computed for accounts where the ID does not resolve. Those accounts will have `productUsage` signal marked as unavailable. | 2026-04-15 |

---

## Metric Definitions

| # | Assumption | Rationale | Impact if Wrong | Date |
|---|-----------|-----------|----------------|------|
| 1 | NRR is calculated on a trailing 12-month basis as the primary figure; quarterly NRR is provided as a supplementary figure | Trailing 12-month is the SaaS industry standard and what investors/auditors expect. CFO brief says "quarterly" without specifying the method — interpreted as "segment by quarter" not "use a quarterly window." | If CFO meant a rolling 90-day window, NRR will appear higher (less volatility smoothing). Board comparison to industry benchmarks would be misleading. | 2026-04-15 |
| 2 | ARR excludes one-time fees, prorations, trial periods, and failed payments | Standard ARR definition: only annualized recurring contract value. One-time fees are non-recurring by definition. Prorations are timing adjustments, not new ARR. Trials have not converted. Failed payments indicate the revenue was not collected. | Overstated ARR if these are included (which is what the former VP was accused of doing). Conservative exclusion is the defensible position for auditors. | 2026-04-15 |
| 3 | Multi-year deal ARR is recognized monthly using the annual contract value divided by 12, adjusted for any escalator schedule | Upfront recognition of multi-year TCV overstates ARR (this was one of the specific errors cited in the CFO brief). Escalators must be applied in the year they take effect, not averaged. | ARR overstated in early years of the contract, understated in later years. The total remains correct but the trend line is wrong. | 2026-04-15 |
| 4 | For the "Meridian" plan tier referenced in the CFO brief: no such plan exists in plan_pricing_history.csv. "Meridian Health" is a customer name, not a plan. ARR is reported by the four actual plan tiers: Starter, Growth, Scale, Enterprise | Direct inspection of plan_pricing_history.csv. No Meridian plan ID found. Chargebee data contains a customer named "Meridian Health" on an Enterprise plan. The CFO brief appears to contain an error. | If Meridian was a real plan from the legacy system (pre-acquisition, not in pricing history), accounts on it would be misclassified as their closest plan equivalent. Flagged as a data quality finding requiring CFO clarification. | 2026-04-15 |
| 5 | Gross margin by segment: Growth/Enterprise = 78%, Starter = 65%, Scale = 78% (proxy) | Growth and Enterprise margins explicitly stated in CFO brief. Scale margin not specified — using Growth margin as proxy since Scale sits between Growth and Enterprise in the plan hierarchy. | LTV for Scale customers could be over- or under-estimated. Scale revenue share of total should be checked — if Scale is a large segment, this assumption carries significant weight. | 2026-04-15 |
| 6 | Headcount used for CAC calculation: 823 (not 847) | CFO brief provides two figures (823/847) without specifying which is current or correct. 823 is the more conservative choice (higher denominator = lower implied per-head efficiency, harder to game). | If 847 is the current headcount, CAC is calculated on a slightly inflated base. Difference is ~3%, within noise for a planning figure. Flagged for CFO clarification. | 2026-04-15 |

---

## Business Logic

| # | Assumption | Rationale | Impact if Wrong | Date |
|---|-----------|-----------|----------------|------|
| 1 | A Stripe and Chargebee record for the same customer with overlapping active subscription dates are classified as `true_duplicate` | Defined by deduplication.test.ts expectations. A single customer should not have two active billing records simultaneously — one system should have been deactivated during migration. | If multi-system billing is intentional (e.g., different products billed separately), these will be incorrectly flagged. Revenue would appear double-counted in reconciliation. | 2026-04-15 |
| 2 | A Stripe subscription ending in month N and a Chargebee subscription starting in month N+1 for the same customer is classified as `migration`, not `true_duplicate` | Defined by deduplication.test.ts. A clean cutover with a gap indicates deliberate system migration, not accidental duplication. | If the gap was caused by a missed billing cycle (not a migration), revenue for the gap period would be underreported. | 2026-04-15 |
| 3 | Partner deal ARR is reported net of commission (i.e., ARR = subscription_value × (1 - commission_rate)) | Channel partners earn 15–30% commission. The company's recognizable revenue is net. Gross ARR inflates the number by the commission amount. | If the CFO wants gross ARR with commission as a line-item expense, the ARR figure will appear lower than expected. Clarify with CFO — both gross and net are provided, with net as the primary figure. | 2026-04-15 |
| 4 | Marketing attribution uses last-touch model | Marketing spend data (`marketing_spend.csv`) provides channel-level spend and conversions but no session-level event data for multi-touch reconstruction. Last-touch is the only model supportable with available data. | CAC by channel will over-attribute to conversion-proximate channels (e.g., branded search) and under-attribute to top-of-funnel channels (e.g., content). | 2026-04-15 |
| 5 | A Salesforce opportunity is classified as a "zombie deal" if last_activity_date is more than 6 months before the current run date and the stage is not Closed Won or Closed Lost | CFO brief specifies "6+ months no activity." Stage filter prevents flagging recently-closed deals with no ongoing activity. | If the 6-month threshold is wrong (e.g., CFO meant 90 days for enterprise deals), fewer/more zombies will be flagged. The threshold is configurable in the pipeline code. | 2026-04-15 |
| 6 | A customer who cancels and re-signs in the same measurement period is counted as churn + new logo, not as expansion or retention | Prevents masking churn with re-sign ARR. A cancel-and-resign is a real retention failure even if revenue is recovered. Consistent with how investors interpret churn. | If the CFO wants re-signs excluded from churn (net view), gross churn will appear elevated. Both perspectives are documented in the output. | 2026-04-15 |

---

## Exclusions & Edge Cases

| # | Assumption | Rationale | Impact if Wrong | Date |
|---|-----------|-----------|----------------|------|
| 1 | Trial accounts with $0 MRR are excluded from ARR calculation | Trials have not converted. Including them overstates ARR (a specific accusation in the CFO brief against the former VP). | Understates pipeline if some trials are in final negotiation. Pipeline value is reported separately via Salesforce opportunities, not ARR. | 2026-04-15 |
| 2 | Failed Stripe payments are excluded from revenue but included as a billing health signal in customer health scoring | A failed payment means cash was not collected. Including it in revenue would be inaccurate. However, it is a meaningful churn predictor and belongs in the health model. | If some failed payments were later retried and succeeded, and the retry appears as a separate payment record, the successful retry is counted and the failed attempt is ignored — correct behavior. | 2026-04-15 |
| 3 | Refunded Stripe payments (refund_id present) are excluded from revenue | A refund means the revenue was returned to the customer. Including refunded payments overstates revenue. | If partial refunds exist (not visible in the sample), only the refunded portion should be excluded. Assumption: refund_id present = full refund. Partial refunds are treated as full refunds pending data confirmation. | 2026-04-15 |
| 4 | Entity resolution confidence scores below 0.30 result in ORPHAN_RECORD discrepancy — the record is not silently dropped | Auditors need to see every unmatched record. Silent drops create gaps in the audit trail that cannot be explained. Surfacing orphans as discrepancies forces resolution. | Orphan list may be noisy if the threshold is too high. 0.30 is the floor defined by the test suite. Threshold is configurable. | 2026-04-15 |
| 5 | Revenue discrepancies below 2% between systems are logged but not flagged as errors | CFO brief specifies the 2% threshold explicitly. Sub-threshold differences are likely FX rounding, proration timing, or day-count conventions between systems. | If the CFO meant 2% as an absolute dollar threshold (not percentage), small-MRR accounts with large dollar discrepancies would be missed. Interpretation: percentage, as stated in the brief. | 2026-04-15 |
| 6 | NPS survey recency decay is applied: responses older than 180 days contribute at 50% weight to the NPS health signal | A 6-month-old NPS response is a weak signal of current sentiment. Flat weighting would make health scores slow to update on deteriorating accounts. | If accounts have infrequent survey cadences (e.g., annual NPS), the decay will underweight their scores. A flag is added when NPS signal is based on data older than 180 days. | 2026-04-15 |

---

## Implementation Map

| Assumption | Module | Notes |
|---|---|---|
| Data #1: Legacy DD/MM/YYYY dates | `packages/data-engine/src/utils/date-parser.ts` | `parseAmbiguousDate()` with `formatHint: 'DD/MM/YYYY'` default for legacy data |
| Data #2: Zero-decimal currencies | `packages/data-engine/src/utils/normalization.ts` | `normalizeAmount()` handles JPY, KRW etc. |
| Data #3: Currency amounts in minor units | `packages/data-engine/src/utils/normalization.ts` | Heuristic: integers > 10,000 treated as minor units |
| Data #4: FX earliest rate fallback | `packages/data-engine/src/utils/fx.ts` | `convertToUSDWithMeta()` returns `fxRateApproximated: true` |
| Data #5: Legacy ALLCAPS names | `packages/data-engine/src/reconciliation/entity-resolution.ts` | Pass 3: abbreviation lookup + Jaccard similarity |
| Data #6: Product events by account_id | `packages/data-engine/src/health/scorer.ts` | Falls back to `unavailable` if unresolvable |
| Business #1: ARR excludes trials | `packages/data-engine/src/metrics/arr.ts` | `excludeTrials` option (default true) |
| Business #2: NRR trailing 12-month | `packages/data-engine/src/metrics/nrr.ts` | TTM calculation with period-end FX rates |
| Business #3: Cancel+re-sign = churn + new logo | `packages/data-engine/src/metrics/churn.ts` | Separate churn and new logo tracking |
| Business #4: Contraction separate from churn | `packages/data-engine/src/metrics/churn.ts` | `grossChurn` only includes full cancellations |
| Business #5: Zombie deals 180 days | `packages/data-engine/src/reconciliation/pipeline.ts` | `zombieThresholdDays` defaults to 180 |
| Business #6: Unit economics margins | `packages/data-engine/src/metrics/unit-economics.ts` | Starter 0.65, Growth/Enterprise/Scale 0.78 |

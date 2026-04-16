import { addMonths, format, parseISO } from 'date-fns';
import type { ARRResult } from '../metrics/types.js';
import type { MonthlyProjection, ScenarioInput, ScenarioResult } from './types.js';

const BASE_CHURN_RATE = 0.025;
const BASE_EXPANSION_RATE = 0.015;
const NON_USD_SHARE = 0.3;

function parseAsOfDate(asOfDate: string): Date {
  const d = parseISO(asOfDate);
  if (!Number.isNaN(d.getTime())) return d;
  const fallback = new Date(asOfDate);
  if (!Number.isNaN(fallback.getTime())) return fallback;
  throw new Error(`Invalid asOfDate on baseline metrics: "${asOfDate}"`);
}

function validateScenarioInputs(inputs: ScenarioInput): void {
  const entries: [keyof ScenarioInput, number][] = [
    ['churnRateDelta', inputs.churnRateDelta],
    ['expansionRateDelta', inputs.expansionRateDelta],
    ['newBusinessDelta', inputs.newBusinessDelta],
    ['pricingChange', inputs.pricingChange],
    ['fxAssumption', inputs.fxAssumption],
  ];
  for (const [key, v] of entries) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`Scenario input "${String(key)}" must be a finite number`);
    }
  }
  if (inputs.pricingChange <= 0 || inputs.pricingChange > 5) {
    throw new Error('pricingChange must be between 0 (exclusive) and 5');
  }
  if (inputs.fxAssumption <= 0 || inputs.fxAssumption > 5) {
    throw new Error('fxAssumption must be between 0 (exclusive) and 5');
  }
  const churn = BASE_CHURN_RATE + inputs.churnRateDelta;
  if (churn < 0 || churn > 0.5) {
    throw new Error(
      `Monthly churn rate would be ${(churn * 100).toFixed(2)}%, outside allowed range [0%, 50%]`,
    );
  }
  const expansion = BASE_EXPANSION_RATE + inputs.expansionRateDelta;
  if (expansion < 0 || expansion > 0.5) {
    throw new Error(
      `Monthly expansion rate would be ${(expansion * 100).toFixed(2)}%, outside allowed range [0%, 50%]`,
    );
  }
}

type ScenarioRates = Pick<
  ScenarioInput,
  'churnRateDelta' | 'expansionRateDelta' | 'newBusinessDelta' | 'pricingChange' | 'fxAssumption'
>;

function projectScenario(baseMetrics: ARRResult, rates: ScenarioRates): MonthlyProjection[] {
  const baselineARR = baseMetrics.total;
  const baseMRR = baselineARR / 12;
  const baseNewBusinessMRR = baseMRR * 0.05;

  const churnRate = BASE_CHURN_RATE + rates.churnRateDelta;
  const expansionRate = BASE_EXPANSION_RATE + rates.expansionRateDelta;
  const newMRRMonthly = baseNewBusinessMRR + rates.newBusinessDelta;
  const avgARR = baseMetrics.avgARRPerCustomer > 0 ? baseMetrics.avgARRPerCustomer : 1;

  const asOf = parseAsOfDate(baseMetrics.asOfDate);

  let startMRR = baseMRR;
  let startCustomers = baseMetrics.totalCustomers;
  const projections: MonthlyProjection[] = [];

  for (let i = 0; i < 12; i++) {
    const churnMRR = startMRR * churnRate;
    const expansionMRR = startMRR * expansionRate;
    const newMRR = newMRRMonthly;
    const pricingMRR = (startMRR / 12) * (rates.pricingChange - 1.0);
    const fxMRR = startMRR * NON_USD_SHARE * (rates.fxAssumption - 1.0);

    const endMRR = startMRR + newMRR + expansionMRR + pricingMRR + fxMRR - churnMRR;
    const netNewMRR = endMRR - startMRR;
    const arr = endMRR * 12;

    const newCustomers = (newMRR / avgARR) * 12;
    const endCustomers = Math.max(0, startCustomers - startCustomers * churnRate + newCustomers);

    projections.push({
      month: format(addMonths(asOf, i + 1), 'yyyy-MM'),
      arr,
      newBusiness: newMRR,
      expansion: expansionMRR,
      contraction: 0,
      churn: churnMRR,
      netNewMRR,
      customerCount: Math.round(endCustomers),
    });

    startMRR = endMRR;
    startCustomers = endCustomers;
  }

  return projections;
}

function finalArr(projections: MonthlyProjection[]): number {
  return projections[projections.length - 1]!.arr;
}

function buildAssumptions(inputs: ScenarioInput, baseMRR: number): string[] {
  const assumptions: string[] = [];
  const baseNew = baseMRR * 0.05;

  if (inputs.churnRateDelta !== 0) {
    const from = (BASE_CHURN_RATE * 100).toFixed(1);
    const to = ((BASE_CHURN_RATE + inputs.churnRateDelta) * 100).toFixed(1);
    const pp = (inputs.churnRateDelta * 100).toFixed(1);
    const sign = inputs.churnRateDelta > 0 ? '+' : '';
    assumptions.push(
      `Monthly churn rate adjusted by ${sign}${pp}pp (from ${from}% to ${to}%)`,
    );
  }

  if (inputs.expansionRateDelta !== 0) {
    const from = (BASE_EXPANSION_RATE * 100).toFixed(1);
    const to = ((BASE_EXPANSION_RATE + inputs.expansionRateDelta) * 100).toFixed(1);
    const pp = (inputs.expansionRateDelta * 100).toFixed(1);
    const sign = inputs.expansionRateDelta > 0 ? '+' : '';
    assumptions.push(
      `Monthly expansion rate adjusted by ${sign}${pp}pp (from ${from}% to ${to}%)`,
    );
  }

  if (inputs.newBusinessDelta !== 0) {
    const sign = inputs.newBusinessDelta > 0 ? 'increased' : 'decreased';
    const amt = Math.abs(inputs.newBusinessDelta);
    assumptions.push(
      `New business MRR ${sign} by $${amt.toLocaleString('en-US', { maximumFractionDigits: 0 })}/month (baseline new MRR ~$${baseNew.toLocaleString('en-US', { maximumFractionDigits: 0 })}/month)`,
    );
  }

  if (inputs.pricingChange !== 1) {
    const pct = ((inputs.pricingChange - 1) * 100).toFixed(1);
    assumptions.push(
      `Renewing cohort pricing multiplier ${inputs.pricingChange.toFixed(3)} (${pct}% vs list on ~1/12 of MRR each month)`,
    );
  }

  if (inputs.fxAssumption !== 1) {
    const pct = ((inputs.fxAssumption - 1) * 100).toFixed(1);
    assumptions.push(
      `FX assumption ${inputs.fxAssumption.toFixed(3)} on ~${(NON_USD_SHARE * 100).toFixed(0)}% non-USD MRR (${pct}% vs spot)`,
    );
  }

  if (assumptions.length === 0) {
    assumptions.push('Baseline drivers: 2.5% monthly churn, 1.5% expansion, new business at 5% of starting MRR');
  }

  return assumptions;
}

/**
 * What-if scenario modeling engine.
 *
 * @param baseMetrics - Current ARR metrics used as the starting point
 * @param inputs - Scenario input parameters (deltas to apply)
 * @returns 12-month projection with impact breakdown
 */
export async function runScenario(
  baseMetrics: ARRResult,
  inputs: ScenarioInput,
): Promise<ScenarioResult> {
  validateScenarioInputs(inputs);

  const baselineARR = baseMetrics.total;
  const baseMRR = baselineARR / 12;

  const neutral: ScenarioRates = {
    churnRateDelta: 0,
    expansionRateDelta: 0,
    newBusinessDelta: 0,
    pricingChange: 1,
    fxAssumption: 1,
  };

  const baselineProjections = projectScenario(baseMetrics, neutral);
  const baselineEndARR = finalArr(baselineProjections);

  const scenarioProjections = projectScenario(baseMetrics, inputs);
  const scenarioEndARR = finalArr(scenarioProjections);

  const churnOnly = projectScenario(baseMetrics, { ...neutral, churnRateDelta: inputs.churnRateDelta });
  const expansionOnly = projectScenario(baseMetrics, {
    ...neutral,
    expansionRateDelta: inputs.expansionRateDelta,
  });
  const newBizOnly = projectScenario(baseMetrics, { ...neutral, newBusinessDelta: inputs.newBusinessDelta });
  const pricingOnly = projectScenario(baseMetrics, { ...neutral, pricingChange: inputs.pricingChange });
  const fxOnly = projectScenario(baseMetrics, { ...neutral, fxAssumption: inputs.fxAssumption });

  const churnImpact = finalArr(churnOnly) - baselineEndARR;
  const expansionImpact = finalArr(expansionOnly) - baselineEndARR;
  const newBusinessImpact = finalArr(newBizOnly) - baselineEndARR;
  const pricingImpact = finalArr(pricingOnly) - baselineEndARR;
  const fxImpact = finalArr(fxOnly) - baselineEndARR;
  const totalImpact = scenarioEndARR - baselineEndARR;

  return {
    label: inputs.label?.trim() ? inputs.label.trim() : 'Scenario',
    inputs,
    baselineARR,
    projectedARR: scenarioEndARR,
    projections: scenarioProjections,
    impactBreakdown: {
      churnImpact,
      expansionImpact,
      newBusinessImpact,
      pricingImpact,
      fxImpact,
      totalImpact,
    },
    assumptions: buildAssumptions(inputs, baseMRR),
  };
}

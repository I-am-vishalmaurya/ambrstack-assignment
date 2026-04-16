import { Router } from 'express';
import { getData } from '../data/singleton.js';
import { runScenario } from '../scenarios/engine.js';
import { calculateARR } from '../metrics/arr.js';
import { recordAudit } from '../audit/store.js';
import type { ScenarioInput as EngineScenarioInput, ScenarioResult as EngineScenarioResult } from '../scenarios/types.js';

export const scenariosRouter = Router();

/** Accepts dashboard-style (`priceDelta`) or engine-style (`pricingChange`) bodies. */
function toEngineScenarioInput(raw: Record<string, unknown>): EngineScenarioInput {
  const churnRateDelta = Number(raw.churnRateDelta ?? 0);
  const expansionRateDelta = Number(raw.expansionRateDelta ?? 0);
  const newBusinessDelta = Number(raw.newBusinessDelta ?? 0);

  let pricingChange =
    raw.pricingChange !== undefined && raw.pricingChange !== null
      ? Number(raw.pricingChange)
      : NaN;
  if (!Number.isFinite(pricingChange)) {
    const priceDelta = Number(raw.priceDelta ?? 0);
    pricingChange = 1 + priceDelta;
  }

  let fxAssumption =
    raw.fxAssumption !== undefined && raw.fxAssumption !== null ? Number(raw.fxAssumption) : NaN;
  if (!Number.isFinite(fxAssumption)) {
    const costDelta = Number(raw.costDelta ?? 0);
    fxAssumption = 1 + costDelta;
  }

  return {
    label: typeof raw.label === 'string' ? raw.label : undefined,
    churnRateDelta,
    expansionRateDelta,
    newBusinessDelta,
    pricingChange,
    fxAssumption,
  };
}

function toClientScenarioResult(
  engine: EngineScenarioResult,
  original: Record<string, unknown>,
): Record<string, unknown> {
  const baseline = engine.baselineARR;
  const projected = engine.projectedARR;
  const arrChange = projected - baseline;
  const arrChangePercent = baseline !== 0 ? (arrChange / baseline) * 100 : 0;

  return {
    label: engine.label,
    input: original,
    projections: engine.projections.map((p) => ({
      month: p.month,
      arr: p.arr,
      mrr: p.arr / 12,
      customers: p.customerCount,
    })),
    endingARR: projected,
    arrChange,
    arrChangePercent,
    impactBreakdown: {
      churnImpact: engine.impactBreakdown.churnImpact,
      expansionImpact: engine.impactBreakdown.expansionImpact,
      newBusinessImpact: engine.impactBreakdown.newBusinessImpact,
      priceImpact: engine.impactBreakdown.pricingImpact,
    },
  };
}

scenariosRouter.post('/run', async (req, res) => {
  const started = Date.now();
  try {
    const raw = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const data = await getData();
    const asOf = new Date();
    const baselineArr = await calculateARR(data, asOf);
    const inputs = toEngineScenarioInput(raw);
    const result = await runScenario(baselineArr, inputs);
    const durationMs = Date.now() - started;
    recordAudit('scenarios.run', 'scenarios', { label: result.label }, durationMs);
    res.json(toClientScenarioResult(result, raw));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[scenarios] Error:', msg);
    res.status(500).json({ error: msg });
  }
});

scenariosRouter.get('/presets', async (_req, res) => {
  try {
    const presets = [
      {
        id: 'optimistic',
        label: 'Optimistic',
        description: 'Lower churn, higher expansion, and stronger new business.',
        input: {
          churnRateDelta: -0.008,
          expansionRateDelta: 0.012,
          newBusinessDelta: 15_000,
          priceDelta: 0,
          costDelta: 0,
        },
      },
      {
        id: 'pessimistic',
        label: 'Pessimistic',
        description: 'Higher churn and weaker expansion assumptions.',
        input: {
          churnRateDelta: 0.012,
          expansionRateDelta: -0.008,
          newBusinessDelta: -10_000,
          priceDelta: 0,
          costDelta: 0,
        },
      },
      {
        id: 'price_increase_10pct',
        label: 'Price +10%',
        description: 'Model a 10% list-price increase on renewing and new ARR.',
        input: {
          churnRateDelta: 0,
          expansionRateDelta: 0,
          newBusinessDelta: 0,
          priceDelta: 0.1,
          costDelta: 0,
        },
      },
      {
        id: 'churn_reduction_20pct',
        label: 'Churn −20% (relative)',
        description: 'Reduce the baseline monthly churn rate by ~20% relative to the 2.5% default.',
        input: {
          churnRateDelta: -0.005,
          expansionRateDelta: 0,
          newBusinessDelta: 0,
          priceDelta: 0,
          costDelta: 0,
        },
      },
    ];
    res.json(presets);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[scenarios] Error:', msg);
    res.status(500).json({ error: msg });
  }
});

scenariosRouter.post('/compare', async (req, res) => {
  const started = Date.now();
  try {
    if (!Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Request body must be a JSON array of scenario inputs' });
    }
    const data = await getData();
    const asOf = new Date();
    const baselineArr = await calculateARR(data, asOf);
    const out: Record<string, unknown>[] = [];
    for (const item of req.body) {
      const raw = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {};
      const inputs = toEngineScenarioInput(raw);
      const result = await runScenario(baselineArr, inputs);
      out.push(toClientScenarioResult(result, raw));
    }
    const durationMs = Date.now() - started;
    recordAudit('scenarios.compare', 'scenarios', { scenarios: out.length }, durationMs);
    res.json(out);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[scenarios] Error:', msg);
    res.status(500).json({ error: msg });
  }
});

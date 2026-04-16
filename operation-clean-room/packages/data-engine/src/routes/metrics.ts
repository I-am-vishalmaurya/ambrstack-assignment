import { Router } from 'express';
import { getData } from '../data/singleton.js';
import { calculateARR } from '../metrics/arr.js';
import { calculateNRR } from '../metrics/nrr.js';
import { calculateChurn } from '../metrics/churn.js';
import { calculateUnitEconomics } from '../metrics/unit-economics.js';
import { buildCohortAnalysis } from '../metrics/cohorts.js';
import { calculateHealthScores } from '../health/scorer.js';
import { RiskLevel } from '../health/types.js';
import { recordAudit } from '../audit/store.js';

export const metricsRouter = Router();

function parseDateParam(q: unknown, fallback: Date): Date {
  if (typeof q !== 'string' || q.trim() === '') return fallback;
  const d = new Date(q);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

function gradeFromScore(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= 88) return 'A';
  if (score >= 75) return 'B';
  if (score >= 62) return 'C';
  if (score >= 50) return 'D';
  return 'F';
}

function churnRiskFromLevel(level: RiskLevel): number {
  switch (level) {
    case RiskLevel.CRITICAL:
      return 0.92;
    case RiskLevel.HIGH:
      return 0.72;
    case RiskLevel.MEDIUM:
      return 0.45;
    default:
      return 0.15;
  }
}

metricsRouter.get('/arr', async (req, res) => {
  const started = Date.now();
  try {
    const data = await getData();
    const asOf = parseDateParam(req.query.date, new Date());
    const excludeTrials = req.query.excludeTrials !== 'false';
    const result = await calculateARR(data, asOf, { excludeTrials });
    const durationMs = Date.now() - started;
    recordAudit('metrics.arr', 'metrics', { asOf: result.asOfDate }, durationMs);

    const segments: Record<string, { total: number; newBusiness: number; expansion: number; contraction: number; churn: number }> =
      {};
    for (const row of result.bySegment) {
      segments[row.label] = {
        total: row.arr,
        newBusiness: 0,
        expansion: 0,
        contraction: 0,
        churn: 0,
      };
    }

    res.json({
      date: result.asOfDate,
      arr: {
        total: result.total,
        newBusiness: 0,
        expansion: 0,
        contraction: 0,
        churn: 0,
      },
      segments: Object.keys(segments).length ? segments : undefined,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[metrics] Error:', msg);
    res.status(500).json({ error: msg });
  }
});

metricsRouter.get('/nrr', async (req, res) => {
  const started = Date.now();
  try {
    if (!req.query.startDate || typeof req.query.startDate !== 'string') {
      return res.status(400).json({ error: 'startDate query parameter is required' });
    }
    if (!req.query.endDate || typeof req.query.endDate !== 'string') {
      return res.status(400).json({ error: 'endDate query parameter is required' });
    }
    const data = await getData();
    const start = new Date(req.query.startDate);
    const end = new Date(req.query.endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return res.status(400).json({ error: 'Invalid startDate or endDate' });
    }
    const result = await calculateNRR(data, start, end);
    const durationMs = Date.now() - started;
    recordAudit('metrics.nrr', 'metrics', { start: result.periodStart, end: result.periodEnd }, durationMs);

    res.json({
      nrr: result.percentage,
      period: { start: result.periodStart, end: result.periodEnd },
      components: {
        startingRevenue: result.startingARR,
        expansion: result.expansion,
        contraction: result.contraction,
        churn: result.churn,
        endingRevenue: result.endingARR,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[metrics] Error:', msg);
    res.status(500).json({ error: msg });
  }
});

metricsRouter.get('/churn', async (req, res) => {
  const started = Date.now();
  try {
    if (!req.query.startDate || typeof req.query.startDate !== 'string') {
      return res.status(400).json({ error: 'startDate query parameter is required' });
    }
    if (!req.query.endDate || typeof req.query.endDate !== 'string') {
      return res.status(400).json({ error: 'endDate query parameter is required' });
    }
    const data = await getData();
    const start = new Date(req.query.startDate);
    const end = new Date(req.query.endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return res.status(400).json({ error: 'Invalid startDate or endDate' });
    }
    const result = await calculateChurn(data, start, end);
    const durationMs = Date.now() - started;
    recordAudit('metrics.churn', 'metrics', { start: result.periodStart, end: result.periodEnd }, durationMs);

    res.json({
      grossChurnRate: result.grossChurn,
      netChurnRate: result.netChurn,
      logoChurnRate: result.logoChurnRate,
      revenueChurnRate: result.grossChurn,
      churned: result.logoChurnCount,
      period: { start: result.periodStart, end: result.periodEnd },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[metrics] Error:', msg);
    res.status(500).json({ error: msg });
  }
});

metricsRouter.get('/unit-economics', async (req, res) => {
  const started = Date.now();
  try {
    if (!req.query.period || typeof req.query.period !== 'string') {
      return res.status(400).json({ error: 'period query parameter is required' });
    }
    const data = await getData();
    const result = await calculateUnitEconomics(data, req.query.period);
    const durationMs = Date.now() - started;
    recordAudit('metrics.unit-economics', 'metrics', { period: result.period }, durationMs);

    res.json({
      cac: result.cac,
      ltv: result.ltv,
      ltvCacRatio: result.ltvCacRatio,
      paybackMonths: result.paybackMonths,
      period: result.period,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[metrics] Error:', msg);
    res.status(500).json({ error: msg });
  }
});

metricsRouter.get('/cohorts', async (req, res) => {
  const started = Date.now();
  try {
    const data = await getData();
    const rows = await buildCohortAnalysis(data);
    const durationMs = Date.now() - started;
    recordAudit('metrics.cohorts', 'metrics', { cohorts: rows.length }, durationMs);

    const cohorts = rows.map((c) => ({
      cohort: c.cohortMonth,
      size: c.customers,
      retention: c.retention,
      revenue: c.retention.map((pct) => Math.round((c.revenue * pct) / 100)),
    }));

    res.json({ cohorts, granularity: 'monthly' as const });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[metrics] Error:', msg);
    res.status(500).json({ error: msg });
  }
});

metricsRouter.get('/customer-health', async (req, res) => {
  const started = Date.now();
  try {
    const data = await getData();
    const scores = await calculateHealthScores(data);
    const durationMs = Date.now() - started;
    recordAudit('metrics.customer-health', 'metrics', { accounts: scores.length }, durationMs);

    const dataOut = scores.map((h) => {
      const sig = (name: string) => h.signals.find((s) => s.name === name)?.value ?? 0;
      return {
        customerId: h.accountId,
        name: h.accountName,
        healthScore: h.score,
        grade: gradeFromScore(h.score),
        signals: {
          usage: sig('Product Usage'),
          support: sig('Support Sentiment'),
          payment: sig('Billing Health'),
          engagement: sig('Engagement Trend'),
          nps: sig('NPS') || null,
        },
        arr: Math.round((h.mrr / 100) * 12),
        plan: h.plan,
        churnRisk: churnRiskFromLevel(h.riskLevel),
        lastActivity: h.lastUpdated,
      };
    });

    res.json({
      data: dataOut,
      meta: { total: dataOut.length },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[metrics] Error:', msg);
    res.status(500).json({ error: msg });
  }
});

metricsRouter.get('/overview', async (req, res) => {
  const started = Date.now();
  try {
    const data = await getData();
    const now = new Date();
    const end = now;
    const start = new Date(end);
    start.setUTCMonth(start.getUTCMonth() - 1);

    const [arr, nrr, churn] = await Promise.all([
      calculateARR(data, now),
      calculateNRR(data, start, end),
      calculateChurn(data, start, end),
    ]);

    const health = await calculateHealthScores(data);
    const distribution: Record<'A' | 'B' | 'C' | 'D' | 'F', number> = {
      A: 0,
      B: 0,
      C: 0,
      D: 0,
      F: 0,
    };
    for (const h of health) {
      distribution[gradeFromScore(h.score)] += 1;
    }

    let unitEconomics;
    try {
      const ym = `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, '0')}`;
      unitEconomics = await calculateUnitEconomics(data, ym);
    } catch {
      unitEconomics = {
        paybackTargetMonths: 18,
        paybackOnTarget: false,
        cac: 0,
        ltv: 0,
        ltvCacRatio: 0,
        paybackMonths: 0,
        grossMargin: 0,
        arpa: 0,
        byChannel: [],
        period: 'unknown',
      };
    }

    const durationMs = Date.now() - started;
    recordAudit('metrics.overview', 'metrics', {}, durationMs);

    res.json({
      arr: {
        total: arr.total,
        newBusiness: 0,
        expansion: 0,
        contraction: 0,
        churn: 0,
      },
      nrr: nrr.percentage,
      churn: {
        grossChurnRate: churn.grossChurn,
        netChurnRate: churn.netChurn,
        logoChurnRate: churn.logoChurnRate,
        revenueChurnRate: churn.grossChurn,
        churned: churn.logoChurnCount,
        period: { start: churn.periodStart, end: churn.periodEnd },
      },
      unitEconomics: {
        cac: unitEconomics.cac,
        ltv: unitEconomics.ltv,
        ltvCacRatio: unitEconomics.ltvCacRatio,
        paybackMonths: unitEconomics.paybackMonths,
        period: unitEconomics.period,
      },
      customerCount: arr.totalCustomers,
      discrepancyCount: 0,
      healthDistribution: distribution,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[metrics] Error:', msg);
    res.status(500).json({ error: msg });
  }
});

import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { getData } from '../data/singleton.js';
import { reconcileRevenue } from '../reconciliation/revenue.js';
import { detectDuplicates } from '../reconciliation/deduplication.js';
import { analyzePipelineQuality } from '../reconciliation/pipeline.js';
import {
  DiscrepancyType,
  Severity,
  type Discrepancy,
  type DuplicateResult,
  type PipelineAnalysisResult,
  type RevenueReconciliationResult,
  type ReconciliationSummary,
} from '../reconciliation/types.js';
import { recordAudit } from '../audit/store.js';

export const reconciliationRouter = Router();

let lastRevenue: RevenueReconciliationResult | null = null;
let lastDuplicates: DuplicateResult[] = [];
let lastPipeline: PipelineAnalysisResult | null = null;
let lastDiscrepancies: Discrepancy[] = [];
let lastRunAt: string | null = null;

function defaultReconciliationRange(): { start: Date; end: Date } {
  return {
    start: new Date('2024-01-01T00:00:00.000Z'),
    end: new Date('2025-12-31T23:59:59.999Z'),
  };
}

function severityForDiff(diffUsd: number, expected: number): Severity {
  const abs = Math.abs(diffUsd);
  const rel = expected > 0 ? abs / expected : 0;
  if (rel > 0.25 || abs > 50_000) return Severity.CRITICAL;
  if (rel > 0.1 || abs > 10_000) return Severity.HIGH;
  if (rel > 0.05 || abs > 1_000) return Severity.MEDIUM;
  return Severity.LOW;
}

function buildRevenueDiscrepancies(revenue: RevenueReconciliationResult): Discrepancy[] {
  const detectedAt = new Date().toISOString();
  const out: Discrepancy[] = [];
  for (const row of revenue.lineItems) {
    if (Math.abs(row.difference) < 100 && row.reason === 'within tolerance') continue;
    const id = randomUUID();
    out.push({
      id,
      type: DiscrepancyType.AMOUNT_MISMATCH,
      severity: severityForDiff(row.difference, row.expected),
      sourceA: { system: 'chargebee', recordId: row.customerId, value: row.expected },
      sourceB: { system: 'stripe', recordId: row.customerId, value: row.actual },
      customerName: row.customerName,
      amount: Math.abs(row.difference),
      description: `Expected subscription revenue ${row.expected.toFixed(2)} vs payments ${row.actual.toFixed(2)} USD (${row.reason})`,
      detectedAt,
      resolved: false,
      resolutionNote: null,
    });
  }
  return out;
}

function buildPipelineDiscrepancies(pipeline: PipelineAnalysisResult): Discrepancy[] {
  const detectedAt = new Date().toISOString();
  const out: Discrepancy[] = [];
  for (const z of pipeline.zombieDeals) {
    out.push({
      id: randomUUID(),
      type: DiscrepancyType.ORPHAN_RECORD,
      severity: Severity.MEDIUM,
      sourceA: { system: 'salesforce', recordId: z.opportunityId, value: z.amount },
      sourceB: { system: 'salesforce', recordId: z.opportunityId, value: z.stage },
      customerName: z.accountName,
      amount: z.amount,
      description: `Zombie opportunity in stage "${z.stage}" with no activity for ${z.daysSinceActivity} days`,
      detectedAt,
      resolved: false,
      resolutionNote: null,
    });
  }
  for (const m of pipeline.mismatches) {
    out.push({
      id: randomUUID(),
      type: DiscrepancyType.STATUS_MISMATCH,
      severity: Severity.HIGH,
      sourceA: { system: 'salesforce', recordId: m.opportunityId, value: m.crmValue },
      sourceB: { system: 'billing', recordId: m.opportunityId, value: m.billingValue },
      customerName: m.accountName,
      amount: null,
      description: m.issue,
      detectedAt,
      resolved: false,
      resolutionNote: null,
    });
  }
  for (const u of pipeline.unbookedRevenue) {
    out.push({
      id: randomUUID(),
      type: DiscrepancyType.MISSING_ACCOUNT,
      severity: Severity.MEDIUM,
      sourceA: { system: u.system, recordId: u.subscriptionId, value: u.mrr },
      sourceB: { system: 'salesforce', recordId: u.subscriptionId, value: null },
      customerName: u.customerName,
      amount: u.mrr,
      description: `Active billing without matching Closed Won opportunity (${u.system})`,
      detectedAt,
      resolved: false,
      resolutionNote: null,
    });
  }
  return out;
}

function buildSummary(discrepancies: Discrepancy[]): ReconciliationSummary {
  const bySeverity = {
    [Severity.LOW]: 0,
    [Severity.MEDIUM]: 0,
    [Severity.HIGH]: 0,
    [Severity.CRITICAL]: 0,
  };
  const byType = {
    [DiscrepancyType.DUPLICATE_ACCOUNT]: 0,
    [DiscrepancyType.MISSING_ACCOUNT]: 0,
    [DiscrepancyType.AMOUNT_MISMATCH]: 0,
    [DiscrepancyType.DATE_MISMATCH]: 0,
    [DiscrepancyType.STATUS_MISMATCH]: 0,
    [DiscrepancyType.ORPHAN_RECORD]: 0,
    [DiscrepancyType.FX_DISCREPANCY]: 0,
  };
  let totalAmountImpact = 0;
  for (const d of discrepancies) {
    bySeverity[d.severity] += 1;
    byType[d.type] += 1;
    if (typeof d.amount === 'number') totalAmountImpact += d.amount;
  }
  return {
    totalDiscrepancies: discrepancies.length,
    bySeverity,
    byType,
    totalAmountImpact,
    recordsProcessed: {},
  };
}

reconciliationRouter.post('/run', async (req, res) => {
  const started = Date.now();
  try {
    const data = await getData();
    const body = (req.body ?? {}) as {
      dateStart?: string;
      dateEnd?: string;
      tolerance?: number;
    };
    let start: Date;
    let end: Date;
    if (body.dateStart && body.dateEnd) {
      start = new Date(body.dateStart);
      end = new Date(body.dateEnd);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        return res.status(400).json({ error: 'Invalid dateStart or dateEnd' });
      }
    } else {
      ({ start, end } = defaultReconciliationRange());
    }

    const revenue = await reconcileRevenue(
      data.chargebeeSubscriptions,
      data.stripePayments,
      data.fxRates,
      {
        startDate: start,
        endDate: end,
        toleranceUSD: body.tolerance,
      },
    );
    const duplicates = await detectDuplicates(data.stripePayments, data.chargebeeSubscriptions);
    const pipeline = await analyzePipelineQuality(data.salesforceOpportunities, [
      ...data.chargebeeSubscriptions,
      ...data.stripePayments,
    ]);

    const discRev = buildRevenueDiscrepancies(revenue);
    const discPipe = buildPipelineDiscrepancies(pipeline);
    lastDiscrepancies = [...discRev, ...discPipe];
    lastRevenue = revenue;
    lastDuplicates = duplicates;
    lastPipeline = pipeline;
    lastRunAt = new Date().toISOString();

    const summary = buildSummary(lastDiscrepancies);
    const durationMs = Date.now() - started;
    recordAudit('reconciliation.run', 'reconciliation', { discrepancyCount: summary.totalDiscrepancies }, durationMs);

    res.json({
      revenue,
      duplicates,
      pipeline,
      discrepancies: lastDiscrepancies,
      summary,
      metadata: {
        startedAt: new Date(started).toISOString(),
        completedAt: new Date().toISOString(),
        durationMs,
        options: body,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[reconciliation] Error:', msg);
    res.status(500).json({ error: msg });
  }
});

reconciliationRouter.get('/discrepancies', async (req, res) => {
  try {
    if (!lastRunAt) {
      return res.json({
        discrepancies: [],
        total: 0,
        message: 'No reconciliation run has been performed yet',
      });
    }
    const severity = req.query.severity as string | undefined;
    const type = req.query.type as string | undefined;
    let rows = lastDiscrepancies;
    if (severity) {
      rows = rows.filter((d) => d.severity === severity);
    }
    if (type) {
      rows = rows.filter((d) => d.type === type);
    }
    res.json({ discrepancies: rows, total: rows.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[reconciliation] Error:', msg);
    res.status(500).json({ error: msg });
  }
});

reconciliationRouter.get('/discrepancies/:id', async (req, res) => {
  try {
    if (!lastRunAt) {
      return res.status(404).json({ error: 'No reconciliation run has been performed yet' });
    }
    const row = lastDiscrepancies.find((d) => d.id === req.params.id);
    if (!row) {
      return res.status(404).json({ error: 'Discrepancy not found' });
    }
    res.json(row);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[reconciliation] Error:', msg);
    res.status(500).json({ error: msg });
  }
});

reconciliationRouter.post('/discrepancies/:id/resolve', async (req, res) => {
  try {
    const body = (req.body ?? {}) as { note?: string; resolutionNote?: string };
    const note = body.note ?? body.resolutionNote;
    if (!note || typeof note !== 'string') {
      return res.status(400).json({ error: 'note or resolutionNote is required in body' });
    }
    const row = lastDiscrepancies.find((d) => d.id === req.params.id);
    if (!row) {
      return res.status(404).json({ error: 'Discrepancy not found' });
    }
    row.resolved = true;
    row.resolutionNote = note;
    recordAudit('discrepancy.resolve', 'reconciliation', { id: row.id }, 0);
    res.json(row);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[reconciliation] Error:', msg);
    res.status(500).json({ error: msg });
  }
});

reconciliationRouter.get('/duplicates', async (req, res) => {
  try {
    if (!lastRunAt) {
      return res.json({
        duplicates: [],
        total: 0,
        message: 'No reconciliation run has been performed yet',
      });
    }
    const classification = req.query.classification as string | undefined;
    let rows = lastDuplicates;
    if (classification) {
      rows = rows.filter((d) => d.classification === classification);
    }
    res.json({ duplicates: rows, total: rows.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[reconciliation] Error:', msg);
    res.status(500).json({ error: msg });
  }
});

reconciliationRouter.get('/pipeline', async (req, res) => {
  try {
    if (!lastPipeline) {
      return res.json({
        pipeline: null,
        message: 'No reconciliation run has been performed yet',
      });
    }
    res.json(lastPipeline);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[reconciliation] Error:', msg);
    res.status(500).json({ error: msg });
  }
});

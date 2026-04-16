import { useCallback, useMemo, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Table } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { Chart } from '@/components/ui/Chart';
import { useApi } from '@/hooks/useApi';
import { getPipelineQuality, runReconciliation } from '@/api/client';

type PipelineSummary = {
  totalZombieDeals: number;
  totalZombieValue: number;
  totalMismatches: number;
  totalUnbookedMRR: number;
  pipelineHealthScore: number;
};

type ZombieRow = {
  id: string;
  opportunityId: string;
  accountName: string;
  amount: number;
  stage: string;
  daysSinceActivity: number;
};

type MismatchRow = {
  id: string;
  opportunityId: string;
  accountName: string;
  issue: string;
  crmValue: string | number;
  billingValue: string | number;
};

type UnbookedRow = {
  id: string;
  subscriptionId: string;
  customerName: string;
  mrr: number;
  system: string;
};

type PipelineAnalysisPayload = {
  zombieDeals: ZombieRow[];
  mismatches: MismatchRow[];
  unbookedRevenue: UnbookedRow[];
  summary: PipelineSummary;
};

function isEmptyPipelineResponse(
  val: unknown,
): val is { pipeline: null; message?: string; error?: string } {
  if (typeof val !== 'object' || val === null) return false;
  const o = val as { pipeline?: unknown };
  return o.pipeline === null;
}

function isPipelineAnalysis(val: unknown): val is PipelineAnalysisPayload {
  if (typeof val !== 'object' || val === null) return false;
  const o = val as PipelineAnalysisPayload;
  return (
    Array.isArray(o.zombieDeals) &&
    Array.isArray(o.mismatches) &&
    Array.isArray(o.unbookedRevenue) &&
    typeof o.summary === 'object' &&
    o.summary !== null
  );
}

function formatCurrency(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);
}

export function PipelineQuality() {
  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const { data, isLoading, error, refetch } = useApi(['reconciliation', 'pipeline'], () =>
    getPipelineQuality() as Promise<unknown>,
  );

  const analysis = useMemo(() => {
    if (!data) return null;
    if (isEmptyPipelineResponse(data)) return null;
    if (isPipelineAnalysis(data)) {
      const z = data.zombieDeals.map((z, i) => ({
        ...z,
        id: z.opportunityId || `z-${i}`,
        opportunityId: z.opportunityId,
        accountName: z.accountName,
        amount: z.amount,
        stage: z.stage,
        daysSinceActivity: z.daysSinceActivity,
      }));
      const m = data.mismatches.map((row, i) => ({
        ...row,
        id: row.opportunityId || `m-${i}`,
      }));
      const u = data.unbookedRevenue.map((row, i) => ({
        ...row,
        id: row.subscriptionId || `u-${i}`,
      }));
      return { ...data, zombieDeals: z, mismatches: m, unbookedRevenue: u };
    }
    return null;
  }, [data]);

  const emptyMessage = useMemo(() => {
    if (!data || isLoading) return null;
    if (typeof data === 'object' && data !== null && 'error' in data) {
      const err = (data as { error?: string }).error;
      return typeof err === 'string' ? err : 'Unable to load pipeline quality';
    }
    if (isEmptyPipelineResponse(data)) {
      return (data as { message?: string }).message ?? 'No reconciliation data yet';
    }
    if (!isPipelineAnalysis(data)) {
      return 'Unexpected response from pipeline API';
    }
    return null;
  }, [data, isLoading]);

  const handleRunReconciliation = useCallback(async () => {
    setRunBusy(true);
    setRunError(null);
    try {
      await runReconciliation();
      await refetch();
    } catch (e) {
      setRunError(e instanceof Error ? e.message : 'Reconciliation failed');
    } finally {
      setRunBusy(false);
    }
  }, [refetch]);

  const exposureChart = useMemo(() => {
    if (!analysis) return [];
    const s = analysis.summary;
    return [
      { name: 'Zombie pipeline', dollars: s.totalZombieValue },
      { name: 'Unbooked MRR (mo.)', dollars: s.totalUnbookedMRR },
    ];
  }, [analysis]);

  if (error) {
    return (
      <div className="p-6">
        <Card title="Error">
          <p className="text-sm text-red-400">{error.message}</p>
        </Card>
      </div>
    );
  }

  const showEmpty = !isLoading && !analysis;

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
            Pipeline Quality
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Zombie deals, CRM vs billing mismatches, and unbooked revenue
          </p>
        </div>
        {showEmpty && (
          <button
            type="button"
            disabled={runBusy}
            onClick={() => void handleRunReconciliation()}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {runBusy ? 'Running…' : 'Run Reconciliation First'}
          </button>
        )}
      </div>

      {runError && (
        <p className="text-sm text-red-400" role="alert">
          {runError}
        </p>
      )}

      {showEmpty && (
        <Card>
          <div className="py-10 text-center text-slate-400">
            <p className="text-sm">{emptyMessage}</p>
            <p className="mt-2 text-xs text-slate-600">
              Run a full reconciliation to populate pipeline analysis.
            </p>
          </div>
        </Card>
      )}

      {isLoading && (
        <Card>
          <p className="py-8 text-center text-sm text-slate-500">Loading pipeline quality…</p>
        </Card>
      )}

      {analysis && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <Card title="Total Zombie Deals" value={analysis.summary.totalZombieDeals} />
            <Card
              title="Zombie Value"
              value={formatCurrency(analysis.summary.totalZombieValue)}
            />
            <Card title="Mismatches" value={analysis.summary.totalMismatches} />
            <Card
              title="Unbooked MRR"
              value={formatCurrency(analysis.summary.totalUnbookedMRR)}
            />
            <Card
              title="Pipeline Health Score"
              value={`${analysis.summary.pipelineHealthScore.toFixed(0)} / 100`}
            />
          </div>

          <Card title="Revenue exposure (USD)">
            <Chart
              type="bar"
              height={240}
              xAxisKey="name"
              data={exposureChart as unknown as Record<string, unknown>[]}
              series={[{ key: 'dollars', label: 'Amount', color: '#F59E0B' }]}
            />
          </Card>

          <Card title="Zombie deals">
            <Table
              columns={[
                { key: 'opportunityId', label: 'Opportunity ID', sortable: true },
                { key: 'accountName', label: 'Account Name', sortable: true },
                {
                  key: 'amount',
                  label: 'Amount',
                  sortable: true,
                  render: (v) => (
                    <span className="font-mono text-xs">{formatCurrency(Number(v))}</span>
                  ),
                },
                { key: 'stage', label: 'Stage', sortable: true },
                {
                  key: 'daysSinceActivity',
                  label: 'Days Since Activity',
                  sortable: true,
                  render: (v) => (
                    <Badge variant={Number(v) > 180 ? 'error' : 'warning'}>{String(v)}</Badge>
                  ),
                },
              ]}
              data={analysis.zombieDeals as unknown as Record<string, unknown>[]}
              rowKey={(row) => String(row.id)}
              emptyMessage="No zombie deals"
            />
          </Card>

          <Card title="Mismatches">
            <Table
              columns={[
                { key: 'opportunityId', label: 'Opportunity ID', sortable: true },
                { key: 'accountName', label: 'Account Name', sortable: true },
                { key: 'issue', label: 'Issue', sortable: true },
                {
                  key: 'crmValue',
                  label: 'CRM Value',
                  render: (v) => (
                    <span className="font-mono text-xs text-slate-300">{String(v)}</span>
                  ),
                },
                {
                  key: 'billingValue',
                  label: 'Billing Value',
                  render: (v) => (
                    <span className="font-mono text-xs text-slate-300">{String(v)}</span>
                  ),
                },
              ]}
              data={analysis.mismatches as unknown as Record<string, unknown>[]}
              rowKey={(row) => String(row.id)}
              emptyMessage="No mismatches"
            />
          </Card>

          <Card title="Unbooked revenue">
            <Table
              columns={[
                { key: 'subscriptionId', label: 'Subscription ID', sortable: true },
                { key: 'customerName', label: 'Customer Name', sortable: true },
                {
                  key: 'mrr',
                  label: 'MRR',
                  sortable: true,
                  render: (v) => (
                    <span className="font-mono text-xs">{formatCurrency(Number(v))}</span>
                  ),
                },
                { key: 'system', label: 'System', sortable: true },
              ]}
              data={analysis.unbookedRevenue as unknown as Record<string, unknown>[]}
              rowKey={(row) => String(row.id)}
              emptyMessage="No unbooked revenue rows"
            />
          </Card>
        </>
      )}
    </div>
  );
}

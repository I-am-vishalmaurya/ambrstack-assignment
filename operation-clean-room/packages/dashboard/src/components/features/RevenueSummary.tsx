import { Card } from '@/components/ui/Card';
import { Chart } from '@/components/ui/Chart';
import { useApi } from '@/hooks/useApi';
import { getMetricsOverview, getARR } from '@/api/client';
import type { ARRBreakdown, MetricsOverview } from '@/types';
import { DollarSign, TrendingUp, Users, AlertTriangle, Loader2 } from 'lucide-react';

function fmtCurrency(n: number): string {
  if (!Number.isFinite(n)) return '$0';
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

function arrNetMotionPct(arr: ARRBreakdown | undefined): number | undefined {
  if (!arr || !arr.total || arr.total <= 0) return undefined;
  const motion =
    (arr.newBusiness + arr.expansion - arr.contraction - arr.churn) / arr.total;
  if (!Number.isFinite(motion) || motion === 0) return undefined;
  return motion * 100;
}

function coerceOverview(raw: unknown): MetricsOverview | null {
  if (!raw || typeof raw !== 'object') return null;
  return raw as MetricsOverview;
}

export function RevenueSummary() {
  const {
    data: overviewRaw,
    isLoading: overviewLoading,
    error: overviewError,
  } = useApi(['metrics', 'overview'], () => getMetricsOverview());

  const {
    data: arrRaw,
    isLoading: arrLoading,
    error: arrError,
  } = useApi(['metrics', 'arr'], () => getARR());

  const overview = coerceOverview(overviewRaw);
  const isLoading = overviewLoading || arrLoading;
  const error = overviewError ?? arrError;

  if (error) {
    return (
      <div className="p-6">
        <div className="rounded-lg border border-red-500/40 bg-red-950/40 p-6 text-slate-200">
          <h2 className="text-lg font-semibold text-red-300">Failed to load revenue metrics</h2>
          <p className="mt-2 font-mono text-sm text-red-200/90">{error.message}</p>
        </div>
      </div>
    );
  }

  if (isLoading || !overview) {
    return (
      <div className="flex min-h-[240px] items-center justify-center p-6">
        <Loader2 className="h-10 w-10 animate-spin text-slate-500" aria-label="Loading" />
      </div>
    );
  }

  const arrTotal = overview.arr?.total ?? 0;
  const mrr = arrTotal / 12;
  const nrr = overview.nrr ?? 0;
  const customers = overview.customerCount ?? 0;
  const arrChange = arrNetMotionPct(overview.arr);

  const arrResponse = arrRaw && typeof arrRaw === 'object' ? (arrRaw as { segments?: Record<string, ARRBreakdown>; arr?: ARRBreakdown }) : null;
  const segmentEntries = arrResponse?.segments
    ? Object.entries(arrResponse.segments)
    : [];
  const barData =
    segmentEntries.length > 0
      ? segmentEntries.map(([label, seg]) => ({
          label,
          total: typeof seg?.total === 'number' ? seg.total : 0,
        }))
      : [
          {
            label: 'Total ARR',
            total: arrResponse?.arr?.total ?? arrTotal,
          },
        ];

  const barSeries = [{ key: 'total', label: 'ARR', color: '#3B82F6' }];

  return (
    <div className="space-y-6 p-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Card
          title="ARR"
          value={fmtCurrency(arrTotal)}
          change={arrChange}
          changeLabel="net motion"
          icon={<DollarSign size={18} />}
        />
        <Card
          title="MRR (implied)"
          value={fmtCurrency(mrr)}
          icon={<TrendingUp size={18} />}
        />
        <Card
          title="NRR"
          value={`${nrr.toFixed(1)}%`}
          icon={<AlertTriangle size={18} />}
        />
        <Card title="Customers" value={customers} icon={<Users size={18} />} />
      </div>

      <div className="rounded-lg border border-slate-700/50 bg-slate-800/80 p-5 backdrop-blur-sm">
        <h3 className="mb-4 text-xs font-semibold uppercase tracking-wider text-slate-400">
          ARR by segment
        </h3>
        <Chart type="bar" data={barData} series={barSeries} xAxisKey="label" height={280} />
      </div>
    </div>
  );
}

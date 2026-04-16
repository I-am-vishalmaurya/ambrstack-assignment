import { Card } from '@/components/ui/Card';
import { Chart } from '@/components/ui/Chart';
import { useApi } from '@/hooks/useApi';
import { getCohorts } from '@/api/client';
import type { CohortRow, ChartSeries } from '@/types';
import { clsx } from 'clsx';
import { Loader2 } from 'lucide-react';
import { useMemo } from 'react';

function extractCohorts(raw: unknown): CohortRow[] {
  if (!raw || typeof raw !== 'object') return [];
  const o = raw as { cohorts?: unknown };
  return Array.isArray(o.cohorts) ? (o.cohorts as CohortRow[]) : [];
}

function heatClass(pct: number | undefined): string {
  if (pct == null || Number.isNaN(pct)) return 'bg-slate-800 text-slate-500';
  if (pct > 80) return 'bg-emerald-600/80 text-slate-950';
  if (pct >= 50) return 'bg-amber-500/70 text-slate-950';
  return 'bg-red-600/75 text-slate-100';
}

const PALETTE = ['#3B82F6', '#22C55E', '#F59E0B', '#A855F7', '#EC4899'];

export function CohortAnalysis() {
  const { data, isLoading, error } = useApi(['metrics', 'cohorts'], () => getCohorts());

  const cohorts = useMemo(() => extractCohorts(data), [data]);

  const maxPeriods = useMemo(() => {
    if (!cohorts.length) return 0;
    return Math.max(...cohorts.map((c) => c.retention?.length ?? 0), 0);
  }, [cohorts]);

  const recentCohorts = useMemo(() => {
    if (!cohorts.length) return [];
    return [...cohorts].slice(-4).reverse();
  }, [cohorts]);

  const lineData = useMemo(() => {
    const cohortsForChart = recentCohorts.length ? recentCohorts : [];
    const len = cohortsForChart.length
      ? Math.max(...cohortsForChart.map((c) => c.retention?.length ?? 0), 1)
      : 6;
    const points: Record<string, unknown>[] = [];
    for (let i = 0; i < len; i += 1) {
      const row: Record<string, unknown> = { period: `M${i}` };
      if (cohortsForChart.length) {
        for (const c of cohortsForChart) {
          const key = `c_${c.cohort}`;
          row[key] = c.retention?.[i] ?? null;
        }
      } else {
        row.placeholder = 0;
      }
      points.push(row);
    }
    return points;
  }, [recentCohorts]);

  const lineSeries: ChartSeries[] = useMemo(() => {
    if (recentCohorts.length) {
      return recentCohorts.map((c, i) => ({
        key: `c_${c.cohort}`,
        label: c.cohort,
        color: PALETTE[i % PALETTE.length]!,
      }));
    }
    return [{ key: 'placeholder', label: 'No cohort data', color: '#475569' }];
  }, [recentCohorts]);

  if (error) {
    return (
      <div className="p-6">
        <div className="rounded-lg border border-red-500/40 bg-red-950/40 p-6 text-slate-200">
          <h2 className="text-lg font-semibold text-red-300">Failed to load cohorts</h2>
          <p className="mt-2 font-mono text-sm text-red-200/90">{error.message}</p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex min-h-[240px] items-center justify-center p-6">
        <Loader2 className="h-10 w-10 animate-spin text-slate-500" aria-label="Loading" />
      </div>
    );
  }

  const showHeatmap = cohorts.length > 0 && maxPeriods > 0;

  return (
    <div className="space-y-8 p-6">
      <div>
        <h2 className="mb-4 text-lg font-semibold text-slate-200">Retention heatmap</h2>
        {showHeatmap ? (
          <div className="overflow-auto rounded-lg border border-slate-700/50">
            <table className="w-full min-w-[640px] border-collapse text-left text-sm">
              <thead>
                <tr>
                  <th className="sticky left-0 z-10 bg-slate-900 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Cohort
                  </th>
                  <th className="px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Size
                  </th>
                  {Array.from({ length: maxPeriods }, (_, i) => (
                    <th
                      key={i}
                      className="px-2 py-2 text-center text-xs font-semibold uppercase tracking-wider text-slate-400"
                    >
                      M{i}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cohorts.map((c) => (
                  <tr key={c.cohort} className="border-t border-slate-700/40">
                    <td className="sticky left-0 z-10 bg-slate-900/95 px-3 py-2 font-mono text-xs text-slate-200">
                      {c.cohort}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-400">{c.size}</td>
                    {Array.from({ length: maxPeriods }, (_, i) => {
                      const pct = c.retention?.[i];
                      return (
                        <td key={i} className="p-1 text-center">
                          <div
                            className={clsx(
                              'rounded px-2 py-1 font-mono text-xs font-medium',
                              heatClass(pct),
                            )}
                          >
                            {pct != null ? `${pct.toFixed(0)}%` : '—'}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-slate-500">
            Cohort retention data is not available yet. The chart below shows an empty placeholder
            until metrics are generated.
          </p>
        )}
      </div>

      <Card title="Recent cohort curves (% retained)" className="!p-5">
        <p className="mb-3 text-xs text-slate-500">
          {recentCohorts.length
            ? 'Last up to four cohort months vs. period index.'
            : 'Placeholder — run data load to populate cohort retention.'}
        </p>
        <Chart
          type="line"
          data={lineData}
          series={lineSeries}
          xAxisKey="period"
          height={280}
        />
      </Card>
    </div>
  );
}

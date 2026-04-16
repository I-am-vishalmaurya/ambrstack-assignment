import { Table } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { useApi } from '@/hooks/useApi';
import { getDiscrepancies, runReconciliation } from '@/api/client';
import type { DiscrepancySeverity } from '@/types';
import { useState, useCallback, useMemo } from 'react';
import { Loader2 } from 'lucide-react';

type ApiDiscrepancyRow = Record<string, unknown>;

function extractDiscrepancyList(raw: unknown): ApiDiscrepancyRow[] {
  if (!raw || typeof raw !== 'object') return [];
  const o = raw as Record<string, unknown>;
  const list = o.data ?? o.discrepancies ?? o.items;
  return Array.isArray(list) ? (list as ApiDiscrepancyRow[]) : [];
}

function severityVariant(
  s: string,
): 'error' | 'warning' | 'info' | 'neutral' {
  switch (s) {
    case 'critical':
      return 'error';
    case 'high':
      return 'warning';
    case 'medium':
      return 'info';
    case 'low':
    default:
      return 'neutral';
  }
}

function normalizeRow(row: ApiDiscrepancyRow): Record<string, unknown> {
  const sourceA = row.sourceA as { system?: string; value?: unknown } | undefined;
  const sourceB = row.sourceB as { system?: string; value?: unknown } | undefined;
  const id = String(row.id ?? '');
  const severity = String(row.severity ?? 'low');
  const resolved = Boolean(row.resolved);
  const status =
    typeof row.status === 'string'
      ? row.status
      : resolved
        ? 'resolved'
        : 'open';

  const systemA = (row.systemA as string) ?? sourceA?.system ?? '—';
  const systemB = (row.systemB as string) ?? sourceB?.system ?? '—';
  const valueA = row.valueA ?? sourceA?.value ?? '—';
  const valueB = row.valueB ?? sourceB?.value ?? '—';
  const deltaRaw = row.delta ?? row.amount ?? 0;
  const delta = typeof deltaRaw === 'number' ? deltaRaw : Number(deltaRaw) || 0;

  return {
    id,
    idShort: id.length > 10 ? `${id.slice(0, 8)}…` : id,
    type: String(row.type ?? '').replace(/_/g, ' ') || '—',
    severity,
    systemA,
    systemB,
    valueA: valueA === null || valueA === undefined ? '—' : String(valueA),
    valueB: valueB === null || valueB === undefined ? '—' : String(valueB),
    delta,
    status,
    detectedAt: String(row.detectedAt ?? ''),
  };
}

export function DiscrepancyTable() {
  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const { data, isLoading, error, refetch } = useApi(
    ['reconciliation', 'discrepancies'],
    () => getDiscrepancies() as Promise<unknown>,
  );

  const rows = useMemo(() => extractDiscrepancyList(data).map(normalizeRow), [data]);

  const counts = useMemo(() => {
    const c: Record<DiscrepancySeverity, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    };
    for (const r of rows) {
      const s = r.severity as DiscrepancySeverity;
      if (s in c) c[s] += 1;
    }
    return c;
  }, [rows]);

  const onRun = useCallback(async () => {
    setRunError(null);
    setRunBusy(true);
    try {
      await runReconciliation();
      await refetch();
    } catch (e) {
      setRunError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunBusy(false);
    }
  }, [refetch]);

  const columns = useMemo(
    () => [
      {
        key: 'idShort',
        label: 'ID',
        sortable: true,
        render: (_: unknown, row: Record<string, unknown>) => (
          <span className="font-mono text-xs text-slate-400" title={String(row.id)}>
            {String(row.idShort)}
          </span>
        ),
      },
      { key: 'type', label: 'Type', sortable: true },
      {
        key: 'severity',
        label: 'Severity',
        render: (v: unknown) => (
          <Badge variant={severityVariant(String(v))}>{String(v)}</Badge>
        ),
      },
      { key: 'systemA', label: 'System A', sortable: true },
      { key: 'systemB', label: 'System B', sortable: true },
      { key: 'valueA', label: 'Value A', sortable: true },
      { key: 'valueB', label: 'Value B', sortable: true },
      {
        key: 'delta',
        label: 'Delta',
        sortable: true,
        render: (v: unknown) => (
          <span className="font-mono text-xs">
            {typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString() : String(v)}
          </span>
        ),
      },
      {
        key: 'status',
        label: 'Status',
        render: (v: unknown) => {
          const s = String(v);
          const variant =
            s === 'resolved' ? 'success' : s === 'investigating' ? 'info' : 'warning';
          return <Badge variant={variant}>{s}</Badge>;
        },
      },
      {
        key: 'detectedAt',
        label: 'Detected At',
        sortable: true,
        render: (v: unknown) => (
          <span className="font-mono text-xs text-slate-400">
            {v ? new Date(String(v)).toLocaleString() : '—'}
          </span>
        ),
      },
    ],
    [],
  );

  if (error) {
    return (
      <div className="p-6">
        <div className="rounded-lg border border-red-500/40 bg-red-950/40 p-6 text-slate-200">
          <h2 className="text-lg font-semibold text-red-300">Failed to load discrepancies</h2>
          <p className="mt-2 font-mono text-sm text-red-200/90">{error.message}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="text-lg font-semibold text-slate-200">Discrepancies</h2>
        <button
          type="button"
          onClick={onRun}
          disabled={runBusy || isLoading}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-600 bg-slate-700/80 px-4 py-2 text-sm font-medium text-slate-100 transition hover:bg-slate-600 disabled:opacity-50"
        >
          {runBusy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : null}
          Run Reconciliation
        </button>
      </div>

      {runError && (
        <div className="rounded-lg border border-red-500/30 bg-red-950/30 px-4 py-3 text-sm text-red-200">
          {runError}
        </div>
      )}

      {isLoading && !runBusy ? (
        <div className="flex min-h-[160px] items-center justify-center">
          <Loader2 className="h-10 w-10 animate-spin text-slate-500" aria-label="Loading" />
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card title="Critical" value={counts.critical} />
            <Card title="High" value={counts.high} />
            <Card title="Medium" value={counts.medium} />
            <Card title="Low" value={counts.low} />
          </div>

          <Table
            columns={columns}
            data={rows}
            rowKey={(row) => String(row.id)}
            emptyMessage="No discrepancies loaded. Run reconciliation to scan systems."
          />
        </>
      )}
    </div>
  );
}

import { Table } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { useApi } from '@/hooks/useApi';
import { getAuditTrail } from '@/api/client';
import { Loader2 } from 'lucide-react';
import { useMemo } from 'react';

type AuditApiRow = Record<string, unknown>;

function extractEntries(raw: unknown): AuditApiRow[] {
  if (!raw || typeof raw !== 'object') return [];
  const o = raw as Record<string, unknown>;
  const list = o.data ?? o.entries ?? o.items;
  return Array.isArray(list) ? (list as AuditApiRow[]) : [];
}

function formatTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso || '—';
  return d.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function actionVariant(action: string): 'info' | 'success' | 'warning' | 'neutral' {
  const a = action.toLowerCase();
  if (a.includes('error') || a.includes('fail')) return 'warning';
  if (a.includes('run') || a.includes('reconcil')) return 'success';
  if (a.includes('metric') || a.includes('overview')) return 'info';
  return 'neutral';
}

function detailsCell(row: AuditApiRow): string {
  const frontendMeta = row.metadata as Record<string, unknown> | undefined;
  const backendDetails = row.details as Record<string, unknown> | undefined;
  const before = row.before;
  const after = row.after;
  const durationMs = row.durationMs;

  const pick =
    (frontendMeta && Object.keys(frontendMeta).length && frontendMeta) ||
    (backendDetails && Object.keys(backendDetails).length && backendDetails) ||
    null;

  if (pick) {
    try {
      return JSON.stringify(pick);
    } catch {
      return String(pick);
    }
  }
  const parts: string[] = [];
  if (before != null) parts.push(`before: ${JSON.stringify(before)}`);
  if (after != null) parts.push(`after: ${JSON.stringify(after)}`);
  if (durationMs != null) parts.push(`durationMs: ${String(durationMs)}`);
  return parts.length ? parts.join(' · ') : '—';
}

export function AuditTrail() {
  const { data, isLoading, error } = useApi(['audit', 'trail'], () =>
    getAuditTrail() as Promise<unknown>,
  );

  const entries = useMemo(() => extractEntries(data), [data]);

  const tableRows = useMemo(
    () =>
      entries.map((e, idx) => {
        const id = String(e.id ?? idx);
        const ts = String(e.timestamp ?? '');
        const action = String(e.action ?? '—');
        const entity =
          String(e.entity ?? e.module ?? '—');
        const user = String(e.userId ?? e.user ?? 'system');
        return {
          id,
          timestamp: ts,
          action,
          entity,
          user,
          details: detailsCell(e),
        };
      }),
    [entries],
  );

  const columns = useMemo(
    () => [
      {
        key: 'timestamp',
        label: 'Timestamp',
        sortable: true,
        render: (v: unknown) => (
          <span className="font-mono text-xs text-slate-300">
            {v ? formatTs(String(v)) : '—'}
          </span>
        ),
      },
      {
        key: 'action',
        label: 'Action',
        sortable: true,
        render: (v: unknown) => (
          <Badge variant={actionVariant(String(v))}>{String(v)}</Badge>
        ),
      },
      { key: 'entity', label: 'Entity', sortable: true },
      {
        key: 'user',
        label: 'User',
        sortable: true,
        render: (v: unknown) => (
          <span className="font-mono text-xs text-slate-400">{String(v)}</span>
        ),
      },
      {
        key: 'details',
        label: 'Details',
        className: 'max-w-md',
        render: (v: unknown) => (
          <span className="line-clamp-2 break-all font-mono text-[11px] text-slate-500" title={String(v)}>
            {String(v)}
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
          <h2 className="text-lg font-semibold text-red-300">Failed to load audit trail</h2>
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

  return (
    <div className="p-6">
      <h2 className="mb-4 text-lg font-semibold text-slate-200">Audit trail</h2>
      <Table
        columns={columns}
        data={tableRows}
        rowKey={(row) => String(row.id)}
        emptyMessage="No audit entries yet. Run a reconciliation to generate entries."
      />
    </div>
  );
}

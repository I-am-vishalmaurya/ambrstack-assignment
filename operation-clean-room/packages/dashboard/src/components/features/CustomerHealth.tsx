import { useMemo } from 'react';
import { Table } from '@/components/ui/Table';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { useApi } from '@/hooks/useApi';
import { getCustomerHealth } from '@/api/client';
import type { CustomerHealth, HealthGrade } from '@/types';
import { clsx } from 'clsx';

/** Grade bands for display when mapping raw / backend health rows. */
function gradeFromScoreDisplay(score: number): HealthGrade {
  if (score >= 80) return 'A';
  if (score >= 60) return 'B';
  if (score >= 40) return 'C';
  if (score >= 20) return 'D';
  return 'F';
}

function gradeBadgeVariant(grade: HealthGrade): 'success' | 'warning' | 'error' {
  if (grade === 'A' || grade === 'B') return 'success';
  if (grade === 'C') return 'warning';
  return 'error';
}

function healthBarClass(score: number): string {
  if (score > 70) return 'bg-emerald-500';
  if (score >= 40) return 'bg-amber-400';
  return 'bg-red-500';
}

function signalByName(
  signals: Array<{ name?: string; value?: number }> | undefined,
  names: string[],
): number {
  if (!signals?.length) return 0;
  for (const n of names) {
    const hit = signals.find(
      (s) => String(s.name ?? '').toLowerCase() === n.toLowerCase(),
    );
    if (hit && typeof hit.value === 'number' && Number.isFinite(hit.value)) {
      return hit.value;
    }
  }
  return 0;
}

type RawHealthRow = Record<string, unknown>;

function normalizeCustomerRow(raw: RawHealthRow): CustomerHealth {
  const accountId = String(raw.accountId ?? raw.customerId ?? '');
  const accountName = String(raw.accountName ?? raw.name ?? '—');
  const score = Number(raw.score ?? raw.healthScore ?? 0);
  const healthScore = Number.isFinite(score) ? Math.min(100, Math.max(0, score)) : 0;

  const grade = gradeFromScoreDisplay(healthScore);

  const signalsArr = raw.signals as
    | Array<{ name?: string; value?: number }>
    | undefined;

  const nested = raw.signals as
    | {
        usage?: number;
        support?: number;
        payment?: number;
        engagement?: number;
        nps?: number | null;
      }
    | undefined;

  const usage =
    typeof nested?.usage === 'number'
      ? nested.usage
      : signalByName(signalsArr, ['Product Usage', 'usage']);
  const support =
    typeof nested?.support === 'number'
      ? nested.support
      : signalByName(signalsArr, ['Support Sentiment', 'support']);
  const payment =
    typeof nested?.payment === 'number'
      ? nested.payment
      : signalByName(signalsArr, ['Billing Health', 'payment', 'Billing']);
  const engagement =
    typeof nested?.engagement === 'number'
      ? nested.engagement
      : signalByName(signalsArr, ['Engagement Trend', 'engagement']);
  let nps: number | null =
    nested && 'nps' in nested
      ? (nested.nps as number | null)
      : signalByName(signalsArr, ['NPS', 'NPS Score']) || null;
  if (nps === 0) nps = null;

  const mrr = Number(raw.mrr ?? 0);
  let arr = Number(raw.arr ?? NaN);
  if (!Number.isFinite(arr)) {
    arr = Number.isFinite(mrr) ? mrr * 12 : 0;
  }

  const plan = String(raw.plan ?? '—');
  const lastActivity = String(raw.lastActivity ?? raw.lastUpdated ?? '—');

  let churnRisk = Number(raw.churnRisk ?? NaN);
  if (!Number.isFinite(churnRisk)) {
    churnRisk = Math.max(0, 100 - healthScore);
  } else if (churnRisk > 0 && churnRisk <= 1) {
    churnRisk = churnRisk * 100;
  }

  return {
    customerId: accountId,
    name: accountName,
    healthScore,
    grade,
    signals: {
      usage,
      support,
      payment,
      engagement,
      nps,
    },
    arr,
    plan,
    churnRisk,
    lastActivity,
  };
}

function formatCurrency(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);
}

/** Flat metrics so `Table` client-side sort can read `row[col.key]`. */
type TableRow = CustomerHealth & {
  id: string;
  usage: number;
  support: number;
  payment: number;
  engagement: number;
  nps: number;
};

function HealthScoreBar({ score }: { score: number }) {
  const pct = Math.min(100, Math.max(0, score));
  return (
    <div className="flex min-w-[120px] items-center gap-2">
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-700">
        <div
          className={clsx('h-full rounded-full transition-all', healthBarClass(score))}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="font-mono text-xs text-slate-300">{pct.toFixed(0)}</span>
    </div>
  );
}

export function CustomerHealth() {
  const { data, isLoading, error, refetch } = useApi(
    ['metrics', 'customer-health'],
    () => getCustomerHealth(),
  );

  const rows = useMemo(() => {
    const payload = data as { data?: unknown } | undefined;
    const list = payload?.data;
    if (!Array.isArray(list)) return [] as TableRow[];
    return list.map((item, idx) => {
      const normalized = normalizeCustomerRow(item as RawHealthRow);
      const npsVal = normalized.signals.nps ?? 0;
      return {
        ...normalized,
        id: normalized.customerId || `row-${idx}`,
        usage: normalized.signals.usage,
        support: normalized.signals.support,
        payment: normalized.signals.payment,
        engagement: normalized.signals.engagement,
        nps: npsVal,
      };
    });
  }, [data]);

  const stats = useMemo(() => {
    if (rows.length === 0) {
      return {
        total: 0,
        avgScore: 0,
        atRisk: 0,
        healthy: 0,
      };
    }
    const total = rows.length;
    const sum = rows.reduce((a, r) => a + r.healthScore, 0);
    const avgScore = sum / total;
    const atRisk = rows.filter((r) => r.grade === 'D' || r.grade === 'F').length;
    const healthy = rows.filter((r) => r.grade === 'A' || r.grade === 'B').length;
    return { total, avgScore, atRisk, healthy };
  }, [rows]);

  const columns = useMemo(
    () => [
      {
        key: 'name',
        label: 'Name',
        sortable: true,
        className: 'font-medium text-slate-200',
      },
      {
        key: 'healthScore',
        label: 'Health Score',
        sortable: true,
        render: (_: unknown, row: TableRow) => (
          <HealthScoreBar score={row.healthScore} />
        ),
      },
      {
        key: 'grade',
        label: 'Grade',
        render: (v: unknown) => (
          <Badge variant={gradeBadgeVariant(v as HealthGrade)}>{String(v)}</Badge>
        ),
      },
      {
        key: 'usage',
        label: 'Usage',
        sortable: true,
        render: (_: unknown, row: TableRow) => (
          <span className="font-mono text-xs">{row.signals.usage.toFixed(0)}</span>
        ),
      },
      {
        key: 'support',
        label: 'Support',
        sortable: true,
        render: (_: unknown, row: TableRow) => (
          <span className="font-mono text-xs">{row.signals.support.toFixed(0)}</span>
        ),
      },
      {
        key: 'payment',
        label: 'Payment',
        sortable: true,
        render: (_: unknown, row: TableRow) => (
          <span className="font-mono text-xs">{row.signals.payment.toFixed(0)}</span>
        ),
      },
      {
        key: 'engagement',
        label: 'Engagement',
        sortable: true,
        render: (_: unknown, row: TableRow) => (
          <span className="font-mono text-xs">{row.signals.engagement.toFixed(0)}</span>
        ),
      },
      {
        key: 'nps',
        label: 'NPS',
        sortable: true,
        render: (_: unknown, row: TableRow) =>
          row.signals.nps == null ? (
            <span className="text-slate-500">—</span>
          ) : (
            <span className="font-mono text-xs">{row.signals.nps}</span>
          ),
      },
      {
        key: 'arr',
        label: 'ARR',
        sortable: true,
        render: (_: unknown, row: TableRow) => (
          <span className="font-mono text-xs">{formatCurrency(row.arr)}</span>
        ),
      },
      {
        key: 'plan',
        label: 'Plan',
        sortable: true,
      },
      {
        key: 'churnRisk',
        label: 'Churn Risk',
        sortable: true,
        render: (_: unknown, row: TableRow) => (
          <span className="font-mono text-xs">{row.churnRisk.toFixed(0)}%</span>
        ),
      },
    ],
    [],
  );

  if (error) {
    return (
      <div className="p-6">
        <Card title="Error">
          <p className="text-sm text-red-400">{error.message}</p>
          <button
            type="button"
            onClick={() => void refetch()}
            className="mt-3 rounded-md bg-slate-700 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-600"
          >
            Retry
          </button>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
          Customer Health
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Multi-signal health scores, grades, and churn risk indicators
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card title="Total Customers" value={isLoading ? '…' : stats.total} />
        <Card
          title="Avg Health Score"
          value={isLoading ? '…' : stats.avgScore.toFixed(1)}
        />
        <Card title="At Risk (D + F)" value={isLoading ? '…' : stats.atRisk} />
        <Card title="Healthy (A + B)" value={isLoading ? '…' : stats.healthy} />
      </div>

      <Card>
        {isLoading ? (
          <p className="py-8 text-center text-sm text-slate-500">Loading customer health…</p>
        ) : (
          <Table<TableRow & Record<string, unknown>>
            columns={columns as never}
            data={rows as (TableRow & Record<string, unknown>)[]}
            rowKey={(row) => row.id}
            emptyMessage="No customer health data"
          />
        )}
      </Card>
    </div>
  );
}

import { useCallback, useMemo, useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Chart } from '@/components/ui/Chart';
import { Slider } from '@/components/ui/Slider';
import { useApi } from '@/hooks/useApi';
import { getScenarioPresets } from '@/api/client';
import type { ScenarioPreset } from '@/types';

type ProjectionRow = {
  month: string;
  arr: number;
  mrr: number;
  customers: number;
};

type ScenarioResultShape = {
  label?: string;
  endingARR?: number;
  arrChange?: number;
  arrChangePercent?: number;
  projections?: Array<{
    month: string;
    arr?: number;
    mrr?: number;
    customers?: number;
    customerCount?: number;
    newBusiness?: number;
    expansion?: number;
    contraction?: number;
    churn?: number;
    netNewMRR?: number;
  }>;
  impactBreakdown?: {
    churnImpact?: number;
    expansionImpact?: number;
    newBusinessImpact?: number;
    priceImpact?: number;
  };
};

function formatCurrency(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);
}

export function ScenarioModeler() {
  const [churnDelta, setChurnDelta] = useState(0);
  const [expansionDelta, setExpansionDelta] = useState(0);
  const [newBizDelta, setNewBizDelta] = useState(0);
  const [priceDelta, setPriceDelta] = useState(0);
  const [costDelta, setCostDelta] = useState(0);

  const [result, setResult] = useState<ScenarioResultShape | null>(null);
  const [scenarioLoading, setScenarioLoading] = useState(false);
  const [scenarioError, setScenarioError] = useState<string | null>(null);

  const { data: presets, isLoading: presetsLoading, error: presetsError } = useApi(
    ['scenarios', 'presets'],
    () => getScenarioPresets(),
  );

  const applyPresetToSliders = useCallback((input: ScenarioPreset['input']) => {
    setChurnDelta((input.churnRateDelta ?? 0) * 100);
    setExpansionDelta((input.expansionRateDelta ?? 0) * 100);
    setNewBizDelta(input.newBusinessDelta ?? 0);
    setPriceDelta((input.priceDelta ?? 0) * 100);
    setCostDelta((input.costDelta ?? 0) * 100);
  }, []);

  const runScenarioRequest = useCallback(async (body: Record<string, unknown>) => {
    setScenarioLoading(true);
    setScenarioError(null);
    try {
      const res = await fetch('/api/scenarios/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        const msg =
          typeof json.error === 'string'
            ? json.error
            : typeof json.message === 'string'
              ? json.message
              : res.statusText;
        throw new Error(msg);
      }
      setResult(json as ScenarioResultShape);
    } catch (e) {
      setScenarioError(e instanceof Error ? e.message : 'Scenario run failed');
      setResult(null);
    } finally {
      setScenarioLoading(false);
    }
  }, []);

  const handleRunScenario = useCallback(() => {
    void runScenarioRequest({
      label: 'Custom',
      churnRateDelta: churnDelta / 100,
      expansionRateDelta: expansionDelta / 100,
      newBusinessDelta: newBizDelta,
      priceDelta: priceDelta / 100,
      costDelta: costDelta / 100,
    });
  }, [
    churnDelta,
    costDelta,
    expansionDelta,
    newBizDelta,
    priceDelta,
    runScenarioRequest,
  ]);

  const handlePresetClick = useCallback(
    (preset: ScenarioPreset) => {
      const input = preset.input;
      applyPresetToSliders(input);
      void runScenarioRequest({
        label: preset.label,
        churnRateDelta: input.churnRateDelta,
        expansionRateDelta: input.expansionRateDelta,
        newBusinessDelta: input.newBusinessDelta,
        priceDelta: input.priceDelta ?? 0,
        costDelta: input.costDelta ?? 0,
      });
    },
    [applyPresetToSliders, runScenarioRequest],
  );

  const chartData: ProjectionRow[] = useMemo(() => {
    const projections = result?.projections;
    if (!Array.isArray(projections)) return [];
    return projections.map((p) => ({
      month: p.month,
      arr: p.arr ?? 0,
      mrr: (p.arr ?? 0) / 12,
      customers: p.customerCount ?? p.customers ?? 0,
    }));
  }, [result]);

  const impactBarData = useMemo(() => {
    const b = result?.impactBreakdown;
    if (!b) return [];
    return [
      { name: 'Churn', impact: b.churnImpact ?? 0 },
      { name: 'Expansion', impact: b.expansionImpact ?? 0 },
      { name: 'New business', impact: b.newBusinessImpact ?? 0 },
      { name: 'Price', impact: b.priceImpact ?? 0 },
    ];
  }, [result]);

  const baselineArr = useMemo(() => {
    const end = result?.endingARR ?? 0;
    const change = result?.arrChange ?? 0;
    return end - change;
  }, [result]);

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-100">
          Scenario Modeler
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          Adjust drivers and compare projected ARR against baseline
        </p>
      </div>

      {presetsError && (
        <p className="text-sm text-red-400">{presetsError.message}</p>
      )}

      <Card title="Presets">
        {presetsLoading ? (
          <p className="text-sm text-slate-500">Loading presets…</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {(presets ?? []).map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => handlePresetClick(p)}
                className="rounded-lg border border-slate-600 bg-slate-800 px-3 py-1.5 text-left text-xs font-medium text-slate-200 hover:border-blue-500 hover:bg-slate-700/80"
              >
                <span className="block text-slate-100">{p.label}</span>
                <span className="mt-0.5 block font-normal text-slate-500">{p.description}</span>
              </button>
            ))}
          </div>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Inputs">
          <div className="space-y-5">
            <Slider
              label="Churn rate delta"
              min={-5}
              max={5}
              step={0.1}
              value={churnDelta}
              onChange={setChurnDelta}
              unit="%"
            />
            <Slider
              label="Expansion rate delta"
              min={-5}
              max={5}
              step={0.1}
              value={expansionDelta}
              onChange={setExpansionDelta}
              unit="%"
            />
            <Slider
              label="New business delta"
              min={-50000}
              max={50000}
              step={1000}
              value={newBizDelta}
              onChange={setNewBizDelta}
              unit="$"
            />
            <Slider
              label="Price change"
              min={-20}
              max={20}
              step={1}
              value={priceDelta}
              onChange={setPriceDelta}
              unit="%"
            />
            <Slider
              label="Cost change"
              min={-20}
              max={20}
              step={1}
              value={costDelta}
              onChange={setCostDelta}
              unit="%"
            />
            <button
              type="button"
              disabled={scenarioLoading}
              onClick={handleRunScenario}
              className="mt-2 w-full rounded-lg bg-blue-600 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {scenarioLoading ? 'Running…' : 'Run Scenario'}
            </button>
            {scenarioError && (
              <p className="text-xs text-red-400" role="alert">
                {scenarioError}
              </p>
            )}
          </div>
        </Card>

        {result && (
          <Card title="Results">
            <div className="grid gap-3 sm:grid-cols-2">
              <Card title="Baseline ARR" value={formatCurrency(baselineArr)} />
              <Card title="Projected ARR" value={formatCurrency(result.endingARR ?? 0)} />
              <Card title="ARR change" value={formatCurrency(result.arrChange ?? 0)} />
              <Card
                title="ARR change %"
                value={`${(result.arrChangePercent ?? 0).toFixed(2)}%`}
              />
            </div>
            <p className="mt-3 text-xs text-slate-500">
              Scenario: {result.label ?? 'Custom'}
            </p>
          </Card>
        )}
      </div>

      {result && chartData.length > 0 && (
        <Card title="Monthly ARR projection">
          <Chart
            type="area"
            height={320}
            xAxisKey="month"
            data={chartData as unknown as Record<string, unknown>[]}
            series={[{ key: 'arr', label: 'ARR (USD)', color: '#3B82F6' }]}
          />
        </Card>
      )}

      {result && impactBarData.length > 0 && (
        <Card title="Impact breakdown">
          <Chart
            type="bar"
            height={280}
            xAxisKey="name"
            data={impactBarData as unknown as Record<string, unknown>[]}
            series={[{ key: 'impact', label: 'ARR impact (USD)', color: '#A855F7' }]}
          />
        </Card>
      )}
    </div>
  );
}

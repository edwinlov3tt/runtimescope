import { useState, useMemo } from 'react';
import { Topbar } from '@/components/layout/topbar';
import { Gauge, Sparkline, Badge } from '@/components/ui';
import { EmptyConfigState } from '@/components/ui/empty-config-state';
import { useDataStore } from '@/stores/use-data-store';
import { useConnected } from '@/hooks/use-connected';
import { cn } from '@/lib/cn';
import type { PerformanceEvent } from '@/lib/runtime-types';

const METRIC_MAX: Record<string, number> = { LCP: 4000, FCP: 3000, TTFB: 800, CLS: 0.5, FID: 300, INP: 500 };
const METRIC_UNIT: Record<string, string> = { LCP: 'ms', FCP: 'ms', TTFB: 'ms', CLS: '', FID: 'ms', INP: 'ms' };

export function PerformancePage() {
  const [selectedMetric, setSelectedMetric] = useState<string>('LCP');
  const connected = useConnected();
  const initialLoadDone = useDataStore((s) => s.initialLoadDone);
  const livePerformance = useDataStore((s) => s.performance);

  const metrics = useMemo(() => {
    if (livePerformance.length === 0) return [];
    const latest = new Map<string, PerformanceEvent>();
    for (const e of livePerformance) {
      const existing = latest.get(e.metricName);
      if (!existing || e.timestamp > existing.timestamp) latest.set(e.metricName, e);
    }
    return Array.from(latest.values());
  }, [livePerformance]);

  const perfHistory = useMemo(() => {
    if (livePerformance.length === 0) return {};
    const history: Record<string, number[]> = {};
    for (const e of livePerformance) {
      if (!history[e.metricName]) history[e.metricName] = [];
      history[e.metricName].push(e.value);
    }
    return history;
  }, [livePerformance]);

  const selected = metrics.find((e) => e.metricName === selectedMetric);

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <Topbar title="Performance" connected={connected} />

      <div className="flex-1 overflow-y-auto">
        {initialLoadDone && livePerformance.length === 0 ? (
          <EmptyConfigState
            title="No Performance Data"
            description="Performance tracking captures Web Vitals (LCP, FCP, CLS, TTFB, INP) and server metrics (memory, CPU, event loop lag, GC pauses)."
            configHints={[
              { key: 'capturePerformance', value: 'true', description: 'Enable Web Vitals and server metrics' },
            ]}
          />
        ) : (
        <div className="p-6 space-y-6 max-w-6xl mx-auto w-full">
          {/* Gauges grid */}
          <div>
            <h2 className="text-sm font-semibold text-text-primary mb-4">Core Web Vitals</h2>
            <div className="grid grid-cols-6 gap-4">
              {metrics.map((metric) => (
                <button
                  key={metric.metricName}
                  onClick={() => setSelectedMetric(metric.metricName)}
                  className={cn(
                    'bg-bg-elevated border rounded-lg p-4 flex flex-col items-center transition-all cursor-pointer',
                    selectedMetric === metric.metricName
                      ? 'border-brand-border ring-1 ring-brand-border'
                      : 'border-border-default hover:border-border-hover'
                  )}
                >
                  <Gauge
                    value={metric.metricName === 'CLS' ? metric.value : Math.round(metric.value)}
                    max={METRIC_MAX[metric.metricName]}
                    rating={metric.rating}
                    label={metric.metricName}
                    unit={METRIC_UNIT[metric.metricName]}
                  />
                </button>
              ))}
            </div>
          </div>

          {/* History chart for selected metric */}
          {selected && (
            <div className="bg-bg-elevated border border-border-default rounded-lg p-5">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="text-[15px] font-semibold text-text-primary">{selected.metricName} History</h3>
                  <p className="text-[13px] text-text-tertiary mt-0.5">Last 20 measurements</p>
                </div>
                <Badge
                  variant={selected.rating === 'good' ? 'green' : selected.rating === 'needs-improvement' ? 'amber' : 'red'}
                >
                  {selected.rating}
                </Badge>
              </div>
              <Sparkline
                data={perfHistory[selected.metricName] || []}
                width={700}
                height={80}
                color={selected.rating === 'good' ? 'var(--color-green)' : selected.rating === 'needs-improvement' ? 'var(--color-amber)' : 'var(--color-red)'}
              />
              <div className="mt-4 flex items-center gap-6 text-sm">
                <div>
                  <span className="text-text-muted">Current: </span>
                  <span className="text-text-primary font-medium tabular-nums">{selected.value}{METRIC_UNIT[selected.metricName]}</span>
                </div>
                {selected.element && (
                  <div>
                    <span className="text-text-muted">Element: </span>
                    <span className="text-text-secondary font-mono text-[13px]">{selected.element}</span>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  );
}

import { useState, useMemo } from 'react';
import { Gauge, Sparkline, Badge } from '@/components/ui';
import { EmptyConfigState } from '@/components/ui/empty-config-state';
import { useDataStore } from '@/stores/use-data-store';
import { cn } from '@/lib/cn';
import type { PerformanceEvent } from '@/lib/runtime-types';

const METRIC_MAX: Record<string, number> = { LCP: 4000, FCP: 3000, TTFB: 800, CLS: 0.5, FID: 300, INP: 500 };
const METRIC_UNIT: Record<string, string> = { LCP: 'ms', FCP: 'ms', TTFB: 'ms', CLS: '', FID: 'ms', INP: 'ms' };

const METRIC_INFO: Record<string, { name: string; description: string; causes: string[]; goodThreshold: string }> = {
  LCP: {
    name: 'Largest Contentful Paint',
    description: 'Measures how long it takes for the largest visible element (image, heading, or text block) to render. This is the primary metric for perceived load speed.',
    causes: ['Large unoptimized images', 'Render-blocking CSS or JavaScript', 'Slow server response time (TTFB)', 'Client-side rendering delays'],
    goodThreshold: '< 2500ms',
  },
  FCP: {
    name: 'First Contentful Paint',
    description: 'Measures how long it takes for the first piece of content (text, image, or SVG) to appear on screen. Indicates when the user first sees something happening.',
    causes: ['Render-blocking resources (CSS, JS)', 'Large document size', 'Slow DNS or TLS negotiation', 'No server-side rendering or prerendering'],
    goodThreshold: '< 1800ms',
  },
  CLS: {
    name: 'Cumulative Layout Shift',
    description: 'Measures visual stability — how much the page layout shifts unexpectedly while loading. A low CLS means elements don\'t jump around as the page renders.',
    causes: ['Images or ads without dimensions', 'Dynamically injected content above the fold', 'Web fonts causing text reflow (FOIT/FOUT)', 'Late-loading CSS changing layout'],
    goodThreshold: '< 0.1',
  },
  TTFB: {
    name: 'Time to First Byte',
    description: 'Measures the time from the request to when the first byte of the response arrives. Reflects server processing speed and network latency.',
    causes: ['Slow database queries on the server', 'No CDN or edge caching', 'Server-side computation bottlenecks', 'Geographic distance to the server'],
    goodThreshold: '< 200ms',
  },
  FID: {
    name: 'First Input Delay',
    description: 'Measures the delay between a user\'s first interaction (click, tap, key press) and the browser\'s response. High FID means the main thread was busy when the user tried to interact.',
    causes: ['Heavy JavaScript execution during page load', 'Long tasks blocking the main thread', 'Third-party scripts competing for CPU', 'Large bundle parsing and compilation'],
    goodThreshold: '< 100ms',
  },
  INP: {
    name: 'Interaction to Next Paint',
    description: 'Measures the latency of all user interactions throughout the page\'s lifecycle, not just the first one. The worst interaction latency is reported. This replaced FID as a Core Web Vital in 2024.',
    causes: ['Expensive event handlers (click, input, keydown)', 'Synchronous layout/style recalculation (forced reflows)', 'Long-running JavaScript blocking the main thread', 'Excessive DOM size slowing updates'],
    goodThreshold: '< 200ms',
  },
};

export function PerformancePage() {
  const [selectedMetric, setSelectedMetric] = useState<string>('LCP');
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
                      ? 'border-accent-border ring-1 ring-brand-border'
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

          {/* Metric description */}
          {selected && METRIC_INFO[selected.metricName] && (
            <div className="bg-bg-elevated border border-border-default rounded-lg p-5">
              <div className="flex items-start justify-between gap-4 mb-3">
                <div>
                  <h3 className="text-[15px] font-semibold text-text-primary">
                    {METRIC_INFO[selected.metricName].name}
                  </h3>
                  <span className="text-[11px] text-text-tertiary">
                    Good: {METRIC_INFO[selected.metricName].goodThreshold}
                  </span>
                </div>
              </div>
              <p className="text-[13px] text-text-secondary leading-relaxed mb-4">
                {METRIC_INFO[selected.metricName].description}
              </p>
              <div>
                <p className="text-[11px] font-medium text-text-muted uppercase tracking-wider mb-2">
                  Common causes of poor scores
                </p>
                <ul className="space-y-1.5">
                  {METRIC_INFO[selected.metricName].causes.map((cause) => (
                    <li key={cause} className="flex items-start gap-2 text-[13px] text-text-secondary">
                      <span className="text-text-tertiary mt-0.5 shrink-0">&bull;</span>
                      {cause}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
        )}
      </div>
    </div>
  );
}

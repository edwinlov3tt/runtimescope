import { useState } from 'react';
import { LineChart, BarChart, Heatmap, DonutChart, FunnelChart, ChartPanel, EmptyState, paletteAt, type LineSeries, type BarGroup } from '@/components/ui';
import { CardsSkeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/cn';
import { fetchTrends, fetchFeatureTrends, fetchCohorts, fetchFunnel, fetchEventMix } from '@/lib/analytics-api';
import { AnalyticsLayout, AnalyticsToolbar, WindowPills, useAnalytics, bucketLabel } from './_shared';

const TREND_WINDOWS = [
  { id: '30d', label: '30d' },
  { id: '90d', label: '90d' },
  { id: 'all', label: 'All' },
];
const kfmt = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v));

export function AnalyticsTrendsPage() {
  const [win, setWin] = useState('90d');
  const [metric, setMetric] = useState<'users' | 'events'>('users');
  const { data: trends, loading } = useAnalytics(() => fetchTrends(win, 12), [win]);
  const { data: ft } = useAnalytics(() => fetchFeatureTrends(win, 12, 4), [win]);
  const { data: cohorts } = useAnalytics(() => fetchCohorts(8), []);
  const { data: funnel } = useAnalytics(() => fetchFunnel(), []);
  const { data: mix } = useAnalytics(() => fetchEventMix(win), [win]);

  if (loading || !trends) {
    return (
      <AnalyticsLayout>
        <CardsSkeleton count={2} />
      </AnalyticsLayout>
    );
  }

  const labels = trends.bucketStartMs.map(bucketLabel);
  const mainSeries: LineSeries[] =
    metric === 'users'
      ? [{ name: 'Active users', color: 'var(--color-accent)', data: trends.users, area: true }]
      : [{ name: 'Events', color: 'var(--color-blue)', data: trends.events, area: true }];

  const ftGroups: BarGroup[] = (ft?.bucketStartMs ?? []).map((ms, bi) => ({
    label: bucketLabel(ms),
    segs: (ft?.series ?? []).map((s, si) => ({ value: s.data[bi] ?? 0, color: s.feature === 'other' ? 'var(--color-border-hover)' : paletteAt(si) })),
  }));

  const maxCells = Math.max(0, ...(cohorts ?? []).map((c) => c.cells.length));
  const colLabels = Array.from({ length: maxCells }, (_, i) => `W${i}`);
  const heatRows = (cohorts ?? []).map((c) => ({ label: bucketLabel(c.cohortStartMs), size: c.size, cells: c.cells }));
  const mixTotal = (mix ?? []).reduce((a, m) => a + m.count, 0);

  const metricToggle = (
    <div className="inline-flex bg-bg-elevated border border-border-default rounded-md p-0.5 gap-0.5">
      {(['users', 'events'] as const).map((m) => (
        <button key={m} type="button" onClick={() => setMetric(m)} className={cn('px-2.5 py-1 text-[11px] font-medium rounded-sm cursor-pointer', metric === m ? 'bg-bg-overlay text-text-primary' : 'text-text-tertiary hover:text-text-secondary')}>
          {m === 'users' ? 'Active Users' : 'Events'}
        </button>
      ))}
    </div>
  );

  return (
    <AnalyticsLayout toolbar={<AnalyticsToolbar left={<><WindowPills value={win} onChange={setWin} options={TREND_WINDOWS} />{metricToggle}</>} />}>
      <ChartPanel title={metric === 'users' ? 'Active Users over time' : 'Event volume over time'} right={<span className="text-[11px] text-text-muted">{labels.length} buckets</span>}>
        <LineChart series={mainSeries} labels={labels} height={260} yFmt={kfmt} />
        {/* TODO(analytics-3a): cumulative VALUE ($) series — ROI not exposed by /trends. */}
        {/* TODO(analytics-annotations): deploy vlines + goal hlines — no annotations source. */}
      </ChartPanel>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <ChartPanel title="Events by Feature" className="lg:col-span-2">
          {ftGroups.length ? <BarChart groups={ftGroups} height={200} yFmt={kfmt} /> : <EmptyState title="No feature events in window" />}
        </ChartPanel>
        <ChartPanel title="Activation Funnel">
          {funnel ? (
            <FunnelChart
              steps={[
                { label: 'Identified', value: funnel.identified, color: 'var(--color-blue)' },
                { label: 'Activated', value: funnel.activated, color: 'var(--color-accent)' },
                { label: 'Repeat', value: funnel.repeat, color: 'var(--color-green)' },
                { label: 'Power', value: funnel.power, color: 'var(--color-purple)' },
              ]}
            />
          ) : (
            <EmptyState title="No funnel data" />
          )}
        </ChartPanel>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <ChartPanel title="Weekly Retention by Cohort" className="lg:col-span-2">
          {heatRows.length ? <Heatmap rows={heatRows} colLabels={colLabels} /> : <EmptyState title="Not enough cohort data yet" description="Retention needs a few weeks of identified-user activity." />}
        </ChartPanel>
        <ChartPanel title="Event Mix" right={<span className="text-[11px] text-text-muted">{mixTotal.toLocaleString()}</span>}>
          {mix && mix.length ? <DonutChart legend centerVal={kfmt(mixTotal)} centerLabel="events" segments={mix.map((m, i) => ({ label: m.type, value: m.count, color: paletteAt(i) }))} /> : <EmptyState title="No events" />}
        </ChartPanel>
      </div>
    </AnalyticsLayout>
  );
}

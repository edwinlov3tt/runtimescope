import { useState } from 'react';
import { KpiRow, type KpiSpec, FunnelChart, DonutChart, ChartPanel, EmptyState, paletteAt } from '@/components/ui';
import { CardsSkeleton } from '@/components/ui/skeleton';
import { UserCheck, TrendingUp, Clock, DollarSign, Flame, Repeat } from 'lucide-react';
import { fetchOverview, fetchFunnel, fetchEventMix } from '@/lib/analytics-api';
import { AnalyticsLayout, AnalyticsToolbar, WindowPills, useAnalytics, fmtMoney, fmtHours } from './_shared';

export function AnalyticsOverviewPage() {
  const [win, setWin] = useState('30d');
  const { data: ov, loading } = useAnalytics(() => fetchOverview(win), [win]);
  const { data: funnel } = useAnalytics(() => fetchFunnel(), []);
  const { data: mix } = useAnalytics(() => fetchEventMix(win), [win]);

  if (loading || !ov) {
    return (
      <AnalyticsLayout>
        <CardsSkeleton count={4} />
      </AnalyticsLayout>
    );
  }

  // KPI pool. Scalars only (no spark/delta) → TODO(analytics-kpi-spark).
  const pool: Record<string, KpiSpec> = {
    activeUsers: { icon: UserCheck, label: 'Active Users', value: String(ov.activeUsers), footerLabel: `DAU ${ov.dau} · MAU ${ov.mau}` },
    adoption: { icon: TrendingUp, label: 'Adoption Rate', value: String(ov.adoptionPct), unit: '%', footerLabel: `${ov.activeUsers} of ${ov.invited} invited` },
    // TODO(analytics-3a): hours/value are ROI ($), 0 until baselines+roles+identify exist.
    hours: { icon: Clock, label: 'Hours Saved', value: fmtHours(ov.hoursSaved), unit: 'hrs', footerLabel: 'ROI estimate' },
    value: { icon: DollarSign, label: 'Value Saved', value: fmtMoney(ov.valueSaved), footerLabel: 'Baseline × rate' },
    stickiness: { icon: Repeat, label: 'WAU / MAU', value: String(ov.stickinessPct), unit: '%', footerLabel: 'Stickiness' },
    events: { icon: Flame, label: 'Events / day', value: String(ov.eventsPerDay), footerLabel: `${ov.totalEvents.toLocaleString()} total` },
  };

  const roleRows = (ov.valueByRole ?? []).slice().sort((a, b) => b.value - a.value);
  const maxRoleVal = Math.max(1, ...roleRows.map((r) => r.value));
  const mixTotal = (mix ?? []).reduce((a, m) => a + m.count, 0);

  return (
    <AnalyticsLayout toolbar={<AnalyticsToolbar left={<WindowPills value={win} onChange={setWin} />} />}>
      <KpiRow pool={pool} active={['activeUsers', 'adoption', 'hours', 'value']} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <ChartPanel title="Activation Funnel">
          {funnel ? (
            <FunnelChart
              steps={[
                { label: 'Identified', value: funnel.identified, color: 'var(--color-blue)' },
                { label: 'Activated', value: funnel.activated, color: 'var(--color-accent)' },
                { label: 'Repeat (2+ sessions)', value: funnel.repeat, color: 'var(--color-green)' },
                { label: 'Power user (weekly)', value: funnel.power, color: 'var(--color-purple)' },
              ]}
            />
          ) : (
            <EmptyState title="No funnel data" />
          )}
        </ChartPanel>

        <ChartPanel title="Value by Role" right={<span className="text-[11px] text-text-muted">{fmtMoney(ov.valueSaved)} · {fmtHours(ov.hoursSaved)}h</span>}>
          {roleRows.length ? (
            <div className="space-y-2.5">
              {roleRows.map((r) => (
                <div key={r.role}>
                  <div className="flex items-baseline justify-between mb-1">
                    <span className="text-xs text-text-secondary">{r.role}</span>
                    <span className="text-xs font-mono">{fmtMoney(r.value)} · {fmtHours(r.hours)}h</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-bg-overlay overflow-hidden">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round((r.value / maxRoleVal) * 100)}%` }} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            // TODO(analytics-3a): value-by-role needs ROI ($) — empty until baselines+roles set.
            <EmptyState title="No ROI configured" description="Set baselines + role rates to attribute $ value per role." />
          )}
        </ChartPanel>

        <ChartPanel title="Event Mix" right={<span className="text-[11px] text-text-muted">{mixTotal.toLocaleString()} events</span>}>
          {mix && mix.length ? (
            <DonutChart legend centerVal={mixTotal >= 1000 ? `${(mixTotal / 1000).toFixed(1)}k` : String(mixTotal)} centerLabel="events" segments={mix.map((m, i) => ({ label: m.type, value: m.count, color: paletteAt(i) }))} />
          ) : (
            <EmptyState title="No events in window" />
          )}
        </ChartPanel>
      </div>
    </AnalyticsLayout>
  );
}

import { useState } from 'react';
import { DataTable, EmptyState, Badge, KpiRow, type KpiSpec } from '@/components/ui';
import { TableSkeleton } from '@/components/ui/skeleton';
import { ExportButton } from '@/components/ui/export-button';
import { Boxes, Flame, Trophy, Activity, Database, DollarSign } from 'lucide-react';
import { fetchFeatures } from '@/lib/analytics-api';
import type { FeatureRollup } from '@/lib/analytics-types';
import { AnalyticsLayout, AnalyticsToolbar, WindowPills, useAnalytics, fmtMoney, fmtHours, relTime } from './_shared';

type BadgeVariant = 'green' | 'blue' | 'amber';
function statusFor(adoption: number): { label: string; variant: BadgeVariant } {
  if (adoption >= 50) return { label: 'core', variant: 'green' };
  if (adoption >= 25) return { label: 'growing', variant: 'blue' };
  return { label: 'niche', variant: 'amber' };
}

export function AnalyticsFeaturesPage() {
  const [win, setWin] = useState('30d');
  const { data, loading } = useAnalytics(() => fetchFeatures(win), [win]);
  const features = data ?? [];

  const totalEvents = features.reduce((a, f) => a + f.events, 0);
  const totalValue = features.reduce((a, f) => a + f.value, 0);
  const top = [...features].sort((a, b) => b.value - a.value)[0];
  const mostUsed = [...features].sort((a, b) => b.events - a.events)[0];
  const avgAdoption = features.length ? Math.round(features.reduce((a, f) => a + f.adoptionPct, 0) / features.length) : 0;

  // KPI pool — endpoints return scalars (no spark/delta) → TODO(analytics-kpi-spark).
  const pool: Record<string, KpiSpec> = {
    tracked: { icon: Boxes, label: 'Tracked Features', value: String(features.length), footerLabel: 'In window' },
    mostUsed: { icon: Flame, label: 'Most Used', value: mostUsed?.feature ?? '—', footerLabel: mostUsed ? `${mostUsed.events.toLocaleString()} events` : '' },
    highestRoi: { icon: Trophy, label: 'Highest ROI', value: top?.feature ?? '—', footerLabel: top ? fmtMoney(top.value) : '' },
    avgAdoption: { icon: Activity, label: 'Avg Adoption', value: String(avgAdoption), unit: '%', footerLabel: 'Of active users' },
    totalEvents: { icon: Database, label: 'Total Events', value: totalEvents.toLocaleString(), footerLabel: 'All features' },
    totalValue: { icon: DollarSign, label: 'Value Saved', value: fmtMoney(totalValue), footerLabel: 'All features' },
  };

  if (loading) {
    return (
      <AnalyticsLayout>
        <TableSkeleton rows={8} />
      </AnalyticsLayout>
    );
  }

  const columns = [
    { key: 'feature', header: 'Feature', mono: true },
    { key: 'users', header: 'Users', align: 'right' as const, mono: true, sortable: true },
    { key: 'events', header: 'Events', align: 'right' as const, mono: true, sortable: true, render: (f: FeatureRollup) => f.events.toLocaleString() },
    { key: 'adoptionPct', header: 'Adoption', align: 'right' as const, mono: true, sortable: true, render: (f: FeatureRollup) => `${f.adoptionPct}%` },
    // TODO(analytics-3a): hours/value are ROI ($) — 0 until baselines+roles+identify data exist.
    { key: 'hours', header: 'Hours', align: 'right' as const, mono: true, render: (f: FeatureRollup) => fmtHours(f.hours) },
    { key: 'value', header: 'Value', align: 'right' as const, mono: true, render: (f: FeatureRollup) => fmtMoney(f.value) },
    { key: 'lastSeen', header: 'Last Seen', render: (f: FeatureRollup) => relTime(f.lastSeen) },
    {
      key: 'status',
      header: 'Status',
      render: (f: FeatureRollup) => {
        const s = statusFor(f.adoptionPct);
        return <Badge variant={s.variant}>{s.label}</Badge>;
      },
    },
  ];

  return (
    <AnalyticsLayout
      toolbar={<AnalyticsToolbar left={<WindowPills value={win} onChange={setWin} />} right={<ExportButton data={features as unknown as Record<string, unknown>[]} filename="analytics-features.csv" />} />}
    >
      <KpiRow pool={pool} active={['tracked', 'mostUsed', 'highestRoi', 'avgAdoption']} />
      <div className="rounded-lg border border-border-strong bg-bg-surface overflow-hidden">
        <div className="px-4 py-2.5 border-b border-border-muted flex items-center justify-between">
          <span className="text-[13px] font-semibold">Feature Adoption</span>
          <span className="text-[11px] text-text-muted">{features.length} features</span>
        </div>
        {features.length === 0 ? (
          <EmptyState title="No feature usage yet" description="Once your app calls RuntimeScope.track(...) with identified users, per-feature adoption shows up here." />
        ) : (
          <DataTable columns={columns as any} data={features as any} defaultSort={{ key: 'events', direction: 'desc' }} />
        )}
      </div>
    </AnalyticsLayout>
  );
}

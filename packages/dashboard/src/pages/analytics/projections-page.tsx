import { DataTable, EmptyState, BarChart, ChartPanel, KpiRow, type KpiSpec, type BarGroup } from '@/components/ui';
import { TableSkeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/cn';
import { Target, Clock, DollarSign, Flag } from 'lucide-react';
import { fetchProjections } from '@/lib/analytics-api';
import type { Projection } from '@/lib/analytics-types';
import { AnalyticsLayout, AnalyticsToolbar, useAnalytics, fmtMoney, fmtHours } from './_shared';

export function AnalyticsProjectionsPage() {
  const { data, loading } = useAnalytics(() => fetchProjections(), []);
  const projections = data ?? [];
  const current = projections[0];

  const groups: BarGroup[] = projections
    .slice()
    .reverse()
    .map((p) => ({
      label: p.quarter.split(' ')[0],
      segs: [
        { value: p.projHours, color: 'var(--color-border-hover)' },
        { value: p.actualHours, color: 'var(--color-accent)' },
      ],
    }));

  // Actuals are live-derived (ROI over each quarter) → TODO(analytics-3a) until configured.
  const pool: Record<string, KpiSpec> = current
    ? {
        targetHours: { icon: Target, label: 'Target Hours', value: fmtHours(current.projHours), footerLabel: current.quarter },
        actualHours: { icon: Clock, label: 'Actual Hours', value: fmtHours(current.actualHours), footerLabel: current.projHours ? `${Math.round((current.actualHours / current.projHours) * 100)}% of goal` : '' },
        projValue: { icon: DollarSign, label: 'Projected Value', value: fmtMoney(current.projValue), footerLabel: 'Target' },
        actualValue: { icon: DollarSign, label: 'Actual Value', value: fmtMoney(current.actualValue), footerLabel: current.projValue ? `${Math.round((current.actualValue / current.projValue) * 100)}% of goal` : '' },
        toGoal: { icon: Flag, label: '% to Goal', value: current.projHours ? String(Math.round((current.actualHours / current.projHours) * 100)) : '0', unit: '%', footerLabel: 'Hours vs target' },
      }
    : {};

  if (loading) {
    return (
      <AnalyticsLayout>
        <TableSkeleton rows={6} />
      </AnalyticsLayout>
    );
  }

  if (!projections.length) {
    return (
      <AnalyticsLayout>
        <EmptyState title="No projections set" description="Managers set quarterly hour/value targets; actuals are computed live from baselines × usage. The POST form isn't built in this UI yet." />
      </AnalyticsLayout>
    );
  }

  const columns = [
    { key: 'quarter', header: 'Quarter' },
    { key: 'projHours', header: 'Proj. Hours', align: 'right' as const, mono: true, render: (p: Projection) => fmtHours(p.projHours) },
    // TODO(analytics-3a): actuals depend on ROI.
    { key: 'actualHours', header: 'Actual', align: 'right' as const, mono: true, render: (p: Projection) => fmtHours(p.actualHours) },
    { key: 'projValue', header: 'Proj. Value', align: 'right' as const, mono: true, render: (p: Projection) => fmtMoney(p.projValue) },
    { key: 'actualValue', header: 'Actual', align: 'right' as const, mono: true, render: (p: Projection) => fmtMoney(p.actualValue) },
    {
      key: 'variance',
      header: 'Variance',
      align: 'right' as const,
      mono: true,
      render: (p: Projection) => {
        const v = p.actualValue - p.projValue;
        const pct = p.projValue ? Math.round((v / p.projValue) * 100) : 0;
        return <span className={cn('font-mono', pct >= 0 ? 'text-green' : 'text-red')}>{pct >= 0 ? '+' : ''}{pct}%</span>;
      },
    },
  ];

  return (
    <AnalyticsLayout toolbar={<AnalyticsToolbar left={<span className="text-[13px] font-semibold">Projections</span>} />}>
      {/* TODO(analytics-3b): forward forecast line (fitted model) — Mosaic sidecar, not wired. */}
      <KpiRow pool={pool} active={['targetHours', 'actualHours', 'projValue', 'actualValue']} />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 rounded-lg border border-border-strong bg-bg-surface overflow-hidden">
          <div className="px-4 py-2.5 border-b border-border-muted text-[13px] font-semibold">Quarterly detail</div>
          <DataTable columns={columns as any} data={projections as any} />
        </div>
        <ChartPanel title="Projected vs Actual hours" right={<span className="text-[11px] text-text-muted">proj · actual</span>}>
          {groups.length ? <BarChart grouped groups={groups} height={210} yFmt={(v) => fmtHours(v)} /> : <EmptyState title="No data" />}
        </ChartPanel>
      </div>
    </AnalyticsLayout>
  );
}

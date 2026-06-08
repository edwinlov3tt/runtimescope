import { useState, useCallback } from 'react';
import { DataTable, EmptyState, Badge, KpiRow, type KpiSpec, Button } from '@/components/ui';
import { TableSkeleton } from '@/components/ui/skeleton';
import { DollarSign, Scale, MessageSquareWarning, Clock } from 'lucide-react';
import { fetchBaselines, fetchSubmissions, acceptSubmission, dismissSubmission } from '@/lib/analytics-api';
import type { Baseline } from '@/lib/analytics-types';
import { AnalyticsLayout, AnalyticsToolbar, useAnalytics, fmtMoney } from './_shared';

export function AnalyticsBaselinesPage() {
  const [refreshKey, setRefreshKey] = useState(0);
  const { data: baselines, loading } = useAnalytics(() => fetchBaselines(), [refreshKey]);
  const { data: subs } = useAnalytics(() => fetchSubmissions(), [refreshKey]);
  const bl = baselines ?? [];
  const submissions = subs ?? [];

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  const onAccept = useCallback(async (id: number) => { await acceptSubmission(id); refresh(); }, [refresh]);
  const onDismiss = useCallback(async (id: number) => { await dismissSubmission(id); refresh(); }, [refresh]);

  const totalValue = bl.reduce((a, b) => a + b.value, 0);
  const avgSaved = bl.length ? (bl.reduce((a, b) => a + (b.manualMin - b.toolMin), 0) / bl.length).toFixed(1) : '0';

  const pool: Record<string, KpiSpec> = {
    // TODO(analytics-3a): value is ROI ($) over the events × baselines.
    value: { icon: DollarSign, label: 'Value Attributed', value: fmtMoney(totalValue), footerLabel: 'All baselines' },
    avgTime: { icon: Clock, label: 'Avg Saved / Use', value: avgSaved, unit: 'min', footerLabel: 'manual − tool' },
    defined: { icon: Scale, label: 'Baselines Defined', value: String(bl.length), footerLabel: `${bl.filter((b) => b.source === 'crowd').length} crowdsourced` },
    pending: { icon: MessageSquareWarning, label: 'Pending Submissions', value: String(submissions.length), footerLabel: `${submissions.filter((s) => s.flagged).length} flagged >20%` },
  };

  if (loading) {
    return (
      <AnalyticsLayout>
        <TableSkeleton rows={8} />
      </AnalyticsLayout>
    );
  }

  const columns = [
    { key: 'fn', header: 'Function', mono: true },
    { key: 'manualMin', header: 'Manual', align: 'right' as const, mono: true, render: (b: Baseline) => `${b.manualMin.toFixed(1)}m` },
    { key: 'toolMin', header: 'Tool', align: 'right' as const, mono: true, render: (b: Baseline) => `${b.toolMin.toFixed(1)}m` },
    { key: 'perItem', header: 'Per-item', render: (b: Baseline) => (b.perItem ? <Badge variant="blue">on</Badge> : <span className="text-text-muted">—</span>) },
    { key: 'uses', header: 'Uses', align: 'right' as const, mono: true, render: (b: Baseline) => b.uses.toLocaleString() },
    // TODO(analytics-3a): value = ROI ($).
    { key: 'value', header: 'Value', align: 'right' as const, mono: true, render: (b: Baseline) => fmtMoney(b.value) },
    { key: 'source', header: 'Source', render: (b: Baseline) => <Badge variant={b.source === 'crowd' ? 'purple' : 'blue'}>{b.source}</Badge> },
  ];

  return (
    <AnalyticsLayout toolbar={<AnalyticsToolbar left={<span className="text-[13px] font-semibold">Baselines · ROI</span>} />}>
      {/* TODO(analytics-3a): $ value depends on ROI. Inline edit (PUT) / New baseline composer not built in this UI yet (the GET/PUT routes exist). */}
      <KpiRow pool={pool} active={['value', 'avgTime', 'defined', 'pending']} />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 rounded-lg border border-border-strong bg-bg-surface overflow-hidden">
          <div className="px-4 py-2.5 border-b border-border-muted text-[13px] font-semibold">Baselines</div>
          {bl.length ? (
            <DataTable columns={columns as any} data={bl as any} defaultSort={{ key: 'uses', direction: 'desc' }} />
          ) : (
            <EmptyState title="No baselines defined" description="Baselines set manual-vs-tool minutes per function; ROI $ is computed from them × usage × role rates." />
          )}
        </div>
        <div className="rounded-lg border border-border-strong bg-bg-surface overflow-hidden">
          <div className="px-4 py-2.5 border-b border-border-muted flex items-center justify-between">
            <span className="text-[13px] font-semibold">Crowd Submissions</span>
            <Badge variant="amber">{submissions.length}</Badge>
          </div>
          {submissions.length ? (
            <div className="divide-y divide-border-muted">
              {submissions.map((s) => (
                <div key={s.id} className="p-3.5">
                  <div className="text-[12px] font-mono text-text-secondary mb-1">{s.fn}</div>
                  <div className="flex items-center justify-between text-[11px] mb-2">
                    <span className="text-text-tertiary">
                      est <span className="font-mono text-text-secondary">{s.estManualMin}m</span> vs <span className="font-mono">{s.currentManualMin ?? '—'}m</span>
                    </span>
                    {s.flagged && <Badge variant="amber">+{s.diffPct}% off</Badge>}
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => onAccept(s.id)}>Accept</Button>
                    <Button size="sm" variant="ghost" onClick={() => onDismiss(s.id)}>Dismiss</Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="No submissions" />
          )}
        </div>
      </div>
    </AnalyticsLayout>
  );
}

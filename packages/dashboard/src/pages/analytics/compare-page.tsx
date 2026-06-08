import { useState } from 'react';
import { DataTable, EmptyState, BarChart, ChartPanel, type BarGroup } from '@/components/ui';
import { TableSkeleton } from '@/components/ui/skeleton';
import { ExportButton } from '@/components/ui/export-button';
import { cn } from '@/lib/cn';
import { fetchCompare } from '@/lib/analytics-api';
import type { CompareRow } from '@/lib/analytics-types';
import { AnalyticsLayout, AnalyticsToolbar, WindowPills, useAnalytics, fmtMoney } from './_shared';

function Delta({ cur, prev }: { cur: number; prev: number }) {
  if (!prev) return <span className="text-text-muted text-[11px] font-mono">—</span>;
  const pct = Math.round(((cur - prev) / Math.abs(prev)) * 100);
  const cls = pct > 0 ? 'text-green' : pct < 0 ? 'text-red' : 'text-text-muted';
  return <span className={cn('text-[11px] font-mono font-semibold', cls)}>{pct > 0 ? '▲' : pct < 0 ? '▼' : '–'} {Math.abs(pct)}%</span>;
}

export function AnalyticsComparePage() {
  const [by, setBy] = useState<'role' | 'app'>('role');
  const [win, setWin] = useState('30d');
  const { data, loading } = useAnalytics(() => fetchCompare(by, win), [by, win]);
  const rows = data ?? [];
  const keyOf = (r: CompareRow) => r.role ?? r.app ?? '—';

  const groups: BarGroup[] = rows.map((r) => ({
    label: keyOf(r),
    segs: [
      { value: r.value, color: 'var(--color-accent)' },
      { value: r.prevValue, color: 'var(--color-border-hover)' },
    ],
  }));

  const modeToggle = (
    <div className="inline-flex bg-bg-elevated border border-border-default rounded-md p-0.5 gap-0.5">
      {(['role', 'app'] as const).map((m) => (
        <button key={m} type="button" onClick={() => setBy(m)} className={cn('px-2.5 py-1 text-[11px] font-medium rounded-sm cursor-pointer', by === m ? 'bg-bg-overlay text-text-primary' : 'text-text-tertiary hover:text-text-secondary')}>
          {m === 'role' ? 'Roles' : 'Apps'}
        </button>
      ))}
    </div>
  );

  if (loading) {
    return (
      <AnalyticsLayout>
        <TableSkeleton rows={6} />
      </AnalyticsLayout>
    );
  }

  const columns = [
    { key: 'entity', header: by === 'role' ? 'Role' : 'App', render: (r: CompareRow) => keyOf(r) },
    { key: 'users', header: 'Users', align: 'right' as const, mono: true, sortable: true },
    { key: 'du', header: '', render: (r: CompareRow) => <Delta cur={r.users} prev={r.prevUsers} /> },
    { key: 'events', header: 'Events', align: 'right' as const, mono: true, render: (r: CompareRow) => r.events.toLocaleString() },
    { key: 'de', header: '', render: (r: CompareRow) => <Delta cur={r.events} prev={r.prevEvents} /> },
    // TODO(analytics-3a): value is ROI ($).
    { key: 'value', header: 'Value', align: 'right' as const, mono: true, render: (r: CompareRow) => fmtMoney(r.value) },
    { key: 'dv', header: '', render: (r: CompareRow) => <Delta cur={r.value} prev={r.prevValue} /> },
  ];

  return (
    <AnalyticsLayout
      toolbar={<AnalyticsToolbar left={<>{modeToggle}<WindowPills value={win} onChange={setWin} /></>} right={<ExportButton data={rows as unknown as Record<string, unknown>[]} filename={`analytics-compare-${by}.csv`} />} />}
    >
      {/* TODO(analytics-3b): narrative "insight" line (top / most-improved / declining) — Mosaic sidecar, not wired. */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <ChartPanel title={`Current vs prior · by ${by}`} className="lg:col-span-2">
          {rows.length ? (
            <DataTable columns={columns as any} data={rows as any} defaultSort={{ key: 'value', direction: 'desc' }} />
          ) : (
            <EmptyState title="No comparison data" description="Compares the current window to the prior one — needs identified-user events in both." />
          )}
        </ChartPanel>
        <ChartPanel title="Value: current vs prior" right={<span className="text-[11px] text-text-muted">current · prior</span>}>
          {groups.length ? <BarChart grouped groups={groups} height={210} yFmt={(v) => fmtMoney(v)} valueFmt={(v) => fmtMoney(v)} /> : <EmptyState title="No data" />}
        </ChartPanel>
      </div>
    </AnalyticsLayout>
  );
}

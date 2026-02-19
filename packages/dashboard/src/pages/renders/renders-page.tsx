import { useState, useMemo } from 'react';
import { Topbar } from '@/components/layout/topbar';
import { DataTable, DetailPanel, Badge, StatusDot, Sparkline, Tabs } from '@/components/ui';
import { SearchInput } from '@/components/ui/input';
import { MOCK_RENDER_PROFILES, MOCK_RENDER_TIMELINE } from '@/mock/renders';
import { useDataStore } from '@/stores/use-data-store';
import { useConnected } from '@/hooks/use-connected';
import { cn } from '@/lib/cn';
import type { RenderComponentProfile } from '@/mock/types';

const CAUSE_COLORS: Record<string, string> = {
  props: 'var(--color-blue)', state: 'var(--color-green)', context: 'var(--color-purple)', parent: 'var(--color-amber)', unknown: 'var(--color-text-muted)',
};

export function RendersPage() {
  const [search, setSearch] = useState('');
  const [detailIndex, setDetailIndex] = useState<number | null>(null);
  const connected = useConnected();
  const source = useDataStore((s) => s.source);
  const liveRenders = useDataStore((s) => s.renders);

  // In live mode, flatten profiles from all render events; in mock mode use static data
  const profiles = useMemo(() => {
    if (source !== 'live' || liveRenders.length === 0) return MOCK_RENDER_PROFILES;
    const map = new Map<string, RenderComponentProfile>();
    for (const event of liveRenders) {
      for (const p of event.profiles) {
        const existing = map.get(p.componentName);
        if (!existing || p.renderCount > existing.renderCount) {
          map.set(p.componentName, p);
        }
      }
    }
    return Array.from(map.values());
  }, [source, liveRenders]);

  const timeline = useMemo(() => {
    if (source !== 'live' || liveRenders.length === 0) return MOCK_RENDER_TIMELINE;
    return liveRenders.map((e) => e.totalRenders);
  }, [source, liveRenders]);

  const filtered = useMemo(() => {
    if (!search) return profiles;
    const q = search.toLowerCase();
    return profiles.filter((p) => p.componentName.toLowerCase().includes(q));
  }, [search, profiles]);

  const selected = detailIndex !== null ? filtered[detailIndex] : null;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <Topbar title="Renders" connected={connected} />

      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Timeline sparkline */}
          <div className="px-5 py-3 border-b border-border-default">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-medium text-text-muted uppercase tracking-wider">Render Timeline (5 min)</span>
              <span className="text-[11px] text-text-tertiary tabular-nums">{profiles.reduce((s, p) => s + p.renderCount, 0)} total renders</span>
            </div>
            <Sparkline data={timeline} width={800} height={40} color="var(--color-purple)" />
          </div>

          {/* Search */}
          <div className="px-5 py-2.5 border-b border-border-default">
            <div className="w-64">
              <SearchInput value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter components..." />
            </div>
          </div>

          {/* Table */}
          <div className="flex-1 overflow-auto">
            <DataTable
              columns={[
                {
                  key: 'componentName', header: 'Component', width: '200px',
                  render: (row) => (
                    <span className="flex items-center gap-2">
                      {(row as any).suspicious && <StatusDot color="amber" size="sm" pulse />}
                      <span className="font-medium">{row.componentName as string}</span>
                    </span>
                  ),
                },
                { key: 'renderCount', header: 'Renders', width: '100px', render: (row) => <span className="tabular-nums">{row.renderCount as number}</span> },
                { key: 'avgDuration', header: 'Avg (ms)', width: '100px', render: (row) => <span className="tabular-nums">{(row.avgDuration as number).toFixed(1)}</span> },
                {
                  key: 'lastRenderCause', header: 'Cause', width: '100px',
                  render: (row) => {
                    const cause = (row.lastRenderCause || 'unknown') as string;
                    const colors: Record<string, string> = { props: 'blue', state: 'green', context: 'purple', parent: 'amber' };
                    return <Badge variant={(colors[cause] || 'default') as any} size="sm">{cause}</Badge>;
                  },
                },
                {
                  key: 'renderVelocity', header: 'Velocity/min', width: '120px',
                  render: (row) => {
                    const v = row.renderVelocity as number;
                    return <span className={cn('tabular-nums', v > 10 ? 'text-amber' : 'text-text-secondary')}>{v.toFixed(1)}</span>;
                  },
                },
                { key: 'lastRenderPhase', header: 'Phase', width: '80px' },
              ]}
              data={filtered as any}
              selectedIndex={detailIndex ?? undefined}
              onRowClick={(_, i) => setDetailIndex(i)}
              defaultSort={{ key: 'renderCount', direction: 'desc' }}
            />
          </div>
        </div>

        <DetailPanel
          open={selected !== null}
          onClose={() => setDetailIndex(null)}
          title={selected?.componentName}
          subtitle={selected ? `${selected.renderCount} renders · ${selected.avgDuration.toFixed(1)}ms avg` : ''}
        >
          {selected && (
            <div className="p-4 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-bg-elevated rounded-md p-3 border border-border-muted">
                  <p className="text-[11px] text-text-muted mb-1">Total Duration</p>
                  <p className="text-lg font-bold tabular-nums">{selected.totalDuration.toFixed(0)}ms</p>
                </div>
                <div className="bg-bg-elevated rounded-md p-3 border border-border-muted">
                  <p className="text-[11px] text-text-muted mb-1">Velocity</p>
                  <p className={cn('text-lg font-bold tabular-nums', selected.renderVelocity > 10 ? 'text-amber' : 'text-text-primary')}>{selected.renderVelocity.toFixed(1)}/min</p>
                </div>
              </div>

              <div>
                <p className="text-[11px] font-medium text-text-muted uppercase tracking-wider mb-2">Render Cause</p>
                <div className="bg-bg-elevated rounded-md p-3 border border-border-muted">
                  <div className="h-3 flex rounded-full overflow-hidden">
                    <div style={{ width: '100%', backgroundColor: CAUSE_COLORS[selected.lastRenderCause || 'unknown'] }} className="rounded-full" />
                  </div>
                  <p className="text-sm text-text-secondary mt-2 capitalize">{selected.lastRenderCause || 'unknown'} — {selected.lastRenderPhase}</p>
                </div>
              </div>

              {selected.suspicious && (
                <div className="bg-amber-muted border border-amber-border rounded-md p-3">
                  <p className="text-sm font-medium text-amber">Suspicious Render Pattern</p>
                  <p className="text-[13px] text-text-secondary mt-1">High render velocity detected. Consider memoization or checking for unstable references.</p>
                </div>
              )}
            </div>
          )}
        </DetailPanel>
      </div>
    </div>
  );
}

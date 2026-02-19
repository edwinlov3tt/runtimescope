import { useState, useMemo } from 'react';
import { Topbar } from '@/components/layout/topbar';
import { DetailPanel, Badge, JsonViewer, Tabs } from '@/components/ui';
import { cn } from '@/lib/cn';
import { MOCK_STATE } from '@/mock/state';
import { useDataStore } from '@/stores/use-data-store';
import { useConnected } from '@/hooks/use-connected';
import { formatTimestamp } from '@/lib/format';

export function StatePage() {
  const [activeTab, setActiveTab] = useState('mutations');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const connected = useConnected();
  const dataSource = useDataStore((s) => s.source);
  const liveState = useDataStore((s) => s.state);
  const allData = dataSource === 'live' ? liveState : MOCK_STATE;

  const stores = useMemo(() => {
    const map = new Map<string, { id: string; library: string; count: number; lastUpdate: number }>();
    for (const e of allData) {
      const existing = map.get(e.storeId);
      if (!existing) {
        map.set(e.storeId, { id: e.storeId, library: e.library, count: 1, lastUpdate: e.timestamp });
      } else {
        existing.count++;
        existing.lastUpdate = Math.max(existing.lastUpdate, e.timestamp);
      }
    }
    return Array.from(map.values());
  }, [allData]);

  const mutations = allData.filter((e) => e.phase === 'update');
  const selected = selectedId ? allData.find((e) => e.eventId === selectedId) : null;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <Topbar
        title="State"
        tabs={[{ id: 'stores', label: 'Stores' }, { id: 'mutations', label: 'Mutations' }]}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        connected={connected}
      />

      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 overflow-y-auto">
          {activeTab === 'stores' && (
            <div className="p-5 space-y-3">
              {stores.map((store) => (
                <div key={store.id} className="bg-bg-elevated border border-border-default rounded-lg p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="text-[15px] font-semibold text-text-primary">{store.id}</span>
                      <Badge variant="purple" size="sm">{store.library}</Badge>
                    </div>
                    <span className="text-[11px] text-text-muted">{store.count} updates</span>
                  </div>
                  <div className="bg-bg-surface rounded-md p-3 border border-border-muted">
                    <JsonViewer
                      data={allData.filter((e) => e.storeId === store.id).pop()?.state}
                      defaultExpanded={false}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          {activeTab === 'mutations' && (
            <div className="divide-y divide-border-muted">
              {mutations.map((m) => (
                <div
                  key={m.eventId}
                  onClick={() => setSelectedId(m.eventId)}
                  className={cn(
                    'flex items-start gap-3 px-5 py-3 cursor-pointer transition-colors hover:bg-bg-hover',
                    selectedId === m.eventId && 'bg-bg-active'
                  )}
                >
                  <Badge variant="purple" size="sm">{m.storeId}</Badge>
                  <div className="flex-1 min-w-0">
                    <p className="text-[13px] text-text-primary">{m.action?.type || 'update'}</p>
                    {m.diff && (
                      <p className="text-[11px] text-text-muted mt-0.5 truncate">
                        Changed: {Object.keys(m.diff).join(', ')}
                      </p>
                    )}
                  </div>
                  <span className="text-[11px] font-mono text-text-muted tabular-nums shrink-0">
                    {formatTimestamp(m.timestamp)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <DetailPanel
          open={selected !== null}
          onClose={() => setSelectedId(null)}
          title={selected ? `${selected.storeId} — ${selected.action?.type || 'update'}` : ''}
          subtitle={selected ? formatTimestamp(selected.timestamp) : ''}
        >
          {selected && (
            <div className="p-4 space-y-4">
              {selected.diff && (
                <div>
                  <p className="text-[11px] font-medium text-text-muted uppercase tracking-wider mb-2">Changes</p>
                  <div className="bg-bg-elevated rounded-md p-3 border border-border-muted">
                    <JsonViewer data={selected.diff} defaultExpanded={true} />
                  </div>
                </div>
              )}
              {selected.action?.payload != null && (
                <div>
                  <p className="text-[11px] font-medium text-text-muted uppercase tracking-wider mb-2">Action Payload</p>
                  <div className="bg-bg-elevated rounded-md p-3 border border-border-muted">
                    <JsonViewer data={selected.action.payload} defaultExpanded={true} />
                  </div>
                </div>
              )}
              <div>
                <p className="text-[11px] font-medium text-text-muted uppercase tracking-wider mb-2">Current State</p>
                <div className="bg-bg-elevated rounded-md p-3 border border-border-muted">
                  <JsonViewer data={selected.state} defaultExpanded={false} />
                </div>
              </div>
            </div>
          )}
        </DetailPanel>
      </div>
    </div>
  );
}

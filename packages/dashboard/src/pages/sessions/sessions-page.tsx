import { useState, useEffect, useMemo } from 'react';
import { Topbar } from '@/components/layout/topbar';
import { DataTable, DetailPanel, Badge, StatusDot, FilterBar } from '@/components/ui';
import { useConnected } from '@/hooks/use-connected';
import { useAppStore } from '@/stores/use-app-store';
import { fetchSessions } from '@/lib/api';
import { formatRelativeTime, formatNumber } from '@/lib/format';
import { cn } from '@/lib/cn';

interface SessionInfo {
  sessionId: string;
  appName: string;
  connectedAt: number;
  sdkVersion: string;
  eventCount: number;
  isConnected: boolean;
  disconnectedAt?: number;
  buildMeta?: { gitCommit?: string; gitBranch?: string };
}

export function SessionsPage() {
  const [activeTab, setActiveTab] = useState('history');
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [detailIndex, setDetailIndex] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const connected = useConnected();
  const selectedProject = useAppStore((s) => s.selectedProject);

  // Poll sessions
  useEffect(() => {
    let active = true;
    const load = async () => {
      const data = await fetchSessions() as SessionInfo[] | null;
      if (data && active) setSessions(data);
    };
    load();
    const timer = setInterval(load, 3000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  // Filter by selected project and search
  const filtered = useMemo(() => {
    let data = sessions;
    if (selectedProject) {
      data = data.filter((s) => s.appName === selectedProject);
    }
    if (search) {
      const q = search.toLowerCase();
      data = data.filter(
        (s) => s.sessionId.toLowerCase().includes(q) || s.appName.toLowerCase().includes(q),
      );
    }
    // Sort: connected first, then by connectedAt desc
    return [...data].sort((a, b) => {
      if (a.isConnected !== b.isConnected) return a.isConnected ? -1 : 1;
      return b.connectedAt - a.connectedAt;
    });
  }, [sessions, selectedProject, search]);

  const selected = detailIndex !== null ? filtered[detailIndex] : null;

  const connectedCount = filtered.filter((s) => s.isConnected).length;
  const totalEvents = filtered.reduce((sum, s) => sum + s.eventCount, 0);

  // Group by appName for compare tab
  const appGroups = useMemo(() => {
    const map = new Map<string, SessionInfo[]>();
    for (const s of sessions) {
      const arr = map.get(s.appName) ?? [];
      arr.push(s);
      map.set(s.appName, arr);
    }
    return Array.from(map.entries());
  }, [sessions]);

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <Topbar
        title="Sessions"
        tabs={[{ id: 'history', label: 'History' }, { id: 'compare', label: 'Compare' }]}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        connected={connected}
      />

      <div className="flex-1 flex min-h-0 overflow-hidden">
        {activeTab === 'history' && (
          <>
            <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
              <FilterBar
                search={search}
                onSearchChange={setSearch}
                searchPlaceholder="Filter by session ID or app name..."
              >
                <div className="flex items-center gap-3 text-xs text-text-muted">
                  <span>{filtered.length} sessions</span>
                  <span>{connectedCount} live</span>
                  <span>{formatNumber(totalEvents)} events</span>
                </div>
              </FilterBar>

              <div className="flex-1 overflow-auto">
                <DataTable
                  columns={[
                    {
                      key: 'status',
                      header: '',
                      width: '32px',
                      render: (row) => (
                        <StatusDot color={(row as unknown as SessionInfo).isConnected ? 'green' : 'gray'} size="sm" />
                      ),
                    },
                    {
                      key: 'sessionId',
                      header: 'Session',
                      width: '140px',
                      render: (row) => (
                        <span className="font-mono text-[12px] text-text-secondary">
                          {(row.sessionId as string).slice(0, 12)}...
                        </span>
                      ),
                    },
                    {
                      key: 'appName',
                      header: 'App',
                      width: '160px',
                      render: (row) => (
                        <span className="font-medium text-text-primary truncate block max-w-[140px]">
                          {row.appName as string}
                        </span>
                      ),
                    },
                    {
                      key: 'connectedAt',
                      header: 'Connected',
                      width: '100px',
                      render: (row) => (
                        <span className="text-text-muted tabular-nums text-xs">
                          {formatRelativeTime(row.connectedAt as number)}
                        </span>
                      ),
                    },
                    {
                      key: 'eventCount',
                      header: 'Events',
                      width: '80px',
                      render: (row) => (
                        <span className="tabular-nums">{formatNumber(row.eventCount as number)}</span>
                      ),
                    },
                    {
                      key: 'sdkVersion',
                      header: 'SDK',
                      width: '70px',
                      render: (row) => (
                        <Badge size="sm">{row.sdkVersion as string}</Badge>
                      ),
                    },
                  ]}
                  data={filtered as unknown as Record<string, unknown>[]}
                  selectedIndex={detailIndex ?? undefined}
                  onRowClick={(_, i) => setDetailIndex(i)}
                />
              </div>
            </div>

            <DetailPanel
              open={selected !== null}
              onClose={() => setDetailIndex(null)}
              title={selected ? `Session ${selected.sessionId.slice(0, 12)}` : ''}
              subtitle={selected ? `${selected.appName} · SDK v${selected.sdkVersion}` : ''}
            >
              {selected && (
                <div className="p-4 space-y-4">
                  <div className="space-y-2">
                    <DetailRow label="Session ID" value={selected.sessionId} mono />
                    <DetailRow label="App Name" value={selected.appName} />
                    <DetailRow label="Status">
                      <span className={cn('inline-flex items-center gap-1.5', selected.isConnected ? 'text-green' : 'text-text-muted')}>
                        <StatusDot color={selected.isConnected ? 'green' : 'gray'} size="sm" />
                        {selected.isConnected ? 'Connected' : 'Disconnected'}
                      </span>
                    </DetailRow>
                    <DetailRow label="Connected At" value={new Date(selected.connectedAt).toLocaleString()} />
                    {selected.disconnectedAt && (
                      <DetailRow label="Disconnected At" value={new Date(selected.disconnectedAt).toLocaleString()} />
                    )}
                    <DetailRow label="Events" value={formatNumber(selected.eventCount)} />
                    <DetailRow label="SDK Version" value={`v${selected.sdkVersion}`} />
                    {selected.buildMeta?.gitBranch && (
                      <DetailRow label="Branch" value={selected.buildMeta.gitBranch} mono />
                    )}
                    {selected.buildMeta?.gitCommit && (
                      <DetailRow label="Commit" value={selected.buildMeta.gitCommit.slice(0, 7)} mono />
                    )}
                  </div>

                  <div className="pt-2 border-t border-border-muted">
                    <h4 className="text-[11px] font-medium text-text-muted uppercase tracking-wider mb-2">
                      Duration
                    </h4>
                    <p className="text-sm text-text-primary">
                      {selected.isConnected
                        ? `Active for ${formatRelativeTime(selected.connectedAt).replace(' ago', '')}`
                        : selected.disconnectedAt
                          ? `${Math.round((selected.disconnectedAt - selected.connectedAt) / 1000)}s`
                          : formatRelativeTime(selected.connectedAt)
                      }
                    </p>
                  </div>
                </div>
              )}
            </DetailPanel>
          </>
        )}

        {activeTab === 'compare' && (
          <div className="flex-1 overflow-auto p-5 space-y-4 max-w-4xl mx-auto w-full">
            <p className="text-sm text-text-muted mb-4">
              Compare sessions across apps to spot differences in event volume and errors.
            </p>

            {appGroups.map(([appName, appSessions]) => (
              <div key={appName} className="border border-border-muted rounded-lg overflow-hidden">
                <div className="px-4 py-2 bg-bg-surface border-b border-border-muted flex items-center gap-2">
                  <StatusDot color={appSessions.some((s) => s.isConnected) ? 'green' : 'gray'} size="sm" />
                  <span className="text-sm font-medium">{appName}</span>
                  <span className="text-xs text-text-muted ml-auto">{appSessions.length} sessions</span>
                </div>
                <DataTable
                  columns={[
                    {
                      key: 'sessionId',
                      header: 'Session',
                      width: '140px',
                      render: (row) => (
                        <span className="font-mono text-[12px] text-text-secondary">
                          {(row.sessionId as string).slice(0, 12)}
                        </span>
                      ),
                    },
                    {
                      key: 'connectedAt',
                      header: 'When',
                      width: '100px',
                      render: (row) => (
                        <span className="text-xs text-text-muted tabular-nums">
                          {formatRelativeTime(row.connectedAt as number)}
                        </span>
                      ),
                    },
                    {
                      key: 'eventCount',
                      header: 'Events',
                      width: '80px',
                      render: (row) => <span className="tabular-nums">{formatNumber(row.eventCount as number)}</span>,
                    },
                    {
                      key: 'isConnected',
                      header: 'Status',
                      width: '80px',
                      render: (row) => (
                        <Badge size="sm" variant={(row as unknown as SessionInfo).isConnected ? 'green' : 'default'}>
                          {(row as unknown as SessionInfo).isConnected ? 'Live' : 'Ended'}
                        </Badge>
                      ),
                    },
                  ]}
                  data={appSessions.sort((a, b) => b.connectedAt - a.connectedAt) as unknown as Record<string, unknown>[]}
                />
              </div>
            ))}

            {appGroups.length === 0 && (
              <p className="text-sm text-text-muted text-center py-8">
                No sessions recorded yet. Connect an app with the SDK to get started.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function DetailRow({ label, value, mono, children }: { label: string; value?: string; mono?: boolean; children?: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      <span className="text-text-muted w-28 shrink-0">{label}</span>
      {children ?? <span className={cn('text-text-primary', mono && 'font-mono text-xs')}>{value}</span>}
    </div>
  );
}

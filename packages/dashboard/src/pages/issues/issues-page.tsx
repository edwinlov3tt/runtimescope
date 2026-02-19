import { useState, useMemo } from 'react';
import { Topbar } from '@/components/layout/topbar';
import { DetailPanel, Badge } from '@/components/ui';
import { cn } from '@/lib/cn';
import { MOCK_ISSUES } from '@/mock/issues';
import { useDataStore } from '@/stores/use-data-store';
import { useConnected } from '@/hooks/use-connected';
import { detectIssues } from '@/lib/issue-detector';
import { AlertTriangle, AlertCircle, Info } from 'lucide-react';

const SEVERITY_CONFIG: Record<string, { icon: typeof AlertCircle; color: string; badge: string }> = {
  high: { icon: AlertCircle, color: 'text-red', badge: 'red' },
  medium: { icon: AlertTriangle, color: 'text-amber', badge: 'amber' },
  low: { icon: Info, color: 'text-blue', badge: 'blue' },
};

export function IssuesPage() {
  const [activeTab, setActiveTab] = useState('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const connected = useConnected();
  const source = useDataStore((s) => s.source);
  const network = useDataStore((s) => s.network);
  const consoleMsgs = useDataStore((s) => s.console);
  const stateEvents = useDataStore((s) => s.state);
  const renderEvents = useDataStore((s) => s.renders);
  const perfEvents = useDataStore((s) => s.performance);
  const dbEvents = useDataStore((s) => s.database);

  const allIssues = useMemo(() => {
    if (source !== 'live') return MOCK_ISSUES;
    const allEvents = [...network, ...consoleMsgs, ...stateEvents, ...renderEvents, ...perfEvents, ...dbEvents];
    if (allEvents.length === 0) return MOCK_ISSUES;
    return detectIssues(allEvents);
  }, [source, network, consoleMsgs, stateEvents, renderEvents, perfEvents, dbEvents]);

  const filtered = useMemo(() => {
    if (activeTab === 'all') return allIssues;
    return allIssues.filter((i) => i.severity === activeTab);
  }, [activeTab, allIssues]);

  const selected = selectedId ? allIssues.find((i) => i.id === selectedId) : null;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <Topbar
        title="Issues"
        tabs={[
          { id: 'all', label: 'All' },
          { id: 'high', label: 'High' },
          { id: 'medium', label: 'Medium' },
          { id: 'low', label: 'Low' },
        ]}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        connected={connected}
      />

      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 overflow-y-auto">
          <div className="divide-y divide-border-muted">
            {filtered.map((issue) => {
              const config = SEVERITY_CONFIG[issue.severity];
              const Icon = config.icon;
              return (
                <div
                  key={issue.id}
                  onClick={() => setSelectedId(issue.id)}
                  className={cn(
                    'flex items-start gap-3 px-5 py-3 cursor-pointer transition-colors hover:bg-bg-hover',
                    selectedId === issue.id && 'bg-bg-active'
                  )}
                >
                  <Icon size={16} className={cn('mt-0.5 shrink-0', config.color)} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium text-text-primary">{issue.title}</span>
                      <Badge variant={config.badge as any} size="sm">{issue.severity}</Badge>
                    </div>
                    <p className="text-[12px] text-text-tertiary mt-0.5 truncate">{issue.description}</p>
                  </div>
                  <Badge size="sm">{issue.pattern}</Badge>
                </div>
              );
            })}
          </div>
        </div>

        <DetailPanel
          open={selected !== null}
          onClose={() => setSelectedId(null)}
          title={selected?.title}
          subtitle={selected ? `${selected.severity} · ${selected.pattern}` : ''}
        >
          {selected && (
            <div className="p-4 space-y-4">
              <div>
                <p className="text-[13px] text-text-secondary">{selected.description}</p>
              </div>

              <div>
                <p className="text-[11px] font-medium text-text-muted uppercase tracking-wider mb-2">Evidence</p>
                <div className="space-y-1.5">
                  {selected.evidence.map((e, i) => (
                    <div key={i} className="bg-bg-elevated rounded-md px-3 py-2 border border-border-muted">
                      <p className="text-[12px] font-mono text-text-secondary">{e}</p>
                    </div>
                  ))}
                </div>
              </div>

              {selected.suggestion && (
                <div className="bg-green-muted border border-green-border rounded-md p-3">
                  <p className="text-[11px] font-medium text-green uppercase tracking-wider mb-1">Suggestion</p>
                  <p className="text-[13px] text-text-secondary">{selected.suggestion}</p>
                </div>
              )}
            </div>
          )}
        </DetailPanel>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { Topbar } from '@/components/layout/topbar';
import { DataTable, Badge } from '@/components/ui';
import { MOCK_SESSIONS, MOCK_SESSION_DIFF } from '@/mock/sessions';
import { useConnected } from '@/hooks/use-connected';
import { formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/cn';

function DeltaBadge({ delta }: { delta: { percentChange: number; classification: string } }) {
  const color = delta.classification === 'improvement' ? 'green' : delta.classification === 'regression' ? 'red' : 'default';
  const prefix = delta.percentChange > 0 ? '+' : '';
  return <Badge variant={color as any} size="sm">{prefix}{delta.percentChange.toFixed(1)}%</Badge>;
}

export function SessionsPage() {
  const [activeTab, setActiveTab] = useState('history');
  const connected = useConnected();

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <Topbar
        title="Sessions"
        tabs={[{ id: 'history', label: 'History' }, { id: 'compare', label: 'Compare' }]}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        connected={connected}
      />

      <div className="flex-1 overflow-auto">
        {activeTab === 'history' && (
          <DataTable
            columns={[
              { key: 'sessionId', header: 'Session', width: '120px', render: (row) => <span className="font-mono text-[12px]">{row.sessionId as string}</span> },
              { key: 'project', header: 'Project', width: '100px' },
              { key: 'connectedAt', header: 'Started', width: '100px', render: (row) => <span className="text-text-muted text-[12px]">{formatRelativeTime(row.connectedAt as number)}</span> },
              { key: 'totalEvents', header: 'Events', width: '80px', render: (row) => <span className="tabular-nums">{row.totalEvents as number}</span> },
              { key: 'errorCount', header: 'Errors', width: '80px', render: (row) => { const c = row.errorCount as number; return <span className={cn('tabular-nums', c > 5 ? 'text-red' : c > 0 ? 'text-amber' : 'text-text-muted')}>{c}</span>; } },
            ]}
            data={MOCK_SESSIONS as any}
          />
        )}

        {activeTab === 'compare' && (
          <div className="p-5 space-y-6 max-w-4xl mx-auto w-full">
            <div className="flex items-center gap-4 text-sm">
              <Badge variant="red" size="sm">{MOCK_SESSION_DIFF.sessionA}</Badge>
              <span className="text-text-muted">vs</span>
              <Badge variant="green" size="sm">{MOCK_SESSION_DIFF.sessionB}</Badge>
            </div>

            {[
              { title: 'Web Vitals', deltas: MOCK_SESSION_DIFF.webVitalDeltas },
              { title: 'Endpoints', deltas: MOCK_SESSION_DIFF.endpointDeltas },
              { title: 'Components', deltas: MOCK_SESSION_DIFF.componentDeltas },
              { title: 'Queries', deltas: MOCK_SESSION_DIFF.queryDeltas },
              { title: 'Stores', deltas: MOCK_SESSION_DIFF.storeDeltas },
            ].map((section) => (
              <div key={section.title}>
                <h3 className="text-[13px] font-semibold text-text-primary mb-2">{section.title}</h3>
                <div className="border border-border-default rounded-lg overflow-hidden">
                  <table className="w-full text-[13px]">
                    <thead>
                      <tr className="bg-bg-elevated border-b border-border-default">
                        <th className="text-left px-3 py-2 text-[11px] font-medium text-text-muted uppercase">Metric</th>
                        <th className="text-right px-3 py-2 text-[11px] font-medium text-text-muted uppercase">Before</th>
                        <th className="text-right px-3 py-2 text-[11px] font-medium text-text-muted uppercase">After</th>
                        <th className="text-right px-3 py-2 text-[11px] font-medium text-text-muted uppercase">Change</th>
                      </tr>
                    </thead>
                    <tbody>
                      {section.deltas.map((d) => (
                        <tr key={d.key} className="border-b border-border-muted">
                          <td className="px-3 py-2 text-text-primary">{d.key}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-text-muted">{d.before}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-text-primary">{d.after}</td>
                          <td className="px-3 py-2 text-right"><DeltaBadge delta={d} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

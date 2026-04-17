import { useMemo } from 'react';
import { KpiCard, ActivityFeed } from '@/components/ui';
import { SessionBar } from '@/components/ui/session-bar';
import { useDataStore } from '@/stores/use-data-store';
import { useConnected } from '@/hooks/use-connected';
import { computeOverviewStats } from '@/lib/overview-stats';
import { eventsToActivity } from '@/lib/activity-mapper';
import { detectIssues } from '@/lib/issue-detector';
import { Globe, Clock, Layers, AlertTriangle, Wifi, Package, HardDrive } from 'lucide-react';

export function OverviewPage() {
  const connected = useConnected();
  const network = useDataStore((s) => s.network);
  const consoleMsgs = useDataStore((s) => s.console);
  const stateEvents = useDataStore((s) => s.state);
  const renderEvents = useDataStore((s) => s.renders);
  const perfEvents = useDataStore((s) => s.performance);
  const dbEvents = useDataStore((s) => s.database);

  const EMPTY_STATS = { requests: { value: 0, change: 0, label: '', sparkline: [] }, latency: { value: 0, change: 0, label: '', sparkline: [] }, renders: { value: 0, change: 0, label: '', sparkline: [] }, issues: { value: 0, change: 0, sparkline: [] } };

  const s = useMemo(() => {
    const allEvents = [...network, ...consoleMsgs, ...stateEvents, ...renderEvents, ...perfEvents, ...dbEvents];
    if (allEvents.length === 0) return EMPTY_STATS;
    const issues = detectIssues(allEvents);
    return computeOverviewStats(network, renderEvents, issues);
  }, [network, consoleMsgs, stateEvents, renderEvents, perfEvents, dbEvents]);

  const activity = useMemo(() => {
    const allEvents = [...network, ...consoleMsgs, ...stateEvents, ...renderEvents, ...perfEvents, ...dbEvents];
    if (allEvents.length === 0) return [];
    return eventsToActivity(allEvents, 20);
  }, [network, consoleMsgs, stateEvents, renderEvents, perfEvents, dbEvents]);

  const totalEvents = network.length + consoleMsgs.length + stateEvents.length + renderEvents.length;

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <div className="p-6 space-y-5">

          {/* Session bar */}
          <SessionBar
            connected={connected}
            items={[
              { icon: Wifi, label: 'Session', value: connected ? 'active' : 'none' },
              { icon: Package, label: 'SDK', value: 'v0.9.3' },
              { icon: Clock, label: 'Uptime', value: connected ? 'live' : '—' },
              { icon: HardDrive, label: 'Events', value: totalEvents.toLocaleString() },
            ]}
          />

          {/* KPI Cards */}
          <div className="grid grid-cols-4 gap-3">
            <KpiCard
              icon={Globe}
              label="Network Requests"
              value={s.requests.value.toLocaleString()}
              sparkColor="var(--color-blue)"
              sparkData={s.requests.sparkline}
              footerLabel={s.requests.label || 'This session'}
              changeValue={s.requests.change ? `${s.requests.change > 0 ? '+' : ''}${s.requests.change}%` : undefined}
              changeDir={s.requests.change > 0 ? 'up' : s.requests.change < 0 ? 'down' : 'neutral'}
            />
            <KpiCard
              icon={Clock}
              label="Avg Latency"
              value={String(s.latency.value)}
              unit="ms"
              sparkColor="var(--color-green)"
              sparkData={s.latency.sparkline}
              footerLabel={s.latency.label || 'P95 latency'}
              changeValue={s.latency.change ? `${s.latency.change > 0 ? '+' : ''}${s.latency.change}%` : undefined}
              changeDir={s.latency.change > 0 ? 'down' : s.latency.change < 0 ? 'up' : 'neutral'}
            />
            <KpiCard
              icon={Layers}
              label="Renders"
              value={s.renders.value.toLocaleString()}
              sparkColor="var(--color-purple)"
              sparkData={s.renders.sparkline}
              footerLabel={s.renders.label || 'Component renders'}
              changeValue={s.renders.change ? `${s.renders.change > 0 ? '+' : ''}${s.renders.change}%` : undefined}
              changeDir={s.renders.change > 0 ? 'down' : 'neutral'}
            />
            <KpiCard
              icon={AlertTriangle}
              label="Issues Detected"
              value={String(s.issues.value)}
              sparkColor="var(--color-amber)"
              sparkData={s.issues.sparkline}
              footerLabel="Active issues"
              changeValue={s.issues.change ? `${s.issues.change > 0 ? '+' : ''}${s.issues.change}` : undefined}
              changeDir={s.issues.change > 0 ? 'down' : 'neutral'}
            />
          </div>

          {/* Activity Feed */}
          <div className="border border-border-strong rounded-lg overflow-hidden bg-bg-surface flex flex-col">
            <div className="flex items-center justify-between px-4 h-10 border-b border-border-strong shrink-0">
              <span className="text-[13px] font-semibold">Recent Activity</span>
              <span className="text-[11px] text-text-muted">{activity.length} entries</span>
            </div>
            <div className="flex-1 overflow-y-auto">
              <ActivityFeed items={activity} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

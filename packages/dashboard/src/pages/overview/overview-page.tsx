import { useMemo } from 'react';
import { Topbar } from '@/components/layout/topbar';
import { MetricCard, Sparkline, ActivityFeed } from '@/components/ui';
import { useDataStore } from '@/stores/use-data-store';
import { useConnected } from '@/hooks/use-connected';
import { computeOverviewStats } from '@/lib/overview-stats';
import { eventsToActivity } from '@/lib/activity-mapper';
import { detectIssues } from '@/lib/issue-detector';
import { Globe, Clock, Zap, AlertTriangle } from 'lucide-react';

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

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <Topbar title="Overview" connected={connected} />

      <div className="flex-1 overflow-y-auto">
        <div className="p-6 space-y-6 max-w-6xl mx-auto w-full">
          {/* Metric Cards */}
          <div className="grid grid-cols-4 gap-4">
            <MetricCard
              label="Network Requests"
              value={s.requests.value.toLocaleString()}
              change={{ value: s.requests.change, label: s.requests.label }}
              icon={<Globe size={16} />}
            >
              <Sparkline data={s.requests.sparkline} width={100} height={28} color="var(--color-blue)" />
            </MetricCard>
            <MetricCard
              label="Avg Latency"
              value={String(s.latency.value)}
              suffix="ms"
              change={{ value: s.latency.change, label: s.latency.label }}
              icon={<Clock size={16} />}
            >
              <Sparkline data={s.latency.sparkline} width={100} height={28} color="var(--color-green)" />
            </MetricCard>
            <MetricCard
              label="Renders"
              value={s.renders.value.toLocaleString()}
              change={{ value: s.renders.change, label: s.renders.label }}
              icon={<Zap size={16} />}
            >
              <Sparkline data={s.renders.sparkline} width={100} height={28} color="var(--color-purple)" />
            </MetricCard>
            <MetricCard
              label="Issues"
              value={String(s.issues.value)}
              change={{ value: s.issues.change }}
              icon={<AlertTriangle size={16} />}
            >
              <Sparkline data={s.issues.sparkline} width={100} height={28} color="var(--color-amber)" />
            </MetricCard>
          </div>

          {/* Activity Feed */}
          <div>
            <h2 className="text-sm font-semibold text-text-primary mb-3">Recent Activity</h2>
            <div className="border border-border-default rounded-lg overflow-hidden bg-bg-surface">
              <ActivityFeed items={activity} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

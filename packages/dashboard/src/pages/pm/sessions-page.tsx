import { useState, useEffect, useMemo, useCallback, memo } from 'react';
import { usePmStore } from '@/stores/use-pm-store';
import { MetricCard, DataTable, DetailPanel, Badge, Button, Input } from '@/components/ui';
import { Clock, DollarSign, MessageSquare, Zap, Calendar } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { PmSession } from '@/lib/pm-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCost(microdollars: number): string {
  return `$${(microdollars / 1_000_000).toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatActiveTime(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

function todayStr(): string {
  return new Date().toISOString().split('T')[0];
}

// ---------------------------------------------------------------------------
// Date presets
// ---------------------------------------------------------------------------

type DatePreset = '7d' | '30d' | '90d' | 'all';

const DATE_PRESETS: { id: DatePreset; label: string }[] = [
  { id: '7d', label: 'Last 7d' },
  { id: '30d', label: 'Last 30d' },
  { id: '90d', label: 'Last 90d' },
  { id: 'all', label: 'All' },
];

function presetToRange(preset: DatePreset): { start?: string; end?: string } {
  if (preset === 'all') return {};
  const days = preset === '7d' ? 7 : preset === '30d' ? 30 : 90;
  return { start: daysAgo(days), end: todayStr() };
}

// ---------------------------------------------------------------------------
// Model badge
// ---------------------------------------------------------------------------

type BadgeVariant = 'purple' | 'blue' | 'green' | 'default';

function modelVariant(model: string | undefined): BadgeVariant {
  if (!model) return 'default';
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return 'purple';
  if (lower.includes('sonnet')) return 'blue';
  if (lower.includes('haiku')) return 'green';
  return 'default';
}

function modelLabel(model: string | undefined): string {
  if (!model) return 'Unknown';
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return 'Opus';
  if (lower.includes('sonnet')) return 'Sonnet';
  if (lower.includes('haiku')) return 'Haiku';
  return model;
}

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const columns = [
  {
    key: 'startedAt',
    header: 'Date',
    width: '110px',
    sortable: true,
    render: (row: Record<string, unknown>) =>
      new Date((row as unknown as PmSession).startedAt).toLocaleDateString(),
  },
  {
    key: 'slug',
    header: 'Slug',
    render: (row: Record<string, unknown>) => {
      const s = row as unknown as PmSession;
      const label = s.slug || (s.firstPrompt ? s.firstPrompt.slice(0, 50) : '-');
      return (
        <span className="truncate block max-w-[220px]" title={label}>
          {label}
        </span>
      );
    },
  },
  {
    key: 'model',
    header: 'Model',
    width: '100px',
    sortable: true,
    render: (row: Record<string, unknown>) => {
      const s = row as unknown as PmSession;
      return (
        <Badge variant={modelVariant(s.model)} size="sm">
          {modelLabel(s.model)}
        </Badge>
      );
    },
  },
  {
    key: 'messageCount',
    header: 'Messages',
    width: '90px',
    sortable: true,
    render: (row: Record<string, unknown>) => (
      <span className="tabular-nums">{(row as unknown as PmSession).messageCount}</span>
    ),
  },
  {
    key: 'totalInputTokens',
    header: 'Tokens In',
    width: '100px',
    sortable: true,
    render: (row: Record<string, unknown>) => (
      <span className="tabular-nums text-text-secondary">
        {formatTokens((row as unknown as PmSession).totalInputTokens)}
      </span>
    ),
  },
  {
    key: 'totalOutputTokens',
    header: 'Tokens Out',
    width: '100px',
    sortable: true,
    render: (row: Record<string, unknown>) => (
      <span className="tabular-nums text-text-secondary">
        {formatTokens((row as unknown as PmSession).totalOutputTokens)}
      </span>
    ),
  },
  {
    key: 'costMicrodollars',
    header: 'Cost',
    width: '80px',
    sortable: true,
    render: (row: Record<string, unknown>) => (
      <span className="tabular-nums font-medium">
        {formatCost((row as unknown as PmSession).costMicrodollars)}
      </span>
    ),
  },
  {
    key: 'activeMinutes',
    header: 'Active Time',
    width: '100px',
    sortable: true,
    render: (row: Record<string, unknown>) => (
      <span className="tabular-nums text-text-secondary">
        {formatActiveTime((row as unknown as PmSession).activeMinutes)}
      </span>
    ),
  },
  {
    key: 'gitBranch',
    header: 'Branch',
    width: '140px',
    render: (row: Record<string, unknown>) => {
      const branch = (row as unknown as PmSession).gitBranch;
      return (
        <span className="font-mono text-xs text-text-tertiary truncate block max-w-[120px]">
          {branch || '-'}
        </span>
      );
    },
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const PmSessionsPage = memo(function PmSessionsPage({ projectId }: { projectId: string }) {
  const sessions = usePmStore((s) => s.sessions);
  const sessionsLoading = usePmStore((s) => s.sessionsLoading);
  const sessionsTotal = usePmStore((s) => s.sessionsTotal);
  const sessionStats = usePmStore((s) => s.sessionStats);
  const sessionDateRange = usePmStore((s) => s.sessionDateRange);
  const fetchSessions = usePmStore((s) => s.fetchSessions);
  const loadMoreSessions = usePmStore((s) => s.loadMoreSessions);
  const fetchSessionStats = usePmStore((s) => s.fetchSessionStats);
  const setSessionDateRange = usePmStore((s) => s.setSessionDateRange);

  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  // Determine active preset from current date range
  const activePreset = useMemo((): DatePreset | 'custom' => {
    const { start, end } = sessionDateRange;
    if (!start && !end) return 'all';
    for (const p of DATE_PRESETS) {
      const range = presetToRange(p.id);
      if (range.start === start && range.end === end) return p.id;
    }
    return 'custom';
  }, [sessionDateRange]);

  useEffect(() => {
    fetchSessions(projectId);
    fetchSessionStats(projectId);
  }, [projectId, fetchSessions, fetchSessionStats]);

  const handlePreset = useCallback((preset: DatePreset) => {
    setSessionDateRange(presetToRange(preset), projectId);
  }, [setSessionDateRange, projectId]);

  const handleCustomDate = useCallback((field: 'start' | 'end', value: string) => {
    const next = { ...sessionDateRange, [field]: value || undefined };
    setSessionDateRange(next, projectId);
  }, [sessionDateRange, setSessionDateRange, projectId]);

  const hasMore = sessions.length < sessionsTotal;
  const handleLoadMore = useCallback(() => {
    loadMoreSessions(projectId);
  }, [loadMoreSessions, projectId]);

  const selectedSession: PmSession | null = useMemo(
    () => (selectedIndex !== null ? sessions[selectedIndex] ?? null : null),
    [sessions, selectedIndex],
  );

  // Compute metric values
  const totalSessions = sessionStats?.totalSessions ?? sessions.length;
  const totalCost = sessionStats
    ? formatCost(sessionStats.totalCostMicrodollars)
    : formatCost(sessions.reduce((sum, s) => sum + s.costMicrodollars, 0));
  const totalActiveHours = sessionStats
    ? formatActiveTime(sessionStats.totalActiveMinutes)
    : formatActiveTime(sessions.reduce((sum, s) => sum + s.activeMinutes, 0));
  const avgCostPerSession =
    totalSessions > 0
      ? formatCost(
          (sessionStats?.totalCostMicrodollars ??
            sessions.reduce((sum, s) => sum + s.costMicrodollars, 0)) / totalSessions,
        )
      : '$0.00';

  const isFiltered = !!(sessionDateRange.start || sessionDateRange.end);

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Main content */}
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <div className="p-6 space-y-6 overflow-y-auto">
            {/* Date range toolbar */}
            <div className="flex items-center gap-3 flex-wrap">
              {/* Quick presets */}
              <div className="flex items-center gap-1.5">
                {DATE_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => handlePreset(p.id)}
                    className={cn(
                      'px-3 py-1 rounded-full text-xs font-medium transition-colors cursor-pointer',
                      activePreset === p.id
                        ? 'bg-brand text-white'
                        : 'bg-bg-surface text-text-secondary hover:bg-bg-hover',
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>

              {/* Custom date inputs */}
              <div className="flex items-center gap-2 ml-auto">
                <Calendar size={14} className="text-text-tertiary" />
                <input
                  type="date"
                  value={sessionDateRange.start ?? ''}
                  onChange={(e) => handleCustomDate('start', e.target.value)}
                  className="h-7 px-2 rounded bg-bg-input text-text-primary text-xs border border-border-strong focus:border-border-hover focus:outline-none"
                />
                <span className="text-text-tertiary text-xs">to</span>
                <input
                  type="date"
                  value={sessionDateRange.end ?? ''}
                  onChange={(e) => handleCustomDate('end', e.target.value)}
                  className="h-7 px-2 rounded bg-bg-input text-text-primary text-xs border border-border-strong focus:border-border-hover focus:outline-none"
                />
              </div>
            </div>

            {/* Metric cards */}
            <div className="grid grid-cols-4 gap-4">
              <MetricCard
                label="Total Sessions"
                value={String(totalSessions)}
                icon={<MessageSquare size={16} />}
              />
              <MetricCard
                label="Total Cost"
                value={totalCost}
                icon={<DollarSign size={16} />}
              />
              <MetricCard
                label="Total Active Hours"
                value={totalActiveHours}
                icon={<Clock size={16} />}
              />
              <MetricCard
                label="Avg Cost/Session"
                value={avgCostPerSession}
                icon={<Zap size={16} />}
              />
            </div>

            {/* Sessions table */}
            <div className="rounded-lg border border-border-default overflow-hidden">
              <DataTable
                columns={columns}
                data={sessions as any}
                selectedIndex={selectedIndex ?? undefined}
                onRowClick={(_, i) => setSelectedIndex(i)}
                emptyMessage={sessionsLoading ? 'Loading sessions...' : 'No sessions found'}
                defaultSort={{ key: 'startedAt', direction: 'desc' }}
              />
            </div>

            {/* Footer: count + load more */}
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-tertiary">
                {isFiltered
                  ? `Showing ${sessions.length} of ${sessionsTotal} sessions (filtered)`
                  : `${sessionsTotal} sessions`}
              </span>
              {hasMore && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleLoadMore}
                  disabled={sessionsLoading}
                >
                  {sessionsLoading ? 'Loading...' : `Load more`}
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Detail panel */}
        <DetailPanel
          open={selectedSession !== null}
          onClose={() => setSelectedIndex(null)}
          title="Session Detail"
          subtitle={selectedSession?.slug || undefined}
        >
          {selectedSession && (
            <div className="p-4 space-y-5">
              {/* Session ID */}
              <div>
                <h4 className="text-[11px] font-medium text-text-muted uppercase tracking-wider mb-1">
                  Session ID
                </h4>
                <p className="text-xs font-mono text-text-secondary break-all">
                  {selectedSession.id}
                </p>
              </div>

              {/* First prompt */}
              {selectedSession.firstPrompt && (
                <div>
                  <h4 className="text-[11px] font-medium text-text-muted uppercase tracking-wider mb-1">
                    First Prompt
                  </h4>
                  <p className="text-sm text-text-primary whitespace-pre-wrap leading-relaxed">
                    {selectedSession.firstPrompt}
                  </p>
                </div>
              )}

              {/* Token breakdown */}
              <div>
                <h4 className="text-[11px] font-medium text-text-muted uppercase tracking-wider mb-2">
                  Token Breakdown
                </h4>
                <div className="space-y-1.5">
                  <DetailRow label="Input" value={formatTokens(selectedSession.totalInputTokens)} />
                  <DetailRow label="Output" value={formatTokens(selectedSession.totalOutputTokens)} />
                  <DetailRow
                    label="Cache Creation"
                    value={formatTokens(selectedSession.totalCacheCreationTokens)}
                  />
                  <DetailRow
                    label="Cache Read"
                    value={formatTokens(selectedSession.totalCacheReadTokens)}
                  />
                </div>
              </div>

              {/* Cost breakdown */}
              <div>
                <h4 className="text-[11px] font-medium text-text-muted uppercase tracking-wider mb-2">
                  Cost Breakdown
                </h4>
                <div className="space-y-1.5">
                  <DetailRow label="Total Cost" value={formatCost(selectedSession.costMicrodollars)} />
                  <DetailRow
                    label="Active Time"
                    value={formatActiveTime(selectedSession.activeMinutes)}
                  />
                </div>
              </div>

              {/* Compaction count */}
              <div>
                <h4 className="text-[11px] font-medium text-text-muted uppercase tracking-wider mb-1">
                  Compaction Count
                </h4>
                <p className="text-sm text-text-primary tabular-nums">
                  {selectedSession.compactionCount}
                </p>
              </div>

              {/* Permission mode */}
              {selectedSession.permissionMode && (
                <div>
                  <h4 className="text-[11px] font-medium text-text-muted uppercase tracking-wider mb-1">
                    Permission Mode
                  </h4>
                  <Badge variant="default" size="sm">
                    {selectedSession.permissionMode}
                  </Badge>
                </div>
              )}
            </div>
          )}
        </DetailPanel>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Internal sub-component
// ---------------------------------------------------------------------------

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-text-tertiary">{label}</span>
      <span className="text-text-primary tabular-nums font-medium">{value}</span>
    </div>
  );
}

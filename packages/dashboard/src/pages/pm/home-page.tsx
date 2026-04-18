import { useState, useEffect, useCallback, useMemo, memo } from 'react';
import { usePmStore } from '@/stores/use-pm-store';
import { useAppStore } from '@/stores/use-app-store';
import { useDevServerStore } from '@/stores/use-dev-server-store';
import { useWorkspaceStore } from '@/stores/use-workspace-store';
import { KpiCard, Badge, DataTable, EmptyState } from '@/components/ui';
import { StatusDot } from '@/components/ui/status-dot';
import {
  FolderKanban,
  Clock,
  DollarSign,
  TrendingUp,
  Play,
  Square,
  Calendar,
  EyeOff,
  Eye,
  MessageSquare,
  Download,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import type { ProjectSummary } from '@/lib/pm-api';
import * as pmApi from '@/lib/pm-api';
import { findRuntimeProjects, type ProjectInfo } from '@/lib/api';

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

function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

function todayStr(): string {
  return new Date().toISOString().split('T')[0];
}

function presetToRange(preset: DatePreset): { start?: string; end?: string } {
  if (preset === 'all') return {};
  const days = preset === '7d' ? 7 : preset === '30d' ? 30 : 90;
  return { start: daysAgo(days), end: todayStr() };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatCost(microdollars: number): string {
  return `$${(microdollars / 1_000_000).toFixed(2)}`;
}

function formatActiveTime(minutes: number): string {
  if (minutes < 1) return '0m';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatDate(ts: number | null): string {
  if (!ts) return '-';
  return new Date(ts).toLocaleDateString();
}

// ---------------------------------------------------------------------------
// Greeting
// ---------------------------------------------------------------------------

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

// ---------------------------------------------------------------------------
// SDK status
// ---------------------------------------------------------------------------

type SdkStatus = 'live' | 'installed' | 'not-installed';

function getSdkStatus(row: ProjectSummary, runtimeProjects: ProjectInfo[]): SdkStatus {
  const apps: string[] = row.runtime_apps ? JSON.parse(row.runtime_apps) : [];
  const rps = findRuntimeProjects(runtimeProjects, {
    runtimescopeProject: row.runtimescope_project ?? undefined,
    runtimeApps: apps.length ? apps : undefined,
    name: row.name,
  });
  if (rps.some((r) => r.isConnected)) return 'live';
  if (row.sdk_installed || rps.length > 0) return 'installed';
  return 'not-installed';
}

const SDK_CFG: Record<SdkStatus, { label: string; variant: 'green' | 'blue' | 'default' }> = {
  live: { label: 'Live', variant: 'green' },
  installed: { label: 'SDK', variant: 'blue' },
  'not-installed': { label: '-', variant: 'default' },
};

// ---------------------------------------------------------------------------
// Dev server button (inline, per-row)
// ---------------------------------------------------------------------------

const DevServerBtn = memo(function DevServerBtn({ projectId }: { projectId: string }) {
  const status = useDevServerStore((s) => s.servers.get(projectId)?.status ?? 'idle');
  const isRunning = status === 'running' || status === 'starting';

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isRunning) {
      await pmApi.stopDevServer(projectId);
    } else {
      useDevServerStore.getState().setOptimisticStarting(projectId);
      await pmApi.startDevServer(projectId);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium transition-colors cursor-pointer',
        isRunning
          ? 'bg-green-500/15 text-green-400 hover:bg-red-500/15 hover:text-red-400'
          : 'bg-bg-surface text-text-muted hover:bg-bg-hover',
      )}
      title={isRunning ? 'Stop dev server' : 'Start dev server'}
    >
      {isRunning ? (
        <>
          <Square size={10} />
          {status === 'starting' ? 'Starting...' : 'Stop'}
        </>
      ) : (
        <>
          <Play size={10} />
          Start
        </>
      )}
    </button>
  );
});

// ---------------------------------------------------------------------------
// Table columns
// ---------------------------------------------------------------------------

function makeColumns(runtimeProjects: ProjectInfo[]) {
  return [
    {
      key: 'name',
      header: 'Project',
      sortable: true,
      render: (row: Record<string, unknown>) => {
        const r = row as unknown as ProjectSummary;
        const sdk = getSdkStatus(r, runtimeProjects);
        return (
          <div className="flex items-center gap-2">
            {sdk === 'live' && <StatusDot color="green" size="sm" pulse />}
            <span className="font-medium text-text-primary truncate max-w-[200px]">{r.name}</span>
          </div>
        );
      },
    },
    {
      key: 'category',
      header: 'Category',
      width: '110px',
      sortable: true,
      render: (row: Record<string, unknown>) => {
        const cat = (row as unknown as ProjectSummary).category;
        return cat ? (
          <Badge variant="purple" size="sm">{cat}</Badge>
        ) : (
          <span className="text-text-muted text-xs">-</span>
        );
      },
    },
    {
      key: 'session_count',
      header: 'Sessions',
      width: '90px',
      sortable: true,
      render: (row: Record<string, unknown>) => (
        <span className="tabular-nums">{(row as unknown as ProjectSummary).session_count}</span>
      ),
    },
    {
      key: 'total_messages',
      header: 'Messages',
      width: '90px',
      sortable: true,
      render: (row: Record<string, unknown>) => (
        <span className="tabular-nums text-text-secondary">
          {(row as unknown as ProjectSummary).total_messages.toLocaleString()}
        </span>
      ),
    },
    {
      key: 'total_cost',
      header: 'Cost',
      width: '90px',
      sortable: true,
      render: (row: Record<string, unknown>) => (
        <span className="tabular-nums font-medium">
          {formatCost((row as unknown as ProjectSummary).total_cost)}
        </span>
      ),
    },
    {
      key: 'total_active_minutes',
      header: 'Active Time',
      width: '100px',
      sortable: true,
      render: (row: Record<string, unknown>) => (
        <span className="tabular-nums text-text-secondary">
          {formatActiveTime((row as unknown as ProjectSummary).total_active_minutes)}
        </span>
      ),
    },
    {
      key: 'last_session_at',
      header: 'Last Session',
      width: '110px',
      sortable: true,
      render: (row: Record<string, unknown>) => (
        <span className="text-text-secondary text-xs">
          {formatDate((row as unknown as ProjectSummary).last_session_at)}
        </span>
      ),
    },
    {
      key: 'sdk_status',
      header: 'SDK',
      width: '70px',
      render: (row: Record<string, unknown>) => {
        const r = row as unknown as ProjectSummary;
        const sdk = getSdkStatus(r, runtimeProjects);
        const cfg = SDK_CFG[sdk];
        if (sdk === 'not-installed') return <span className="text-text-muted text-xs">-</span>;
        return <Badge variant={cfg.variant} size="sm">{cfg.label}</Badge>;
      },
    },
    {
      key: 'dev_server',
      header: 'Dev',
      width: '90px',
      render: (row: Record<string, unknown>) => {
        const r = row as unknown as ProjectSummary;
        if (!r.path) return <span className="text-text-muted text-xs">-</span>;
        return <DevServerBtn projectId={r.id} />;
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HomePage() {
  const allProjects = usePmStore((s) => s.projects);
  const sessionStats = usePmStore((s) => s.sessionStats);
  const allProjectSummaries = usePmStore((s) => s.projectSummaries);
  const projectSummariesLoading = usePmStore((s) => s.projectSummariesLoading);
  const hideEmpty = usePmStore((s) => s.hideEmptySessions);
  const sessionDateRange = usePmStore((s) => s.sessionDateRange);
  const setSessionDateRange = usePmStore((s) => s.setSessionDateRange);
  const setHideEmptySessions = usePmStore((s) => s.setHideEmptySessions);
  const runtimeProjects = useAppStore((s) => s.projects);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);

  // Scope to the active workspace when one is selected.
  // Null activeWorkspaceId = "All workspaces" — show everything.
  const workspaceProjectIds = useMemo(() => {
    if (!activeWorkspaceId) return null;
    return new Set(allProjects.filter((p) => p.workspaceId === activeWorkspaceId).map((p) => p.id));
  }, [allProjects, activeWorkspaceId]);

  const projects = useMemo(() => {
    if (!workspaceProjectIds) return allProjects;
    return allProjects.filter((p) => workspaceProjectIds.has(p.id));
  }, [allProjects, workspaceProjectIds]);

  const projectSummaries = useMemo(() => {
    if (!workspaceProjectIds) return allProjectSummaries;
    return allProjectSummaries.filter((p) => workspaceProjectIds.has(p.id));
  }, [allProjectSummaries, workspaceProjectIds]);

  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  // Active date preset
  const activeDatePreset = useMemo((): DatePreset | 'custom' => {
    const { start, end } = sessionDateRange;
    if (!start && !end) return 'all';
    for (const p of DATE_PRESETS) {
      const range = presetToRange(p.id);
      if (range.start === start && range.end === end) return p.id;
    }
    return 'custom';
  }, [sessionDateRange]);

  const handleDatePreset = useCallback(
    (preset: DatePreset) => {
      setSessionDateRange(presetToRange(preset));
    },
    [setSessionDateRange],
  );

  const handleCustomDate = useCallback(
    (field: 'start' | 'end', value: string) => {
      const next = { ...sessionDateRange, [field]: value || undefined };
      setSessionDateRange(next);
    },
    [sessionDateRange, setSessionDateRange],
  );

  useEffect(() => {
    usePmStore.getState().fetchProjects();
    usePmStore.getState().fetchSessionStats();
    usePmStore.getState().fetchProjectSummaries();
    usePmStore.getState().fetchCategories();
  }, []);

  // Category-filtered summaries
  const filteredSummaries = useMemo(() => {
    if (!categoryFilter) return projectSummaries;
    if (categoryFilter === '__none') return projectSummaries.filter((p) => !p.category);
    return projectSummaries.filter((p) => p.category === categoryFilter);
  }, [projectSummaries, categoryFilter]);

  // Metric card values — computed from filtered summaries so they update with category
  const filteredStats = useMemo(() => {
    const source = categoryFilter ? filteredSummaries : null;
    if (source) {
      const totalSessions = source.reduce((s, p) => s + p.session_count, 0);
      const totalCostMicro = source.reduce((s, p) => s + p.total_cost, 0);
      const totalMinutes = source.reduce((s, p) => s + p.total_active_minutes, 0);
      return { totalSessions, totalCostMicro, totalMinutes };
    }
    // No category filter — use server stats
    return sessionStats
      ? {
          totalSessions: sessionStats.totalSessions,
          totalCostMicro: sessionStats.totalCostMicrodollars,
          totalMinutes: sessionStats.totalActiveMinutes,
        }
      : { totalSessions: 0, totalCostMicro: 0, totalMinutes: 0 };
  }, [categoryFilter, filteredSummaries, sessionStats]);

  const handleExportCsv = useCallback(() => {
    const params = new URLSearchParams();
    const { start, end } = sessionDateRange;
    if (start) params.set('start_date', start);
    if (end) params.set('end_date', end);
    if (hideEmpty) params.set('hide_empty', 'true');
    if (categoryFilter) {
      const ids = filteredSummaries.map((p) => p.id);
      if (ids.length > 0) params.set('project_ids', ids.join(','));
    }
    const url = `/api/pm/projects/export-csv?${params.toString()}`;
    window.open(url, '_blank');
  }, [sessionDateRange, hideEmpty, categoryFilter, filteredSummaries]);

  const totalCost = formatCost(filteredStats.totalCostMicro);
  const totalActiveTime = formatActiveTime(filteredStats.totalMinutes);
  const avgCost =
    filteredStats.totalSessions > 0
      ? formatCost(filteredStats.totalCostMicro / filteredStats.totalSessions)
      : '$0.00';

  // Unique categories from projects (not summaries, since categories come from pm_projects)
  const categories = usePmStore((s) => s.categories);

  const columns = useMemo(() => makeColumns(runtimeProjects), [runtimeProjects]);

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <div className="p-6 space-y-5">
          {/* Header + controls row */}
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <h1 className="text-xl font-bold text-text-primary">{getGreeting()}, Edwin</h1>
              <p className="text-[13px] text-text-tertiary mt-0.5">
                Here's what's happening across your {projects.length} projects
              </p>
            </div>

            <div className="flex items-center gap-2">
              {/* Export CSV */}
              <button
                type="button"
                onClick={handleExportCsv}
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-bg-surface text-text-secondary hover:bg-bg-hover transition-colors cursor-pointer"
              >
                <Download size={12} />
                Export CSV
              </button>

              {/* Hide empty toggle */}
              <button
                type="button"
                onClick={() => setHideEmptySessions(!hideEmpty)}
                className={cn(
                  'inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-colors cursor-pointer',
                  hideEmpty
                    ? 'bg-amber-500/15 text-amber-400'
                    : 'bg-bg-surface text-text-muted hover:bg-bg-hover',
                )}
              >
                {hideEmpty ? <EyeOff size={12} /> : <Eye size={12} />}
                {hideEmpty ? 'Empty sessions hidden' : 'Show all sessions'}
              </button>
            </div>
          </div>

          {/* Date range toolbar */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1.5">
              {DATE_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => handleDatePreset(p.id)}
                  className={cn(
                    'px-3 py-1 rounded-full text-xs font-medium transition-colors cursor-pointer',
                    activeDatePreset === p.id
                      ? 'bg-accent text-text-inverse'
                      : 'bg-bg-surface text-text-secondary hover:bg-bg-hover',
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>

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

          {/* KPI Cards */}
          <div className="grid grid-cols-4 gap-3">
            <KpiCard
              icon={MessageSquare}
              label="Total Sessions"
              value={filteredStats.totalSessions.toLocaleString()}
              footerLabel="Across all projects"
            />
            <KpiCard
              icon={DollarSign}
              label="Total Cost"
              value={totalCost}
              footerLabel="API usage cost"
            />
            <KpiCard
              icon={Clock}
              label="Active Time"
              value={totalActiveTime}
              footerLabel="Total active time"
            />
            <KpiCard
              icon={TrendingUp}
              label="Avg Cost/Session"
              value={avgCost}
              footerLabel="Per session average"
            />
          </div>

          {/* Category Filter */}
          {categories.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => setCategoryFilter(null)}
                className={cn(
                  'px-3 py-1 rounded-full text-xs font-medium transition-colors cursor-pointer',
                  categoryFilter === null
                    ? 'bg-accent text-text-inverse'
                    : 'bg-bg-surface text-text-secondary hover:bg-bg-hover',
                )}
              >
                All ({projectSummaries.length})
              </button>
              {categories.map((cat) => {
                const count = projectSummaries.filter((p) => p.category === cat).length;
                return (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setCategoryFilter(categoryFilter === cat ? null : cat)}
                    className={cn(
                      'px-3 py-1 rounded-full text-xs font-medium transition-colors cursor-pointer',
                      categoryFilter === cat
                        ? 'bg-accent text-text-inverse'
                        : 'bg-bg-surface text-text-secondary hover:bg-bg-hover',
                    )}
                  >
                    {cat} ({count})
                  </button>
                );
              })}
              {projectSummaries.some((p) => !p.category) && (
                <button
                  type="button"
                  onClick={() => setCategoryFilter(categoryFilter === '__none' ? null : '__none')}
                  className={cn(
                    'px-3 py-1 rounded-full text-xs font-medium transition-colors cursor-pointer',
                    categoryFilter === '__none'
                      ? 'bg-accent text-text-inverse'
                      : 'bg-bg-surface text-text-muted hover:bg-bg-hover',
                  )}
                >
                  Uncategorized ({projectSummaries.filter((p) => !p.category).length})
                </button>
              )}
            </div>
          )}

          {/* Projects Table */}
          {filteredSummaries.length === 0 && !projectSummariesLoading ? (
            <EmptyState
              icon={<FolderKanban size={32} />}
              title={categoryFilter ? 'No projects in this category' : 'No projects yet'}
              description={
                categoryFilter
                  ? 'Try selecting a different category.'
                  : 'Projects will appear here once they are created.'
              }
            />
          ) : (
            <div className="rounded-lg border border-border-strong overflow-hidden bg-bg-surface">
              <DataTable
                columns={columns}
                data={filteredSummaries as any}
                onRowClick={(row) => {
                  const r = row as unknown as ProjectSummary;
                  useAppStore.getState().selectPmProject(r.id);
                }}
                emptyMessage={projectSummariesLoading ? 'Loading projects...' : 'No projects found'}
                defaultSort={{ key: 'total_cost', direction: 'desc' }}
              />
            </div>
          )}

          {/* Footer count */}
          <div className="text-xs text-text-tertiary">
            {filteredSummaries.length} project{filteredSummaries.length !== 1 ? 's' : ''}
            {categoryFilter ? ' (filtered)' : ''}
          </div>
        </div>
      </div>
    </div>
  );
}

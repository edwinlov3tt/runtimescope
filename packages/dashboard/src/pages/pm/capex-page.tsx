import { useState, useEffect, useMemo, memo } from 'react';
import { usePmStore } from '@/stores/use-pm-store';
import { useAppStore } from '@/stores/use-app-store';
import { MetricCard, DataTable, Badge, Button } from '@/components/ui';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import { DollarSign, Download, CheckCircle, TrendingUp, Clock } from 'lucide-react';
import { cn } from '@/lib/cn';
import { getCapexExportXlsxUrl } from '@/lib/pm-api';
import type {
  PmCapexEntry,
  CapexClassification,
  ProjectPhase,
  ProjectStatus,
} from '@/lib/pm-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatCost(microdollars: number): string {
  return `$${(microdollars / 1_000_000).toFixed(2)}`;
}

function formatHours(minutes: number): string {
  return (minutes / 60).toFixed(1);
}

const classificationVariant: Record<CapexClassification, 'green' | 'default'> = {
  capitalizable: 'green',
  expensed: 'default',
};

const phaseLabel: Record<ProjectPhase, string> = {
  preliminary: 'Preliminary',
  application_development: 'Application Development',
  post_implementation: 'Post-Implementation',
};

const statusLabel: Record<ProjectStatus, string> = {
  active: 'Active',
  suspended: 'Suspended',
  abandoned: 'Abandoned',
};

const statusVariant: Record<ProjectStatus, 'green' | 'amber' | 'red'> = {
  active: 'green',
  suspended: 'amber',
  abandoned: 'red',
};

const phaseVariant: Record<ProjectPhase, 'default' | 'blue' | 'green'> = {
  preliminary: 'default',
  application_development: 'blue',
  post_implementation: 'green',
};

// Stable chart style objects (hoisted to avoid re-creating on every render)
const CHART_TICK = { fill: 'var(--color-text-muted)', fontSize: 11, fontFamily: 'var(--font-mono, monospace)' };
const CHART_AXIS_LINE = { stroke: 'var(--color-border-muted)' };
const CHART_GRID = { stroke: 'var(--color-border-muted)', strokeDasharray: '3 3', strokeOpacity: 0.4 };
const CHART_TOOLTIP_STYLE: React.CSSProperties = {
  background: 'var(--color-bg-elevated)',
  border: '1px solid var(--color-border-default)',
  borderRadius: 8,
  padding: '10px 14px',
  boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
};
const CHART_TOOLTIP_LABEL_STYLE: React.CSSProperties = { color: 'var(--color-text-muted)', fontSize: 11, marginBottom: 4 };
const CHART_TICK_FORMATTER = (v: number) => `$${v.toFixed(0)}`;

/** Get ISO week string (e.g., "Mar 17") from a timestamp */
function getWeekLabel(ts: number): string {
  const d = new Date(ts);
  // Start of week (Monday)
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d);
  monday.setDate(diff);
  return monday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Get week key for grouping */
function getWeekKey(ts: number): string {
  const d = new Date(ts);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(d);
  monday.setDate(diff);
  return monday.toISOString().slice(0, 10);
}

/** Get day label (e.g., "Mar 17") */
function getDayLabel(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Get day key for grouping (YYYY-MM-DD) */
function getDayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

type ChartGranularity = 'week' | 'day';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const CapexPage = memo(function CapexPage({ projectId }: { projectId: string }) {
  const capexEntries = usePmStore((s) => s.capexEntries);
  const capexSummary = usePmStore((s) => s.capexSummary);
  const capexLoading = usePmStore((s) => s.capexLoading);
  const sessions = usePmStore((s) => s.sessions);
  const projects = usePmStore((s) => s.projects);

  const [confirmingAll, setConfirmingAll] = useState(false);
  const [chartGranularity, setChartGranularity] = useState<ChartGranularity>('week');

  const project = useMemo(
    () => projects.find((p) => p.id === projectId) ?? null,
    [projects, projectId],
  );

  // Fetch capex data on mount
  useEffect(() => {
    const store = usePmStore.getState();
    store.fetchCapex(projectId);
    store.fetchCapexSummary(projectId);
    store.fetchSessions(projectId);
  }, [projectId]);

  // Build a session lookup for display in the table
  const sessionMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of sessions) {
      map.set(s.id, s.slug || (s.firstPrompt ? s.firstPrompt.slice(0, 60) : s.id.slice(0, 8)));
    }
    return map;
  }, [sessions]);

  // Weekly or daily breakdown derived from entries
  const chartData = useMemo(() => {
    if (capexEntries.length === 0) return [];
    const buckets = new Map<string, { key: string; label: string; capitalizable: number; expensed: number; total: number }>();

    const getKey = chartGranularity === 'day' ? getDayKey : getWeekKey;
    const getLabel = chartGranularity === 'day' ? getDayLabel : getWeekLabel;

    for (const entry of capexEntries) {
      const ts = entry.createdAt;
      const key = getKey(ts);
      const existing = buckets.get(key) ?? { key, label: getLabel(ts), capitalizable: 0, expensed: 0, total: 0 };
      const cost = entry.adjustedCostMicrodollars / 1_000_000;
      if (entry.classification === 'capitalizable') {
        existing.capitalizable += cost;
      } else {
        existing.expensed += cost;
      }
      existing.total += cost;
      buckets.set(key, existing);
    }

    return Array.from(buckets.values())
      .sort((a, b) => a.key.localeCompare(b.key));
  }, [capexEntries, chartGranularity]);

  // Confirmed / total counts
  const confirmedCount = capexSummary?.confirmedCount ?? 0;
  const totalSessions = capexSummary?.totalSessions ?? 0;

  // -----------------------------------------------------------------------
  // Actions
  // -----------------------------------------------------------------------

  const handleConfirm = async (entryId: string) => {
    await usePmStore.getState().confirmCapexEntry(projectId, entryId);
    await usePmStore.getState().fetchCapexSummary(projectId);
  };

  const handleConfirmAll = async () => {
    setConfirmingAll(true);
    const store = usePmStore.getState();
    const unconfirmed = capexEntries.filter((e) => !e.confirmed);
    for (const entry of unconfirmed) {
      await store.confirmCapexEntry(projectId, entry.id);
    }
    await store.fetchCapexSummary(projectId);
    setConfirmingAll(false);
  };

  const handleExport = () => {
    window.open(getCapexExportXlsxUrl(projectId), '_blank');
  };

  // -----------------------------------------------------------------------
  // Table columns
  // -----------------------------------------------------------------------

  const columns = useMemo(
    () => [
      {
        key: 'sessionId',
        header: 'Session',
        render: (row: Record<string, unknown>) => {
          const r = row as unknown as PmCapexEntry;
          return (
            <span className="font-mono text-xs truncate max-w-[160px] inline-block">
              {sessionMap.get(r.sessionId) ?? r.sessionId.slice(0, 8)}
            </span>
          );
        },
      },
      {
        key: 'period',
        header: 'Date',
        sortable: true,
      },
      {
        key: 'activeMinutes',
        header: 'Active Mins',
        sortable: true,
        render: (row: Record<string, unknown>) => {
          const mins = (row as unknown as PmCapexEntry).activeMinutes;
          return mins === 0 ? '0' : mins.toFixed(1);
        },
      },
      {
        key: 'activeHours',
        header: 'Active Hours',
        sortable: true,
        render: (row: Record<string, unknown>) => {
          const mins = (row as unknown as PmCapexEntry).activeMinutes;
          return mins === 0 ? '0.00' : (mins / 60).toFixed(2);
        },
      },
      {
        key: 'costMicrodollars',
        header: 'Cost',
        sortable: true,
        render: (row: Record<string, unknown>) => formatCost((row as unknown as PmCapexEntry).costMicrodollars),
      },
      {
        key: 'classification',
        header: 'Classification',
        render: (row: Record<string, unknown>) => {
          const r = row as unknown as PmCapexEntry;
          return (
            <Badge variant={classificationVariant[r.classification]}>
              {r.classification}
            </Badge>
          );
        },
      },
      {
        key: 'workType',
        header: 'Work Type',
        render: (row: Record<string, unknown>) => (
          <span className="text-text-secondary text-xs">
            {((row as unknown as PmCapexEntry).workType) ?? '--'}
          </span>
        ),
      },
      {
        key: 'adjustmentFactor',
        header: 'Adjustment',
        render: (row: Record<string, unknown>) => `${(row as unknown as PmCapexEntry).adjustmentFactor}x`,
      },
      {
        key: 'adjustedCostMicrodollars',
        header: 'Adjusted Cost',
        sortable: true,
        render: (row: Record<string, unknown>) => formatCost((row as unknown as PmCapexEntry).adjustedCostMicrodollars),
      },
      {
        key: 'confirmed',
        header: 'Confirmed',
        render: (row: Record<string, unknown>) => {
          const r = row as unknown as PmCapexEntry;
          return r.confirmed ? (
            <CheckCircle size={14} className="text-green" />
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                handleConfirm(r.id);
              }}
            >
              Confirm
            </Button>
          );
        },
      },
    ],
    [sessionMap, projectId],
  );

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <div className="p-6 space-y-6 w-full">
          {/* Header + Action Bar */}
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-bold text-text-primary">
                CapEx Tracking
              </h1>
              <p className="text-sm text-text-tertiary mt-1">
                ASC 350-40 software capitalization
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={handleExport}>
                <Download size={14} />
                Export XLSX
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleConfirmAll}
                disabled={confirmingAll || confirmedCount >= totalSessions}
              >
                <CheckCircle size={14} />
                {confirmingAll ? 'Confirming...' : 'Confirm All'}
              </Button>
            </div>
          </div>

          {/* Settings Bar (read-only badges) */}
          {project && (
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-1.5 text-xs text-text-muted">
                Phase
                <Badge variant={phaseVariant[project.phase]} size="sm">
                  {phaseLabel[project.phase]}
                </Badge>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-text-muted">
                Status
                <Badge variant={statusVariant[project.projectStatus]} size="sm">
                  {statusLabel[project.projectStatus]}
                </Badge>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-text-muted">
                Mgmt Authorized
                <Badge
                  variant={project.managementAuthorized ? 'green' : 'default'}
                  size="sm"
                >
                  {project.managementAuthorized ? 'Yes' : 'No'}
                </Badge>
              </div>
              <div className="flex items-center gap-1.5 text-xs text-text-muted">
                Probable to Complete
                <Badge
                  variant={project.probableToComplete ? 'green' : 'default'}
                  size="sm"
                >
                  {project.probableToComplete ? 'Yes' : 'No'}
                </Badge>
              </div>
            </div>
          )}

          {/* Summary Metric Cards */}
          <div className="grid grid-cols-5 gap-4">
            <MetricCard
              label="Active Hours"
              value={capexSummary ? `${formatHours(capexSummary.totalActiveMinutes)}h` : '0h'}
              icon={<Clock size={16} />}
            />
            <MetricCard
              label="Total Cost"
              value={capexSummary ? formatCost(capexSummary.totalCostMicrodollars) : '$0.00'}
              icon={<DollarSign size={16} />}
            />
            <MetricCard
              label="Capitalizable"
              value={
                capexSummary
                  ? formatCost(capexSummary.capitalizableCostMicrodollars)
                  : '$0.00'
              }
              icon={<TrendingUp size={16} />}
              className="border-green-border"
            />
            <MetricCard
              label="Expensed"
              value={
                capexSummary
                  ? formatCost(capexSummary.expensedCostMicrodollars)
                  : '$0.00'
              }
              icon={<DollarSign size={16} />}
            />
            <MetricCard
              label="Confirmation Progress"
              value={`${confirmedCount}/${totalSessions} confirmed`}
              icon={<CheckCircle size={16} />}
            />
          </div>

          {/* Weekly Spend Chart */}
          {chartData.length > 0 && (
            <div className="rounded-lg border border-border-default bg-bg-elevated p-5">
              <div className="flex items-center justify-between mb-5">
                <div>
                  <h2 className="text-sm font-semibold text-text-primary">
                    Spend Breakdown
                  </h2>
                  <p className="text-[11px] text-text-tertiary mt-0.5">
                    By classification per {chartGranularity}
                  </p>
                </div>
                <div className="flex items-center gap-5">
                  <div className="flex items-center gap-4">
                    <div className="flex items-center gap-1.5">
                      <div className="w-2.5 h-2.5 rounded-full bg-green" />
                      <span className="text-[11px] text-text-muted">Capitalizable</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <div className="w-2.5 h-2.5 rounded-full bg-text-muted" />
                      <span className="text-[11px] text-text-muted">Expensed</span>
                    </div>
                  </div>
                  <div className="flex items-center rounded-md border border-border-default overflow-hidden">
                    <button
                      onClick={() => setChartGranularity('day')}
                      className={cn(
                        'px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider transition-colors cursor-pointer',
                        chartGranularity === 'day' ? 'bg-brand/10 text-brand' : 'text-text-muted hover:text-text-secondary',
                      )}
                    >
                      Day
                    </button>
                    <button
                      onClick={() => setChartGranularity('week')}
                      className={cn(
                        'px-2.5 py-1 text-[10px] font-medium uppercase tracking-wider transition-colors cursor-pointer border-l border-border-default',
                        chartGranularity === 'week' ? 'bg-brand/10 text-brand' : 'text-text-muted hover:text-text-secondary',
                      )}
                    >
                      Week
                    </button>
                  </div>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="gradCap" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#22c55e" stopOpacity={0.25} />
                      <stop offset="100%" stopColor="#22c55e" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="gradExp" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#6b7280" stopOpacity={0.2} />
                      <stop offset="100%" stopColor="#6b7280" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid {...CHART_GRID} vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={CHART_TICK}
                    axisLine={CHART_AXIS_LINE}
                    tickLine={false}
                  />
                  <YAxis
                    tick={CHART_TICK}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={CHART_TICK_FORMATTER}
                    width={50}
                  />
                  <Tooltip
                    contentStyle={CHART_TOOLTIP_STYLE}
                    labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                    formatter={(value: number) => [`$${value.toFixed(2)}`, '']}
                    separator=""
                  />
                  <Area
                    type="monotone"
                    dataKey="capitalizable"
                    name="Capitalizable"
                    stroke="#22c55e"
                    strokeWidth={2}
                    fill="url(#gradCap)"
                    dot={{ r: 3, fill: '#22c55e', strokeWidth: 0 }}
                    activeDot={{ r: 5, fill: '#22c55e', stroke: '#1a1a2e', strokeWidth: 2 }}
                  />
                  <Area
                    type="monotone"
                    dataKey="expensed"
                    name="Expensed"
                    stroke="#6b7280"
                    strokeWidth={2}
                    fill="url(#gradExp)"
                    dot={{ r: 3, fill: '#6b7280', strokeWidth: 0 }}
                    activeDot={{ r: 5, fill: '#6b7280', stroke: '#1a1a2e', strokeWidth: 2 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* Entry Table */}
          <div className="rounded-lg border border-border-default bg-bg-elevated">
            <div className="px-5 py-3 border-b border-border-default">
              <h2 className="text-sm font-semibold text-text-primary">
                CapEx Entries
              </h2>
            </div>
            <DataTable
              columns={columns}
              data={capexEntries as unknown as Record<string, unknown>[]}
              emptyMessage={capexLoading ? 'Loading entries...' : 'No CapEx entries found'}
              defaultSort={{ key: 'period', direction: 'desc' }}
            />
          </div>
        </div>
      </div>
    </div>
  );
});

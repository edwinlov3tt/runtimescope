import { useState, useEffect, useMemo, memo } from 'react';
import { usePmStore } from '@/stores/use-pm-store';
import { useAppStore } from '@/stores/use-app-store';
import { MetricCard, DataTable, Badge, Button } from '@/components/ui';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { DollarSign, Download, CheckCircle, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/cn';
import { getCapexExportUrl } from '@/lib/pm-api';
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
const CHART_TICK = { fill: '#6b7280', fontSize: 11 };
const CHART_AXIS_LINE = { stroke: '#2a2a4a' };
const CHART_TOOLTIP_STYLE = {
  background: '#1a1a2e',
  border: '1px solid #2a2a4a',
  borderRadius: 8,
};
const CHART_TOOLTIP_LABEL_STYLE = { color: '#9ca3af' };
const CHART_LEGEND_STYLE = { fontSize: 12, color: '#9ca3af' };
const CHART_TICK_FORMATTER = (v: number) => `$${v.toFixed(0)}`;
const CHART_TOOLTIP_FORMATTER = (value: number | undefined) =>
  value != null ? `$${value.toFixed(2)}` : '';

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

  // Chart data from summary
  const chartData = useMemo(() => {
    if (!capexSummary?.byMonth) return [];
    return capexSummary.byMonth.map((m) => ({
      period: m.period,
      capitalizable: m.capitalizable / 1_000_000,
      expensed: m.expensed / 1_000_000,
    }));
  }, [capexSummary]);

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
    window.open(getCapexExportUrl(projectId), '_blank');
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
        render: (row: Record<string, unknown>) => String((row as unknown as PmCapexEntry).activeMinutes),
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
                Export CSV
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
          <div className="grid grid-cols-4 gap-4">
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

          {/* Monthly Chart */}
          {chartData.length > 0 && (
            <div className="rounded-lg border border-border-default bg-bg-elevated p-5">
              <h2 className="text-sm font-semibold text-text-primary mb-4">
                Monthly Breakdown
              </h2>
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={chartData}>
                  <XAxis
                    dataKey="period"
                    tick={CHART_TICK}
                    axisLine={CHART_AXIS_LINE}
                    tickLine={false}
                  />
                  <YAxis
                    tick={CHART_TICK}
                    axisLine={CHART_AXIS_LINE}
                    tickLine={false}
                    tickFormatter={CHART_TICK_FORMATTER}
                  />
                  <Tooltip
                    contentStyle={CHART_TOOLTIP_STYLE}
                    formatter={CHART_TOOLTIP_FORMATTER}
                    labelStyle={CHART_TOOLTIP_LABEL_STYLE}
                  />
                  <Legend
                    wrapperStyle={CHART_LEGEND_STYLE}
                  />
                  <Bar
                    dataKey="capitalizable"
                    name="Capitalizable"
                    stackId="cost"
                    fill="#22c55e"
                    radius={[0, 0, 0, 0]}
                  />
                  <Bar
                    dataKey="expensed"
                    name="Expensed"
                    stackId="cost"
                    fill="#6b7280"
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
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

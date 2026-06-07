import { memo, useState, useRef, useEffect } from 'react';
import { cn } from '@/lib/cn';
import {
  Bell,
  AlertCircle,
  Globe,
  Layers,
  Database,
  Gauge,
  CheckCheck,
  ArrowRight,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAppStore } from '@/stores/use-app-store';
import { usePmStore } from '@/stores/use-pm-store';
import { useNotificationStore } from '@/stores/use-notification-store';
import { useDetectedIssues } from '@/hooks/use-detected-issues';
import { formatRelativeTime } from '@/lib/format';
import type { IssueSeverity } from '@/lib/runtime-types';

// ---------------------------------------------------------------------------
// Real notifications are derived from the live event store via detectIssues()
// — the same detector the Issues page uses (src/pages/issues/issues-page.tsx).
// There is no mock data and no parallel detection path: an empty store yields
// an empty bell. Read-state and per-alert "first seen" timestamps are persisted
// per-browser in localStorage via useNotificationStore.
// ---------------------------------------------------------------------------

const SEVERITY_COLORS = {
  critical: { bg: 'bg-red-muted', text: 'text-red', dot: 'bg-red' },
  warning:  { bg: 'bg-amber-muted', text: 'text-amber', dot: 'bg-amber' },
  info:     { bg: 'bg-blue-muted', text: 'text-blue', dot: 'bg-blue' },
} as const;

type NotifSeverity = keyof typeof SEVERITY_COLORS;

const SEVERITY_MAP: Record<IssueSeverity, NotifSeverity> = {
  high: 'critical',
  medium: 'warning',
  low: 'info',
};

// Map a detector pattern to a header icon + human source label.
function patternMeta(pattern: string): { icon: LucideIcon; source: string } {
  if (pattern.startsWith('failed') || pattern.startsWith('slow_request') || pattern.startsWith('n1_request')) {
    return { icon: Globe, source: 'Network' };
  }
  if (pattern.startsWith('console') || pattern.startsWith('high_error')) {
    return { icon: AlertCircle, source: 'Console' };
  }
  if (pattern.startsWith('excessive_rerender')) return { icon: Layers, source: 'Renders' };
  if (pattern.startsWith('large_state')) return { icon: Layers, source: 'State' };
  if (pattern.startsWith('poor_web_vital')) return { icon: Gauge, source: 'Performance' };
  if (pattern.includes('db_quer')) return { icon: Database, source: 'Database' };
  return { icon: AlertCircle, source: 'Issue' };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const NotificationDropdown = memo(function NotificationDropdown() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const selectedProject = useAppStore((s) => s.selectedProject);
  const selectedPmProject = useAppStore((s) => s.selectedPmProject);
  const pmProjects = usePmStore((s) => s.projects);
  // selectedProject is null whenever a PM project is selected (selectPmProject
  // clears it), so fall back to the PM project name for the per-row badge.
  const pmProjectName = pmProjects.find((p) => p.id === selectedPmProject)?.name;
  const projectLabel = selectedProject ?? pmProjectName ?? null;

  const readIds = useNotificationStore((s) => s.readIds);
  const firstSeen = useNotificationStore((s) => s.firstSeen);
  const observe = useNotificationStore((s) => s.observe);
  const markRead = useNotificationStore((s) => s.markRead);
  const markAllReadAction = useNotificationStore((s) => s.markAllRead);

  // Shared, cross-component-memoized detection (same result the Issues page and
  // overview use) — one computation per commit instead of three.
  const issues = useDetectedIssues();

  // Stamp first-seen times for new alerts AND reconcile read-state against the
  // live detection set. Must run on the empty set too: detector ids are stable
  // (e.g. 'slow-requests'), so when an issue clears we have to forget its
  // read-state, otherwise its later recurrence would stay silenced forever.
  useEffect(() => {
    observe(issues.map((i) => i.id));
  }, [issues, observe]);

  const unreadCount = issues.filter((i) => !readIds.has(i.id)).length;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);

  const markAllRead = () => {
    markAllReadAction(issues.map((i) => i.id));
  };

  // "View All Notifications" → deep-link into the existing Issues page. When a
  // PM project is open the Issues tab lives inside the project view
  // (runtimeSubTab); otherwise fall back to the legacy runtime view.
  const viewAll = () => {
    const app = useAppStore.getState();
    if (app.selectedPmProject) {
      // The Issues sub-tab only mounts when the project view is on the Runtime
      // tab, so switch to it as well — otherwise setting runtimeSubTab alone is
      // a no-op from the default (Sessions) project tab.
      app.setActiveProjectTab('runtime');
      app.setRuntimeSubTab('issues');
    } else {
      app.setActiveView('runtime');
      app.setActiveTab('issues');
    }
    setOpen(false);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className="w-9 h-9 rounded-lg flex items-center justify-center bg-bg-surface border border-border-default text-text-tertiary hover:border-border-hover hover:text-text-primary transition-all relative cursor-pointer"
      >
        <Bell size={16} />
        {unreadCount > 0 && (
          <span className="absolute top-[7px] right-[7px] w-[7px] h-[7px] rounded-full bg-red" />
        )}
      </button>

      {open && (
        <div className="absolute top-[calc(100%+8px)] right-0 w-[420px] bg-bg-surface border border-border-strong rounded-lg shadow-lg z-[100] overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-3.5 py-3 border-b border-border-muted">
            <span className="text-sm font-bold text-text-primary flex items-center gap-2">
              Notifications
              {unreadCount > 0 && (
                <span className="text-[10px] font-bold text-white bg-red px-[7px] py-px rounded-full">
                  {unreadCount}
                </span>
              )}
            </span>
            {unreadCount > 0 && (
              <button
                onClick={(e) => { e.stopPropagation(); markAllRead(); }}
                className="text-[11px] font-medium text-text-muted flex items-center gap-1.5 px-2 py-1 rounded hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
              >
                <CheckCheck size={13} />
                Mark all read
              </button>
            )}
          </div>

          {/* Items */}
          <div className="max-h-[380px] overflow-y-auto">
            {issues.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-1.5 px-3.5 py-10 text-center">
                <CheckCheck size={22} className="text-text-disabled" />
                <span className="text-[12px] text-text-tertiary">No issues detected</span>
                <span className="text-[11px] text-text-disabled">Issues from the live event store appear here</span>
              </div>
            ) : (
              issues.map((issue) => {
                const { icon: Icon, source } = patternMeta(issue.pattern);
                const severity = SEVERITY_MAP[issue.severity];
                const sev = SEVERITY_COLORS[severity];
                const unread = !readIds.has(issue.id);
                const seenAt = firstSeen[issue.id];
                return (
                  <div
                    key={issue.id}
                    onClick={() => markRead(issue.id)}
                    className={cn(
                      'flex items-start gap-2.5 px-3.5 py-2.5 border-b border-border-muted cursor-pointer transition-colors hover:bg-bg-hover',
                      !unread && 'opacity-55',
                    )}
                  >
                    <div className={cn('w-8 h-8 rounded-md flex items-center justify-center shrink-0 mt-px', sev.bg)}>
                      <Icon size={15} className={sev.text} />
                    </div>
                    <div className="flex-1 min-w-0 flex flex-col gap-[3px]">
                      <span className="text-[12px] font-semibold text-text-primary truncate">{issue.title}</span>
                      <span className="text-[11px] text-text-tertiary truncate">{issue.description}</span>
                      <div className="flex items-center gap-[5px] mt-px">
                        {projectLabel && (
                          <span className="text-[9px] font-semibold px-1.5 py-px rounded bg-bg-overlay text-text-secondary">{projectLabel}</span>
                        )}
                        <span className="text-[9px] font-semibold px-1.5 py-px rounded bg-bg-overlay text-text-muted">{source}</span>
                        {seenAt !== undefined && (
                          <span className="text-[9px] font-medium text-text-disabled ml-auto shrink-0">{formatRelativeTime(seenAt)}</span>
                        )}
                      </div>
                    </div>
                    {unread && (
                      <div className="w-[7px] h-[7px] rounded-full bg-accent shrink-0 mt-3" />
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Footer — View All deep-links into the Issues page */}
          {issues.length > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); viewAll(); }}
              className="w-full flex items-center justify-center gap-1.5 px-3.5 py-2.5 border-t border-border-muted text-[11px] font-medium text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
            >
              View all notifications
              <ArrowRight size={12} />
            </button>
          )}
        </div>
      )}
    </div>
  );
});

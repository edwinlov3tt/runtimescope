import { memo, useState, useRef, useEffect } from 'react';
import { cn } from '@/lib/cn';
import {
  Bell,
  AlertCircle,
  Globe,
  Layers,
  Database,
  Gauge,
  Footprints,
  CheckCheck,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// ---------------------------------------------------------------------------
// Notification data
// ---------------------------------------------------------------------------

interface Notification {
  id: number;
  severity: 'critical' | 'warning' | 'info';
  icon: LucideIcon;
  title: string;
  desc: string;
  project: string;
  source: string;
  time: string;
  unread: boolean;
}

const SEVERITY_COLORS = {
  critical: { bg: 'bg-red-muted', text: 'text-red', dot: 'bg-red' },
  warning:  { bg: 'bg-amber-muted', text: 'text-amber', dot: 'bg-amber' },
  info:     { bg: 'bg-blue-muted', text: 'text-blue', dot: 'bg-blue' },
} as const;

// Sample notifications — in production these come from the event store
const SAMPLE_NOTIFICATIONS: Notification[] = [
  { id: 1, severity: 'critical', icon: AlertCircle, title: "TypeError in worker.ts:142", desc: "Cannot read properties of undefined (reading 'status')", project: 'runtime-profiler', source: 'Console', time: '2m ago', unread: true },
  { id: 2, severity: 'critical', icon: Globe, title: '503 on POST /api/deploy/rollback', desc: 'Service Unavailable — deployment lock active (4,200ms)', project: 'flowAI', source: 'Network', time: '5m ago', unread: true },
  { id: 3, severity: 'warning', icon: Layers, title: 'Excessive re-renders: Dashboard', desc: '847 renders detected — flagged as suspicious component', project: 'runtime-profiler', source: 'Renders', time: '8m ago', unread: true },
  { id: 4, severity: 'warning', icon: Database, title: 'Slow query: SELECT * FROM pm_sessions', desc: '520ms execution time exceeds 500ms threshold', project: 'gtm-helper', source: 'Database', time: '12m ago', unread: true },
  { id: 5, severity: 'warning', icon: Gauge, title: 'LCP degraded to 3.2s', desc: 'Largest Contentful Paint regressed from 1.8s — poor', project: 'personal-site', source: 'Performance', time: '18m ago', unread: false },
  { id: 6, severity: 'info', icon: Globe, title: 'N+1 request pattern detected', desc: 'GET /api/users called 8x in 2s window', project: 'runtime-profiler', source: 'Network', time: '32m ago', unread: false },
  { id: 7, severity: 'info', icon: Footprints, title: 'deploy:failed breadcrumb recorded', desc: 'Rollback unsuccessful — manual intervention required', project: 'flowAI', source: 'Breadcrumbs', time: '45m ago', unread: false },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const NotificationDropdown = memo(function NotificationDropdown() {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState(SAMPLE_NOTIFICATIONS);
  const ref = useRef<HTMLDivElement>(null);

  const unreadCount = notifications.filter((n) => n.unread).length;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);

  const markAllRead = () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, unread: false })));
  };

  const markRead = (id: number) => {
    setNotifications((prev) => prev.map((n) => n.id === id ? { ...n, unread: false } : n));
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
            <button
              onClick={(e) => { e.stopPropagation(); markAllRead(); }}
              className="text-[11px] font-medium text-text-muted flex items-center gap-1.5 px-2 py-1 rounded hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
            >
              <CheckCheck size={13} />
              Mark all read
            </button>
          </div>

          {/* Items */}
          <div className="max-h-[380px] overflow-y-auto">
            {notifications.map((n) => {
              const Icon = n.icon;
              const sev = SEVERITY_COLORS[n.severity];
              return (
                <div
                  key={n.id}
                  onClick={() => markRead(n.id)}
                  className={cn(
                    'flex items-start gap-2.5 px-3.5 py-2.5 border-b border-border-muted cursor-pointer transition-colors hover:bg-bg-hover',
                    !n.unread && 'opacity-55',
                  )}
                >
                  <div className={cn('w-8 h-8 rounded-md flex items-center justify-center shrink-0 mt-px', sev.bg)}>
                    <Icon size={15} className={sev.text} />
                  </div>
                  <div className="flex-1 min-w-0 flex flex-col gap-[3px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12px] font-semibold text-text-primary truncate flex-1">{n.title}</span>
                      <span className="text-[10px] text-text-disabled shrink-0">{n.time}</span>
                    </div>
                    <span className="text-[11px] text-text-tertiary truncate">{n.desc}</span>
                    <div className="flex items-center gap-[5px] mt-px">
                      <span className="text-[9px] font-semibold px-1.5 py-px rounded bg-bg-overlay text-text-secondary">{n.project}</span>
                      <span className="text-[9px] font-semibold px-1.5 py-px rounded bg-bg-overlay text-text-muted">{n.source}</span>
                    </div>
                  </div>
                  {n.unread && (
                    <div className="w-[7px] h-[7px] rounded-full bg-accent shrink-0 mt-3" />
                  )}
                </div>
              );
            })}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-center px-3.5 py-2 border-t border-border-muted">
            <button className="text-[12px] font-semibold text-accent px-3 py-1 rounded-md hover:bg-accent-muted transition-colors cursor-pointer">
              View All Notifications
            </button>
          </div>
        </div>
      )}
    </div>
  );
});

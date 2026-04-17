import { memo, useState, useRef, useEffect } from 'react';
import { cn } from '@/lib/cn';
import { useAppStore } from '@/stores/use-app-store';
import { usePmStore } from '@/stores/use-pm-store';
import { findRuntimeProjects } from '@/lib/api';
import { NotificationDropdown } from '@/components/layout/notification-dropdown';
import {
  PanelLeft,
  Search,
  ChevronDown,
  Calendar,
  EyeOff,
  Maximize2,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Project Dropdown
// ---------------------------------------------------------------------------

function ProjectDropdown({ open, onClose }: { open: boolean; onClose: () => void }) {
  const projects = usePmStore((s) => s.projects);
  const runtimeProjects = useAppStore((s) => s.projects);
  const selectedPmProject = useAppStore((s) => s.selectedPmProject);
  const selectPmProject = useAppStore((s) => s.selectPmProject);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [open, onClose]);

  if (!open) return null;

  const filtered = search.trim()
    ? projects.filter((p) => p.name.toLowerCase().includes(search.trim().toLowerCase()))
    : projects;

  return (
    <div
      ref={ref}
      className="absolute top-[calc(100%+4px)] left-0 w-[380px] bg-bg-surface border border-border-strong rounded-lg shadow-lg z-[100] overflow-hidden"
    >
      <div className="relative p-2.5 border-b border-border-muted">
        <Search size={13} className="absolute left-5 top-1/2 -translate-y-1/2 text-text-muted" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search projects..."
          className="w-full h-8 bg-bg-input border border-border-strong rounded-md pl-8 pr-2.5 text-[12px] text-text-primary outline-none focus:border-accent-border"
          onClick={(e) => e.stopPropagation()}
        />
      </div>
      <div className="max-h-60 overflow-y-auto p-1">
        {filtered.map((p) => {
          const isSelected = p.id === selectedPmProject;
          return (
            <button
              key={p.id}
              onClick={(e) => {
                e.stopPropagation();
                selectPmProject(p.id);
                onClose();
              }}
              className={cn(
                'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-left transition-colors cursor-pointer',
                isSelected ? 'bg-accent-muted' : 'hover:bg-bg-hover',
              )}
            >
              {(() => {
                const rps = findRuntimeProjects(runtimeProjects, { runtimescopeProject: p.runtimescopeProject, runtimeApps: p.runtimeApps, name: p.name });
                const isLive = rps.some((r) => r.isConnected);
                return (
                  <>
                    <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', isLive ? 'bg-green animate-pulse-dot' : 'bg-text-muted')} />
                    <span className="flex-1 text-[13px] font-medium text-text-primary truncate">{p.name}</span>
                    <span className="text-[11px] text-text-muted font-mono">{isLive ? 'live' : 'offline'}</span>
                  </>
                );
              })()}
            </button>
          );
        })}
      </div>
      <div className="flex items-center justify-between px-3 py-2 border-t border-border-muted">
        <button className="text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-hover px-2 py-1 rounded-sm flex items-center gap-1 cursor-pointer">
          <EyeOff size={12} /> Show hidden
        </button>
        <button className="text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-hover px-2 py-1 rounded-sm flex items-center gap-1 cursor-pointer">
          <Maximize2 size={12} /> Full view
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

export const Header = memo(function Header({
  title,
  breadcrumb,
  onToggleSidebar,
  sidebarOpen,
}: {
  title: string;
  breadcrumb?: string;
  onToggleSidebar: () => void;
  sidebarOpen: boolean;
}) {
  const [projectOpen, setProjectOpen] = useState(false);
  const selectedPmProject = useAppStore((s) => s.selectedPmProject);
  const projects = usePmStore((s) => s.projects);

  const currentProject = projects.find((p) => p.id === selectedPmProject);
  const projectName = currentProject?.name ?? 'Select project';
  const runtimeProjects = useAppStore((s) => s.projects);
  const currentIsLive = currentProject
    ? findRuntimeProjects(runtimeProjects, { runtimescopeProject: currentProject.runtimescopeProject, runtimeApps: currentProject.runtimeApps, name: currentProject.name }).some((r) => r.isConnected)
    : false;

  return (
    <header className="h-[var(--header-height)] border-b border-border-muted flex items-center px-6 gap-4 shrink-0 bg-bg-base">
      {/* Sidebar toggle */}
      <button
        onClick={onToggleSidebar}
        className={cn(
          'w-8 h-8 rounded-md flex items-center justify-center shrink-0 mr-1 transition-all cursor-pointer',
          sidebarOpen
            ? 'text-accent bg-accent-muted'
            : 'text-text-muted hover:text-text-primary hover:bg-bg-hover',
        )}
      >
        <PanelLeft size={16} />
      </button>

      {/* Project dropdown */}
      <div className="relative">
        <div
          onClick={(e) => { e.stopPropagation(); setProjectOpen(!projectOpen); }}
          className="flex items-center gap-2 px-2.5 py-1.5 rounded-md cursor-pointer hover:bg-bg-hover transition-colors"
        >
          <span className={cn(
            'w-[7px] h-[7px] rounded-full shrink-0',
            currentIsLive ? 'bg-green' : 'bg-text-muted',
          )} />
          <span className="text-[15px] font-bold text-text-primary whitespace-nowrap">{projectName}</span>
          <ChevronDown size={14} className="text-text-muted" />
        </div>
        <ProjectDropdown open={projectOpen} onClose={() => setProjectOpen(false)} />
      </div>

      {/* Breadcrumbs */}
      <span className="text-text-muted text-sm">/</span>
      <span className="text-[13px] font-medium text-text-secondary">{title}</span>
      {breadcrumb && (
        <>
          <span className="text-text-muted text-sm">/</span>
          <span className="text-[13px] font-medium text-text-secondary">{breadcrumb}</span>
        </>
      )}

      {/* Search */}
      <div className="ml-auto flex items-center gap-2 h-9 w-[280px] px-3 bg-bg-surface border border-border-default rounded-lg text-text-muted text-[12px] cursor-pointer hover:border-border-hover transition-colors">
        <Search size={14} />
        <span className="flex-1">Search events, errors, routes...</span>
        <kbd className="font-mono text-[11px] px-1.5 py-0.5 bg-bg-elevated border border-accent-border rounded text-text-tertiary">
          ⌘K
        </kbd>
      </div>

      {/* Right section */}
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 h-9 px-3 bg-bg-surface border border-border-default rounded-lg text-[12px] font-medium text-text-primary cursor-pointer">
          <Calendar size={14} className="text-text-tertiary" />
          Today, Apr 6
        </div>

        {/* Notification bell */}
        <NotificationDropdown />

        {/* Avatar */}
        <div className="flex items-center gap-2 cursor-pointer px-2 py-1 rounded-md hover:bg-bg-hover transition-colors">
          <div className="w-8 h-8 rounded-full bg-border-strong" />
          <div className="flex flex-col leading-tight">
            <span className="text-[12px] font-semibold">Edwin L.</span>
            <span className="text-[10px] text-text-muted">Admin</span>
          </div>
        </div>
      </div>
    </header>
  );
});

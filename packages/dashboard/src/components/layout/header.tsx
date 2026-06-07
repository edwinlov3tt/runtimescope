import { memo, useState, useRef, useEffect } from 'react';
import { cn } from '@/lib/cn';
import { useAppStore } from '@/stores/use-app-store';
import { usePmStore } from '@/stores/use-pm-store';
import { useWorkspaceStore } from '@/stores/use-workspace-store';
import { useHiddenProjects } from '@/stores/use-hidden-projects';
import { findRuntimeProjects } from '@/lib/api';
import { NotificationDropdown } from '@/components/layout/notification-dropdown';
import { WorkspacePicker } from '@/components/layout/workspace-picker';
import { DateRangePicker } from '@/components/layout/date-range-picker';
import { CommandPalette } from '@/components/layout/command-palette';
import { useCommandPalette } from '@/hooks/use-command-palette';
import {
  PanelLeft,
  Search,
  ChevronDown,
  Eye,
  EyeOff,
  Maximize2,
  Settings,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Project Dropdown
// ---------------------------------------------------------------------------

function ProjectDropdown({ open, onClose }: { open: boolean; onClose: () => void }) {
  const projects = usePmStore((s) => s.projects);
  const runtimeProjects = useAppStore((s) => s.projects);
  const selectedPmProject = useAppStore((s) => s.selectedPmProject);
  const selectPmProject = useAppStore((s) => s.selectPmProject);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const hiddenIds = useHiddenProjects((s) => s.hiddenIds);
  const toggleHidden = useHiddenProjects((s) => s.toggleHidden);
  const [search, setSearch] = useState('');
  const [showHidden, setShowHidden] = useState(false);
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

  // Scope to the active workspace when one is selected. Null = "All workspaces".
  const scoped = activeWorkspaceId
    ? projects.filter((p) => p.workspaceId === activeWorkspaceId)
    : projects;
  const hiddenCount = scoped.filter((p) => hiddenIds.has(p.id)).length;
  // Hide hidden projects unless the user toggled "Show hidden".
  const visible = showHidden ? scoped : scoped.filter((p) => !hiddenIds.has(p.id));
  const filtered = search.trim()
    ? visible.filter((p) => p.name.toLowerCase().includes(search.trim().toLowerCase()))
    : visible;

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
          const isHidden = hiddenIds.has(p.id);
          const rps = findRuntimeProjects(runtimeProjects, { runtimescopeProject: p.runtimescopeProject, runtimeApps: p.runtimeApps, name: p.name });
          const isLive = rps.some((r) => r.isConnected);
          return (
            <div
              key={p.id}
              onClick={(e) => {
                e.stopPropagation();
                selectPmProject(p.id);
                onClose();
              }}
              className={cn(
                'group w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-left transition-colors cursor-pointer',
                isSelected ? 'bg-accent-muted' : 'hover:bg-bg-hover',
                isHidden && 'opacity-50',
              )}
            >
              <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', isLive ? 'bg-green animate-pulse-dot' : 'bg-text-muted')} />
              <span className="flex-1 text-[13px] font-medium text-text-primary truncate">{p.name}</span>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); toggleHidden(p.id); }}
                title={isHidden ? 'Unhide project' : 'Hide project'}
                aria-label={isHidden ? 'Unhide project' : 'Hide project'}
                className={cn(
                  'shrink-0 p-1 rounded-sm text-text-muted hover:text-text-primary hover:bg-bg-overlay transition-all cursor-pointer',
                  isHidden ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                )}
              >
                {isHidden ? <Eye size={12} /> : <EyeOff size={12} />}
              </button>
              <span className="w-[42px] text-right text-[11px] text-text-muted font-mono shrink-0">{isLive ? 'live' : 'offline'}</span>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div className="px-2.5 py-6 text-center text-[12px] text-text-muted">
            {hiddenCount > 0 && !showHidden ? 'All projects hidden' : 'No projects'}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between px-3 py-2 border-t border-border-muted">
        <button
          onClick={(e) => { e.stopPropagation(); setShowHidden((v) => !v); }}
          disabled={hiddenCount === 0}
          className="text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-hover px-2 py-1 rounded-sm flex items-center gap-1 cursor-pointer disabled:opacity-40 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-text-tertiary"
        >
          {showHidden ? <EyeOff size={12} /> : <Eye size={12} />}
          {showHidden ? 'Hide hidden' : `Show hidden${hiddenCount > 0 ? ` (${hiddenCount})` : ''}`}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); setActiveView('home'); onClose(); }}
          className="text-[11px] text-text-tertiary hover:text-text-primary hover:bg-bg-hover px-2 py-1 rounded-sm flex items-center gap-1 cursor-pointer"
        >
          <Maximize2 size={12} /> Full view
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Avatar menu
// ---------------------------------------------------------------------------

function AvatarMenu() {
  const setActiveView = useAppStore((s) => s.setActiveView);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [open]);

  const workspaceName = workspaces.find((w) => w.id === activeWorkspaceId)?.name ?? 'All workspaces';

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="flex items-center gap-2 cursor-pointer px-2 py-1 rounded-md hover:bg-bg-hover transition-colors"
      >
        <div className="w-8 h-8 rounded-full bg-border-strong" />
        <div className="flex flex-col leading-tight text-left">
          <span className="text-[12px] font-semibold text-text-primary truncate max-w-[120px]">{workspaceName}</span>
          <span className="text-[10px] text-text-muted">Workspace</span>
        </div>
        <ChevronDown size={12} className="text-text-muted" />
      </button>

      {open && (
        <div className="absolute top-[calc(100%+4px)] right-0 w-[180px] bg-bg-surface border border-border-strong rounded-lg shadow-lg z-[100] overflow-hidden p-1">
          <button
            onClick={(e) => { e.stopPropagation(); setActiveView('settings'); setOpen(false); }}
            className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-[13px] text-left text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
          >
            <Settings size={14} /> Settings
          </button>
        </div>
      )}
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
  const palette = useCommandPalette();
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

      {/* Workspace picker — only appears when there's > 1 workspace */}
      <WorkspacePicker />

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

      {/* Search — opens the command palette (⌘K) */}
      <button
        type="button"
        onClick={() => palette.setOpen(true)}
        aria-label="Open command palette"
        className="ml-auto flex items-center gap-2 h-9 w-[280px] px-3 bg-bg-surface border border-border-default rounded-lg text-text-muted text-[12px] cursor-pointer hover:border-border-hover transition-colors text-left"
      >
        <Search size={14} />
        <span className="flex-1">Search events, errors, routes...</span>
        <kbd className="font-mono text-[11px] px-1.5 py-0.5 bg-bg-elevated border border-accent-border rounded text-text-tertiary">
          ⌘K
        </kbd>
      </button>
      <CommandPalette open={palette.open} onClose={palette.close} />

      {/* Right section */}
      <div className="flex items-center gap-2">
        {/* Global date-range filter — scopes runtime event reads */}
        <DateRangePicker />

        {/* Notification bell */}
        <NotificationDropdown />

        {/* Avatar / workspace menu */}
        <AvatarMenu />
      </div>
    </header>
  );
});

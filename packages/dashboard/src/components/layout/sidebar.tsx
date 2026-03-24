import { useState, useMemo, memo } from 'react';
import { cn } from '@/lib/cn';
import { useAppStore } from '@/stores/use-app-store';
import { usePmStore } from '@/stores/use-pm-store';
import { findRuntimeProjects, type ProjectInfo } from '@/lib/api';
import { StatusDot } from '@/components/ui/status-dot';
import type { PmProject } from '@/lib/pm-types';
import {
  Home,
  FolderKanban,
  Settings,
  Search,
  ChevronRight,
  Wifi,
  WifiOff,
  Layers,
  FolderOpen,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProjectGroup {
  project: PmProject;
  apps: Array<{
    appName: string;
    isConnected: boolean;
    eventCount: number;
    projectId?: string;
  }>;
  isRegistered: boolean; // has .runtimescope/config.json (sdkInstalled or runtimeApps)
  isLive: boolean;
  connectedCount: number;
  totalApps: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildProjectGroups(
  pmProjects: PmProject[],
  runtimeProjects: ProjectInfo[],
): { registered: ProjectGroup[]; unregistered: ProjectGroup[] } {
  const allGroups: ProjectGroup[] = [];

  // Build a set of all app names claimed by multi-app projects (via runtimeApps)
  // These child apps should be hidden as standalone sidebar entries
  const childAppNames = new Set<string>();
  for (const project of pmProjects) {
    if (project.runtimeApps && project.runtimeApps.length > 1) {
      for (const app of project.runtimeApps) {
        childAppNames.add(app.toLowerCase());
      }
    }
  }

  for (const project of pmProjects) {
    // Skip this PM project if it's a child app nested under another project
    // (e.g., "gtm-web" when "gtm-helper" lists it in runtimeApps)
    const isChildOfAnother = childAppNames.has(project.name.toLowerCase()) &&
      !(project.runtimeApps && project.runtimeApps.length > 1);
    if (isChildOfAnother) {
      // Check if another project actually claims this one
      const parentExists = pmProjects.some(
        (p) => p.id !== project.id &&
          p.runtimeApps &&
          p.runtimeApps.length > 1 &&
          p.runtimeApps.some((a) => a.toLowerCase() === project.name.toLowerCase()),
      );
      if (parentExists) continue; // Skip — it's nested under the parent
    }

    const rps = findRuntimeProjects(runtimeProjects, {
      runtimescopeProject: project.runtimescopeProject,
      runtimeApps: project.runtimeApps,
      name: project.name,
    });

    const apps = rps.map((rp) => ({
      appName: rp.appName,
      isConnected: rp.isConnected,
      eventCount: rp.eventCount,
      projectId: rp.projectId,
    }));

    const isRegistered = !!(
      project.sdkInstalled ||
      (project.runtimeApps && project.runtimeApps.length > 0) ||
      project.runtimescopeProject ||
      rps.length > 0
    );

    const isLive = rps.some((r) => r.isConnected);
    const connectedCount = rps.filter((r) => r.isConnected).length;

    allGroups.push({
      project,
      apps,
      isRegistered,
      isLive,
      connectedCount,
      totalApps: rps.length,
    });
  }

  const registered: ProjectGroup[] = [];
  const unregistered: ProjectGroup[] = [];
  for (const group of allGroups) {
    if (group.isRegistered) {
      registered.push(group);
    } else {
      unregistered.push(group);
    }
  }

  // Sort: live projects first, then by name
  registered.sort((a, b) => {
    if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
    return a.project.name.localeCompare(b.project.name);
  });

  unregistered.sort((a, b) => a.project.name.localeCompare(b.project.name));

  return { registered, unregistered };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

const ProjectItem = memo(function ProjectItem({
  group,
  isActive,
  isExpanded,
  onSelect,
  onToggleExpand,
}: {
  group: ProjectGroup;
  isActive: boolean;
  isExpanded: boolean;
  onSelect: () => void;
  onToggleExpand: () => void;
}) {
  const hasApps = group.apps.length > 1;

  return (
    <div>
      <button
        onClick={onSelect}
        className={cn(
          'w-full flex items-center gap-2 h-8 px-2.5 rounded-md text-[13px] font-medium transition-colors cursor-pointer group',
          isActive
            ? 'bg-brand-muted text-text-primary'
            : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover',
        )}
      >
        {/* Expand arrow for multi-app projects */}
        {hasApps ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand();
            }}
            className="shrink-0 p-0.5 -ml-0.5 rounded hover:bg-bg-elevated transition-colors cursor-pointer"
          >
            <ChevronRight
              size={12}
              className={cn(
                'text-text-tertiary transition-transform',
                isExpanded && 'rotate-90',
              )}
            />
          </button>
        ) : (
          <FolderKanban
            size={15}
            strokeWidth={1.75}
            className={cn(
              'shrink-0',
              isActive ? 'text-brand' : 'text-text-tertiary',
            )}
          />
        )}

        <span className="truncate flex-1 text-left">{group.project.name}</span>

        {/* Status indicators */}
        {group.isLive && (
          <span className="flex items-center gap-1 shrink-0">
            <StatusDot color="green" size="sm" pulse />
            {hasApps && (
              <span className="text-[10px] text-green tabular-nums font-medium">
                {group.connectedCount}/{group.totalApps}
              </span>
            )}
          </span>
        )}
        {!group.isLive && group.isRegistered && group.totalApps > 0 && (
          <StatusDot color="blue" size="sm" />
        )}
        {isActive && (
          <div className="w-1 h-4 rounded-full bg-brand shrink-0" />
        )}
      </button>

      {/* Nested apps (expanded) */}
      {hasApps && isExpanded && (
        <div className="ml-4 mt-0.5 space-y-0.5">
          {group.apps.map((app) => (
            <div
              key={app.appName}
              className="flex items-center gap-2 h-7 px-2.5 rounded-md text-[12px] text-text-tertiary"
            >
              {app.isConnected ? (
                <Wifi size={11} className="text-green shrink-0" />
              ) : (
                <WifiOff size={11} className="text-text-muted shrink-0" />
              )}
              <span className="truncate flex-1">{app.appName}</span>
              {app.isConnected && (
                <span className="text-[10px] text-text-muted tabular-nums">
                  {app.eventCount}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

export const Sidebar = memo(function Sidebar() {
  const activeView = useAppStore((s) => s.activeView);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const selectedPmProject = useAppStore((s) => s.selectedPmProject);
  const selectPmProject = useAppStore((s) => s.selectPmProject);
  const pmProjects = usePmStore((s) => s.projects);
  const runtimeProjects = useAppStore((s) => s.projects);
  const [search, setSearch] = useState('');
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [showUnregistered, setShowUnregistered] = useState(false);

  const isHomeActive = activeView === 'home';

  const { registered, unregistered } = useMemo(
    () => buildProjectGroups(pmProjects, runtimeProjects),
    [pmProjects, runtimeProjects],
  );

  const filterGroups = (groups: ProjectGroup[]) => {
    if (!search.trim()) return groups;
    const q = search.trim().toLowerCase();
    return groups.filter(
      (g) =>
        g.project.name.toLowerCase().includes(q) ||
        g.apps.some((a) => a.appName.toLowerCase().includes(q)),
    );
  };

  const filteredRegistered = filterGroups(registered);
  const filteredUnregistered = filterGroups(unregistered);

  const toggleExpand = (projectId: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  // Count connected across all registered
  const liveCount = registered.filter((g) => g.isLive).length;

  return (
    <aside className="w-[240px] shrink-0 flex flex-col bg-bg-base border-r border-border-muted min-h-0">
      {/* Logo */}
      <div className="h-14 flex items-center gap-2.5 px-5 mt-2 shrink-0">
        <div className="w-6 h-6 rounded-md bg-brand-dark border border-brand-border flex items-center justify-center">
          <span className="text-brand-light text-xs font-bold">R</span>
        </div>
        <span className="text-sm font-semibold text-text-primary tracking-tight">
          RuntimeScope
        </span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-3 pb-4 space-y-4 min-h-0 overflow-y-auto">
        {/* Home */}
        <div className="space-y-0.5">
          <button
            onClick={() => setActiveView('home')}
            className={cn(
              'w-full flex items-center gap-2.5 h-8 px-2.5 rounded-md text-[13px] font-medium transition-colors cursor-pointer',
              isHomeActive
                ? 'bg-brand-muted text-text-primary'
                : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover',
            )}
          >
            <Home
              size={16}
              strokeWidth={1.75}
              className={cn(isHomeActive ? 'text-brand' : 'text-text-tertiary')}
            />
            Home
            {isHomeActive && (
              <div className="ml-auto w-1 h-4 rounded-full bg-brand" />
            )}
          </button>
        </div>

        {/* Search */}
        <div className="px-1.5">
          <div className="flex items-center gap-2 h-7 px-2 rounded-md bg-bg-surface border border-border-muted">
            <Search size={13} className="text-text-tertiary shrink-0" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search projects..."
              className="flex-1 bg-transparent text-[12px] text-text-primary placeholder:text-text-muted outline-none"
            />
          </div>
        </div>

        {/* Registered Projects */}
        <div>
          <div className="px-2 mb-1.5 flex items-center justify-between">
            <span className="text-[10px] font-medium text-text-muted uppercase tracking-widest">
              Projects
            </span>
            {liveCount > 0 && (
              <span className="text-[10px] text-green font-medium">
                {liveCount} live
              </span>
            )}
          </div>

          <div className="space-y-0.5">
            {filteredRegistered.map((group) => (
              <ProjectItem
                key={group.project.id}
                group={group}
                isActive={activeView === 'project' && selectedPmProject === group.project.id}
                isExpanded={expandedProjects.has(group.project.id)}
                onSelect={() => selectPmProject(group.project.id)}
                onToggleExpand={() => toggleExpand(group.project.id)}
              />
            ))}
            {filteredRegistered.length === 0 && !search.trim() && (
              <p className="px-2.5 py-2 text-[12px] text-text-muted italic">
                No projects registered. Run <code className="px-1 py-0.5 bg-bg-elevated rounded text-[11px]">/setup</code> in a project to get started.
              </p>
            )}
            {filteredRegistered.length === 0 && search.trim() && (
              <p className="px-2.5 text-[12px] text-text-muted italic">
                No matching projects
              </p>
            )}
          </div>
        </div>

        {/* Unregistered Projects */}
        {filteredUnregistered.length > 0 && (
          <div>
            <button
              onClick={() => setShowUnregistered(!showUnregistered)}
              className="w-full px-2 mb-1.5 flex items-center gap-1.5 cursor-pointer group"
            >
              <ChevronRight
                size={10}
                className={cn(
                  'text-text-muted transition-transform',
                  showUnregistered && 'rotate-90',
                )}
              />
              <span className="text-[10px] font-medium text-text-muted uppercase tracking-widest">
                Discovered
              </span>
              <span className="text-[10px] text-text-muted">
                ({filteredUnregistered.length})
              </span>
            </button>

            {showUnregistered && (
              <div className="space-y-0.5">
                {filteredUnregistered.map((group) => (
                  <button
                    key={group.project.id}
                    onClick={() => selectPmProject(group.project.id)}
                    className={cn(
                      'w-full flex items-center gap-2 h-7 px-2.5 rounded-md text-[12px] transition-colors cursor-pointer',
                      activeView === 'project' && selectedPmProject === group.project.id
                        ? 'bg-brand-muted text-text-primary'
                        : 'text-text-muted hover:text-text-secondary hover:bg-bg-hover',
                    )}
                  >
                    <FolderOpen size={13} strokeWidth={1.5} className="text-text-muted shrink-0" />
                    <span className="truncate flex-1 text-left">{group.project.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </nav>

      {/* Bottom */}
      <div className="px-3 pb-4">
        <button className="w-full flex items-center gap-2.5 h-8 px-2.5 rounded-md text-[13px] font-medium text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer">
          <Settings size={16} strokeWidth={1.75} className="text-text-tertiary" />
          Settings
        </button>
      </div>
    </aside>
  );
});

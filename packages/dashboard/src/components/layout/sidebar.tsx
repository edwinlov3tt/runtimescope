import { useState, memo } from 'react';
import { cn } from '@/lib/cn';
import { useAppStore } from '@/stores/use-app-store';
import { usePmStore } from '@/stores/use-pm-store';
import { findRuntimeProject } from '@/lib/api';
import { StatusDot } from '@/components/ui/status-dot';
import {
  Home,
  FolderKanban,
  Settings,
  Search,
  type LucideIcon,
} from 'lucide-react';

export const Sidebar = memo(function Sidebar() {
  const activeView = useAppStore((s) => s.activeView);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const selectedPmProject = useAppStore((s) => s.selectedPmProject);
  const selectPmProject = useAppStore((s) => s.selectPmProject);
  const pmProjects = usePmStore((s) => s.projects);
  const runtimeProjects = useAppStore((s) => s.projects);
  const [search, setSearch] = useState('');

  const isHomeActive = activeView === 'home';

  const filteredProjects = search.trim()
    ? pmProjects.filter((p) =>
        p.name.toLowerCase().includes(search.trim().toLowerCase())
      )
    : pmProjects;

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
                : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'
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

        {/* Projects */}
        <div>
          <div className="px-2 mb-1.5">
            <span className="text-[10px] font-medium text-text-muted uppercase tracking-widest">
              Projects
            </span>
          </div>

          {/* Search */}
          <div className="px-1.5 mb-2">
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

          <div className="space-y-0.5">
            {filteredProjects.map((project) => {
              const isActive = activeView === 'project' && selectedPmProject === project.id;
              const rp = findRuntimeProject(runtimeProjects, {
                runtimescopeProject: project.runtimescopeProject,
                name: project.name,
              });
              const isLive = rp?.isConnected;
              const isInstalled = !isLive && (project.sdkInstalled || !!rp);
              return (
                <button
                  key={project.id}
                  onClick={() => selectPmProject(project.id)}
                  className={cn(
                    'w-full flex items-center gap-2.5 h-8 px-2.5 rounded-md text-[13px] font-medium transition-colors cursor-pointer',
                    isActive
                      ? 'bg-brand-muted text-text-primary'
                      : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'
                  )}
                >
                  <FolderKanban
                    size={16}
                    strokeWidth={1.75}
                    className={cn(isActive ? 'text-brand' : 'text-text-tertiary')}
                  />
                  <span className="truncate flex-1 text-left">{project.name}</span>
                  {isLive && <StatusDot color="green" size="sm" pulse />}
                  {isInstalled && <StatusDot color="blue" size="sm" />}
                  {isActive && (
                    <div className="ml-auto w-1 h-4 rounded-full bg-brand" />
                  )}
                </button>
              );
            })}
            {filteredProjects.length === 0 && (
              <p className="px-2.5 text-[12px] text-text-muted italic">
                {search.trim() ? 'No matching projects' : 'No projects discovered'}
              </p>
            )}
          </div>
        </div>
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

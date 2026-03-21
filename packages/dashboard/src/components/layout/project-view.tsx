import { useState, useEffect, useRef, useCallback, memo, useMemo, lazy, Suspense } from 'react';
import { useAppStore } from '@/stores/use-app-store';
import { usePmStore } from '@/stores/use-pm-store';
import { useDataStore } from '@/stores/use-data-store';
import { useDevServerStore } from '@/stores/use-dev-server-store';
import { findRuntimeProject, findRuntimeProjects } from '@/lib/api';
import { Tabs } from '@/components/ui/tabs';
import { Badge, Button } from '@/components/ui';
import { StatusDot } from '@/components/ui/status-dot';
import { EmptyState } from '@/components/ui/empty-state';
import { ListSkeleton } from '@/components/ui/skeleton';
import { Tag, ChevronDown, Play, Square, Loader2, ExternalLink, Link2, Plus, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { startDevServer, stopDevServer, fetchProjectScripts } from '@/lib/pm-api';
import { boostProjectPoll } from '@/App';
import type { ProjectTab, PmProject } from '@/lib/pm-types';
import type { ProjectInfo } from '@/lib/api';

// Lazy-loaded tab pages
const RuntimePage = lazy(() => import('./runtime-page').then((m) => ({ default: m.RuntimePage })));
const TasksPage = lazy(() => import('@/pages/pm/tasks-page').then((m) => ({ default: m.TasksPage })));
const PmSessionsPage = lazy(() => import('@/pages/pm/sessions-page').then((m) => ({ default: m.PmSessionsPage })));
const NotesPage = lazy(() => import('@/pages/pm/notes-page').then((m) => ({ default: m.NotesPage })));
const MemoryPage = lazy(() => import('@/pages/pm/memory-page').then((m) => ({ default: m.MemoryPage })));
const RulesPage = lazy(() => import('@/pages/pm/rules-page').then((m) => ({ default: m.RulesPage })));
const CapexPage = lazy(() => import('@/pages/pm/capex-page').then((m) => ({ default: m.CapexPage })));
const GitPage = lazy(() => import('@/pages/pm/git-page').then((m) => ({ default: m.GitPage })));

const PROJECT_TABS: { id: ProjectTab; label: string }[] = [
  { id: 'sessions', label: 'Sessions' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'git', label: 'Git' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'notes', label: 'Notes' },
  { id: 'memory', label: 'Memory' },
  { id: 'rules', label: 'Rules' },
  { id: 'capex', label: 'CapEx' },
];

function HeaderCategoryBadge({ projectId, category }: { projectId: string; category?: string }) {
  const [open, setOpen] = useState(false);
  const [newCategory, setNewCategory] = useState('');
  const categories = usePmStore((s) => s.categories);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const handleSelect = (cat: string | null) => {
    usePmStore.getState().updateProject(projectId, { category: cat ?? undefined });
    setOpen(false);
  };

  const handleCreate = () => {
    const trimmed = newCategory.trim();
    if (!trimmed) return;
    usePmStore.getState().updateProject(projectId, { category: trimmed });
    usePmStore.getState().fetchCategories();
    setNewCategory('');
    setOpen(false);
  };

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          'inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium transition-colors cursor-pointer',
          category
            ? 'bg-purple-500/15 text-purple-400 hover:bg-purple-500/25'
            : 'bg-bg-surface text-text-muted hover:bg-bg-hover'
        )}
      >
        <Tag size={10} />
        {category || 'Uncategorized'}
        <ChevronDown size={10} />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 w-48 rounded-lg border border-border-default bg-bg-elevated shadow-lg overflow-hidden">
          <div className="py-1">
            {category && (
              <button
                type="button"
                onClick={() => handleSelect(null)}
                className="w-full px-3 py-1.5 text-left text-xs text-text-muted hover:bg-bg-hover cursor-pointer"
              >
                Remove category
              </button>
            )}
            {categories.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => handleSelect(cat)}
                className={cn(
                  'w-full px-3 py-1.5 text-left text-xs hover:bg-bg-hover cursor-pointer',
                  cat === category ? 'text-brand font-medium' : 'text-text-primary'
                )}
              >
                {cat}
              </button>
            ))}
          </div>
          <div className="border-t border-border-muted px-3 py-2 flex gap-1.5">
            <input
              type="text"
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              placeholder="New category..."
              className="flex-1 bg-transparent text-xs text-text-primary placeholder:text-text-muted outline-none"
            />
            {newCategory.trim() && (
              <button
                type="button"
                onClick={handleCreate}
                className="text-xs text-brand font-medium cursor-pointer"
              >
                Add
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dev Server Control (header badge + start/stop)
// ---------------------------------------------------------------------------

function DevServerControl({ project }: { project: PmProject }) {
  const runtimeProjects = useAppStore((s) => s.projects);
  const devState = useDevServerStore((s) => s.servers.get(project.id));
  const [loading, setLoading] = useState(false);
  const autoOpenedRef = useRef(false);

  // Check if live via SDK
  const rp = findRuntimeProject(runtimeProjects, {
    runtimescopeProject: project.runtimescopeProject,
    runtimeApps: project.runtimeApps,
    name: project.name,
  });
  const isLive = !!rp?.isConnected;

  // Dev server running via WS-pushed status
  const devStatus = devState?.status;
  const devPort = devState?.port ?? null;
  const devRunning = devStatus === 'running' || devStatus === 'starting';
  const isRunning = isLive || devRunning;

  // Auto-open browser tab when port is first detected
  useEffect(() => {
    if (devPort && !autoOpenedRef.current && devStatus === 'running') {
      autoOpenedRef.current = true;
      window.open(`http://localhost:${devPort}`, '_blank');
    }
    // Reset when server stops
    if (devStatus === 'idle' || devStatus === 'stopped' || devStatus === 'crashed') {
      autoOpenedRef.current = false;
    }
  }, [devPort, devStatus]);

  const handleStart = useCallback(async () => {
    setLoading(true);
    useDevServerStore.getState().setOptimisticStarting(project.id);
    try {
      const scripts = await fetchProjectScripts(project.id);
      await startDevServer(project.id, { script: scripts?.recommended ?? 'dev' });
      boostProjectPoll();
    } catch {
      useDevServerStore.getState().setStatus(project.id, 'idle');
    }
    setLoading(false);
  }, [project.id]);

  const handleStop = useCallback(async () => {
    setLoading(true);
    try {
      await stopDevServer(project.id);
      useDevServerStore.getState().setStatus(project.id, 'stopped');
    } catch { /* toast would go here */ }
    setLoading(false);
  }, [project.id]);

  if (!project.path) return null;

  // Starting state — show amber pulsing badge
  if (devStatus === 'starting') {
    return (
      <div className="flex items-center gap-1.5">
        <Badge variant="amber" size="sm">
          <Loader2 size={10} className="animate-spin" />
          Starting...
        </Badge>
        <button
          type="button"
          onClick={handleStop}
          disabled={loading}
          className="p-1 rounded hover:bg-bg-hover text-text-muted hover:text-red transition-colors cursor-pointer"
          title="Stop dev server"
        >
          <Square size={12} />
        </button>
      </div>
    );
  }

  if (isRunning) {
    return (
      <div className="flex items-center gap-1.5">
        <Badge variant="green" size="sm">
          <StatusDot color="green" size="sm" pulse />
          {devPort ? `Running on :${devPort}` : 'Running'}
        </Badge>
        {devPort && (
          <a
            href={`http://localhost:${devPort}`}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1 rounded hover:bg-bg-hover text-text-muted hover:text-brand transition-colors"
            title="Open in browser"
          >
            <ExternalLink size={12} />
          </a>
        )}
        <button
          type="button"
          onClick={handleStop}
          disabled={loading}
          className="p-1 rounded hover:bg-bg-hover text-text-muted hover:text-red transition-colors cursor-pointer"
          title="Stop dev server"
        >
          <Square size={12} />
        </button>
      </div>
    );
  }

  if (!project.sdkInstalled) return null;

  return (
    <button
      type="button"
      onClick={handleStart}
      disabled={loading}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-bg-surface text-text-muted hover:bg-bg-hover hover:text-text-primary transition-colors cursor-pointer"
    >
      <Play size={10} />
      {loading ? 'Starting...' : 'Start'}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Runtime Apps Badge (grouped SDK instances)
// ---------------------------------------------------------------------------

function RuntimeAppsBadge({ project }: { project: PmProject }) {
  const [open, setOpen] = useState(false);
  const [newApp, setNewApp] = useState('');
  const runtimeProjects = useAppStore((s) => s.projects);
  const ref = useRef<HTMLDivElement>(null);
  const apps = project.runtimeApps ?? (project.runtimescopeProject ? [project.runtimescopeProject] : []);
  const matchedRps = findRuntimeProjects(runtimeProjects, {
    runtimescopeProject: project.runtimescopeProject,
    runtimeApps: project.runtimeApps,
    name: project.name,
  });

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const handleAdd = () => {
    const trimmed = newApp.trim();
    if (!trimmed || apps.includes(trimmed)) return;
    const updated = [...apps, trimmed];
    usePmStore.getState().updateProject(project.id, { runtimeApps: updated });
    setNewApp('');
  };

  const handleRemove = (app: string) => {
    const updated = apps.filter((a) => a !== app);
    usePmStore.getState().updateProject(project.id, { runtimeApps: updated.length ? updated : undefined });
  };

  const connectedApps = matchedRps.filter((r) => r.isConnected);

  // Available runtime projects not yet added
  const unlinkedRps = runtimeProjects.filter(
    (r) => !apps.some((a) => a.toLowerCase() === r.appName.toLowerCase()),
  );

  // PM projects with sdkInstalled or runtimescopeProject that aren't already linked
  const pmProjects = usePmStore.getState().projects;
  const pmSuggestions = pmProjects
    .filter((p) => p.id !== project.id && (p.sdkInstalled || p.runtimescopeProject))
    .map((p) => p.runtimescopeProject ?? p.name)
    .filter((name) =>
      !apps.some((a) => a.toLowerCase() === name.toLowerCase()) &&
      !unlinkedRps.some((r) => r.appName.toLowerCase() === name.toLowerCase()),
    );

  if (apps.length === 0 && !open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-bg-surface text-text-muted hover:bg-bg-hover transition-colors cursor-pointer"
      >
        <Link2 size={10} />
        Link Apps
      </button>
    );
  }

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          'inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium transition-colors cursor-pointer',
          connectedApps.length > 0
            ? 'bg-green-500/15 text-green-400 hover:bg-green-500/25'
            : 'bg-bg-surface text-text-muted hover:bg-bg-hover'
        )}
      >
        <Link2 size={10} />
        {apps.length} app{apps.length !== 1 ? 's' : ''}
        {connectedApps.length > 0 && ` (${connectedApps.length} live)`}
        <ChevronDown size={10} />
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 z-50 w-64 rounded-lg border border-border-default bg-bg-elevated shadow-lg overflow-hidden">
          <div className="py-1">
            {apps.map((app) => {
              const rp = matchedRps.find((r) => r.appName.toLowerCase() === app.toLowerCase());
              return (
                <div key={app} className="flex items-center gap-2 px-3 py-1.5">
                  <StatusDot
                    color={rp?.isConnected ? 'green' : 'gray'}
                    size="sm"
                    pulse={rp?.isConnected}
                  />
                  <span className="text-xs text-text-primary flex-1 truncate font-mono">{app}</span>
                  <button
                    type="button"
                    onClick={() => handleRemove(app)}
                    className="p-0.5 rounded text-text-muted hover:text-red hover:bg-red-muted transition-colors cursor-pointer"
                  >
                    <X size={10} />
                  </button>
                </div>
              );
            })}
          </div>

          {/* Quick-add from discovered runtime projects + PM projects */}
          {(unlinkedRps.length > 0 || pmSuggestions.length > 0) && (
            <div className="border-t border-border-muted py-1">
              <p className="px-3 py-1 text-[10px] text-text-muted uppercase tracking-wider">Available</p>
              {unlinkedRps.map((rp) => (
                <button
                  key={rp.appName}
                  type="button"
                  onClick={() => {
                    const updated = [...apps, rp.appName];
                    usePmStore.getState().updateProject(project.id, { runtimeApps: updated });
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-hover cursor-pointer"
                >
                  <Plus size={10} className="text-text-tertiary" />
                  <span className="font-mono truncate">{rp.appName}</span>
                  {rp.isConnected && <StatusDot color="green" size="sm" pulse />}
                </button>
              ))}
              {pmSuggestions.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => {
                    const updated = [...apps, name];
                    usePmStore.getState().updateProject(project.id, { runtimeApps: updated });
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-text-muted hover:bg-bg-hover cursor-pointer"
                >
                  <Plus size={10} className="text-text-tertiary" />
                  <span className="font-mono truncate">{name}</span>
                  <span className="text-[10px] text-text-tertiary">SDK</span>
                </button>
              ))}
            </div>
          )}

          {/* Manual entry */}
          <div className="border-t border-border-muted px-3 py-2 flex gap-1.5">
            <input
              type="text"
              value={newApp}
              onChange={(e) => setNewApp(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
              placeholder="Add app name..."
              className="flex-1 bg-transparent text-xs text-text-primary placeholder:text-text-muted outline-none font-mono"
            />
            {newApp.trim() && (
              <button
                type="button"
                onClick={handleAdd}
                className="text-xs text-brand font-medium cursor-pointer"
              >
                Add
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function ProjectView() {
  const selectedPmProject = useAppStore((s) => s.selectedPmProject);
  const activeProjectTab = useAppStore((s) => s.activeProjectTab);
  const setActiveProjectTab = useAppStore((s) => s.setActiveProjectTab);
  const project = usePmStore((s) => s.projects.find((p) => p.id === selectedPmProject));

  if (!project) {
    return <EmptyState title="No Project Selected" description="Select a project from the sidebar." />;
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* Project header */}
      <div className="px-5 pt-4 pb-0">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-text-primary">{project.name}</h1>
          <HeaderCategoryBadge projectId={project.id} category={project.category} />
          <RuntimeAppsBadge project={project} />
          <DevServerControl project={project} />
        </div>
        {project.path && (
          <p className="text-[12px] text-text-muted font-mono truncate mt-0.5">{project.path}</p>
        )}
      </div>

      {/* Tabs */}
      <Tabs
        tabs={PROJECT_TABS}
        activeTab={activeProjectTab}
        onTabChange={(id) => setActiveProjectTab(id as ProjectTab)}
        className="mt-2"
      />

      {/* Content */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <Suspense fallback={<ListSkeleton rows={8} />}>
          {activeProjectTab === 'tasks' && <TasksPage projectId={project.id} />}
          {activeProjectTab === 'git' && <GitPage projectId={project.id} projectPath={project.path} />}
          {activeProjectTab === 'sessions' && <PmSessionsPage projectId={project.id} />}
          {activeProjectTab === 'runtime' && <RuntimePage project={project} />}
          {activeProjectTab === 'notes' && <NotesPage projectId={project.id} />}
          {activeProjectTab === 'memory' && <MemoryPage projectId={project.id} claudeProjectKey={project.claudeProjectKey} />}
          {activeProjectTab === 'rules' && <RulesPage projectId={project.id} />}
          {activeProjectTab === 'capex' && <CapexPage projectId={project.id} />}
        </Suspense>
      </div>
    </div>
  );
}

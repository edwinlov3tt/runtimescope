import { useEffect, useRef, useMemo, useState, useCallback } from 'react';
import { useAppStore } from '@/stores/use-app-store';
import { useDataStore } from '@/stores/use-data-store';
import { useDevServerStore } from '@/stores/use-dev-server-store';
import { Tabs } from '@/components/ui/tabs';
import { Button } from '@/components/ui';
import { OverviewPage } from '@/pages/overview/overview-page';
import { NetworkPage } from '@/pages/network/network-page';
import { ConsolePage } from '@/pages/console/console-page';
import { RendersPage } from '@/pages/renders/renders-page';
import { StatePage } from '@/pages/state/state-page';
import { PerformancePage } from '@/pages/performance/performance-page';
import { IssuesPage } from '@/pages/issues/issues-page';
import { ApiMapPage } from '@/pages/api-map/api-map-page';
import { DatabasePage } from '@/pages/database/database-page';
import { ProcessesPage } from '@/pages/processes/processes-page';
import { InfraPage } from '@/pages/infra/infra-page';
import { SessionsPage } from '@/pages/sessions/sessions-page';
import { EventsPage } from '@/pages/events/events-page';
import { EmptyState } from '@/components/ui/empty-state';
import { WifiOff, Package, Play, Loader2, Terminal, ChevronDown } from 'lucide-react';
import { fetchProjectScripts, startDevServer, fetchDevServerStatus } from '@/lib/pm-api';
import { findRuntimeProject } from '@/lib/api';
import { RuntimeScope } from '@runtimescope/sdk';
import { boostProjectPoll } from '@/App';
import { cn } from '@/lib/cn';
import type { PmProject } from '@/lib/pm-types';

type SdkState = 'live' | 'installed' | 'not-installed';

function useSdkState(project: PmProject): SdkState {
  const runtimeProjects = useAppStore((s) => s.projects);
  return useMemo(() => {
    const rp = findRuntimeProject(runtimeProjects, {
      runtimescopeProject: project.runtimescopeProject,
      runtimeApps: project.runtimeApps,
      name: project.name,
    });
    if (rp?.isConnected) return 'live';
    if (project.sdkInstalled || rp) return 'installed';
    return 'not-installed';
  }, [project.runtimescopeProject, project.runtimeApps, project.name, project.sdkInstalled, runtimeProjects]);
}

const RUNTIME_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'network', label: 'Network' },
  { id: 'console', label: 'Console' },
  { id: 'renders', label: 'Renders' },
  { id: 'state', label: 'State' },
  { id: 'performance', label: 'Performance' },
  { id: 'api', label: 'API Map' },
  { id: 'database', label: 'Database' },
  { id: 'issues', label: 'Issues' },
  { id: 'processes', label: 'Processes' },
  { id: 'infra', label: 'Infra' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'events', label: 'Events' },
];

interface RuntimePageProps {
  project: PmProject;
}

// ---------------------------------------------------------------------------
// Dev Server Log Panel
// ---------------------------------------------------------------------------

function DevServerLogPanel({ projectId }: { projectId: string }) {
  const devState = useDevServerStore((s) => s.servers.get(projectId));
  const [open, setOpen] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [devState?.logs.length, open]);

  if (!devState || devState.logs.length === 0) return null;

  return (
    <div className="w-full max-w-2xl mt-4">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-3 py-2 rounded-t bg-bg-surface border border-border-default text-xs text-text-muted hover:bg-bg-hover transition-colors cursor-pointer"
      >
        <span className="flex items-center gap-2">
          <Terminal size={12} />
          Dev Server Output
          <span className="text-text-tertiary">({devState.logs.length} lines)</span>
        </span>
        <ChevronDown size={12} className={cn('transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="h-48 overflow-auto bg-[#0a0a14] border border-t-0 border-border-default rounded-b p-3">
          <pre className="text-[11px] font-mono whitespace-pre-wrap break-all">
            {devState.logs.map((l, i) => (
              <span
                key={i}
                className={l.stream === 'stderr' ? 'text-amber' : 'text-text-secondary'}
              >
                {l.line}{'\n'}
              </span>
            ))}
          </pre>
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Start Dev Server Button
// ---------------------------------------------------------------------------

function StartDevServerButton({ project }: { project: PmProject }) {
  const devStatus = useDevServerStore((s) => s.servers.get(project.id)?.status);
  const [error, setError] = useState<string | null>(null);
  const starting = devStatus === 'starting';

  const handleStart = useCallback(async () => {
    setError(null);
    useDevServerStore.getState().setOptimisticStarting(project.id);

    try {
      const scripts = await fetchProjectScripts(project.id);
      const script = scripts?.recommended ?? 'dev';
      const result = await startDevServer(project.id, { script });
      if (!result) {
        setError('Failed to start dev server');
        useDevServerStore.getState().setStatus(project.id, 'idle');
        return;
      }
      boostProjectPoll();
      RuntimeScope.track('dev_server_started', {
        projectId: project.id,
        projectName: project.name,
        script,
      });
    } catch (err) {
      setError((err as Error).message);
      useDevServerStore.getState().setStatus(project.id, 'idle');
    }
  }, [project.id]);

  return (
    <div className="flex flex-col items-center gap-2">
      <Button
        variant="primary"
        size="sm"
        onClick={handleStart}
        disabled={starting}
      >
        {starting ? (
          <>
            <Loader2 size={14} className="animate-spin" />
            Starting...
          </>
        ) : (
          <>
            <Play size={14} />
            Start Dev Server
          </>
        )}
      </Button>
      {error && (
        <p className="text-xs text-red">{error}</p>
      )}
      <DevServerLogPanel projectId={project.id} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function RuntimePage({ project }: RuntimePageProps) {
  const runtimeSubTab = useAppStore((s) => s.runtimeSubTab);
  const setRuntimeSubTab = useAppStore((s) => s.setRuntimeSubTab);
  const prevProjectRef = useRef<string | null>(null);

  // Sync selectedProject (runtime filter) with the PM project's runtimescopeProject
  // and clear stale events when switching projects
  useEffect(() => {
    const runtimeApp = project.runtimescopeProject ?? null;
    const currentSelected = useAppStore.getState().selectedProject;

    if (runtimeApp !== prevProjectRef.current || currentSelected !== runtimeApp) {
      useDataStore.getState().clearAll();
      useAppStore.getState().setSelectedProject(runtimeApp);
      prevProjectRef.current = runtimeApp;
    }
  }, [project.id, project.runtimescopeProject]);

  // Hydrate dev server state on mount (for page refresh / reconnect)
  // Only hydrate if we don't already have data from WS
  useEffect(() => {
    const existing = useDevServerStore.getState().servers.get(project.id);
    if (existing && existing.logs.length > 0) return; // Already have WS data

    fetchDevServerStatus(project.id).then((data) => {
      if (data && data.status !== 'stopped') {
        const store = useDevServerStore.getState();
        store.setStatus(project.id, data.status as any, data.pid);
        if (data.logs?.length) {
          for (const raw of data.logs) {
            const isStderr = raw.startsWith('[stderr]');
            const stream = isStderr ? 'stderr' : 'stdout';
            const line = raw.replace(/^\[(stdout|stderr)] /, '');
            store.appendLog(project.id, stream, line, Date.now());
          }
        }
      }
    }).catch(() => {});
  }, [project.id]);

  const sdkState = useSdkState(project);

  // SDK not connected — show informative empty state
  if (sdkState !== 'live') {
    const hasPath = !!project.path;
    return (
      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {sdkState === 'not-installed' ? (
          <EmptyState
            icon={<Package size={40} strokeWidth={1.25} />}
            title="SDK Not Installed"
            description={`Install @runtimescope/sdk in ${project.name} to capture live runtime events — network requests, console logs, renders, performance metrics, and more.`}
          />
        ) : (
          <EmptyState
            icon={<WifiOff size={40} strokeWidth={1.25} />}
            title="SDK Not Connected"
            description={`The RuntimeScope SDK is installed in ${project.name} but isn't connected. Start the dev server to see live runtime data.`}
            action={hasPath ? <StartDevServerButton project={project} /> : undefined}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <Tabs
        tabs={RUNTIME_TABS}
        activeTab={runtimeSubTab}
        onTabChange={setRuntimeSubTab}
      />
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {runtimeSubTab === 'overview' && <OverviewPage />}
        {runtimeSubTab === 'network' && <NetworkPage />}
        {runtimeSubTab === 'console' && <ConsolePage />}
        {runtimeSubTab === 'renders' && <RendersPage />}
        {runtimeSubTab === 'state' && <StatePage />}
        {runtimeSubTab === 'performance' && <PerformancePage />}
        {runtimeSubTab === 'api' && <ApiMapPage />}
        {runtimeSubTab === 'database' && <DatabasePage />}
        {runtimeSubTab === 'issues' && <IssuesPage />}
        {runtimeSubTab === 'processes' && <ProcessesPage />}
        {runtimeSubTab === 'infra' && <InfraPage />}
        {runtimeSubTab === 'sessions' && <SessionsPage />}
        {runtimeSubTab === 'events' && <EventsPage />}
      </div>
    </div>
  );
}

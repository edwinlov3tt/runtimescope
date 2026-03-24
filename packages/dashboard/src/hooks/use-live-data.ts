import { useEffect, useRef } from 'react';
import { useAppStore } from '@/stores/use-app-store';
import { useDataStore } from '@/stores/use-data-store';
import { usePmStore } from '@/stores/use-pm-store';
import {
  fetchNetworkEvents,
  fetchConsoleEvents,
  fetchStateEvents,
  fetchRenderEvents,
  fetchPerformanceEvents,
  fetchDatabaseEvents,
  fetchUIEvents,
  fetchProcesses,
  fetchPorts,
} from '@/lib/api';

const POLL_INTERVAL = 2000;

/**
 * Resolve the active context → session_id(s) for API filtering.
 *
 * The core insight: multi-app projects (e.g., "runtimescope" with browser + dashboard SDKs)
 * have DIFFERENT projectIds per app. We can't filter by a single projectId.
 * Instead, we collect ALL session IDs from ALL runtime apps that belong to this PM project.
 */
function getProjectFilter(): { project_id?: string; session_id?: string } {
  const { selectedProject, selectedPmProject, projects } = useAppStore.getState();

  // Path 1: PM project is selected (via sidebar click)
  if (selectedPmProject) {
    const pmProjects = usePmStore.getState().projects;
    const pmProject = pmProjects.find((p) => p.id === selectedPmProject);

    if (pmProject) {
      // Collect ALL sessions from ALL runtime apps belonging to this PM project
      const appNames: string[] = pmProject.runtimeApps
        ?? [pmProject.runtimescopeProject, pmProject.name].filter(Boolean) as string[];

      const allSessions: string[] = [];
      const allProjectIds: string[] = [];

      for (const appName of appNames) {
        const rp = projects.find((p) => p.appName.toLowerCase() === appName.toLowerCase());
        if (rp) {
          allSessions.push(...rp.sessions);
          if (rp.projectId) allProjectIds.push(rp.projectId);
        }
      }

      // If all apps share the same projectId, use it (optimal — single filter)
      const uniqueProjectIds = [...new Set(allProjectIds)];
      if (uniqueProjectIds.length === 1) {
        return { project_id: uniqueProjectIds[0] };
      }

      // Multiple projectIds (multi-app project) — fall back to session_id list
      if (allSessions.length > 0) {
        return { session_id: allSessions.join(',') };
      }

      // No runtime connections found
      return { session_id: '__none__' };
    }
  }

  // Path 2: Standalone runtime project selected
  if (!selectedProject) return {};

  const project = projects.find((p) => p.appName === selectedProject);
  if (!project || project.sessions.length === 0) return { session_id: '__none__' };

  if (project.projectId) return { project_id: project.projectId };
  return { session_id: project.sessions[0] };
}

type Fetcher = () => Promise<void>;

function makeFetchers(): Record<string, Fetcher> {
  return {
    network: async () => {
      const filter = getProjectFilter();
      const data = await fetchNetworkEvents(filter);
      if (data) useDataStore.getState().setNetwork(data);
    },
    console: async () => {
      const filter = getProjectFilter();
      const data = await fetchConsoleEvents(filter);
      if (data) useDataStore.getState().setConsole(data);
    },
    state: async () => {
      const filter = getProjectFilter();
      const data = await fetchStateEvents(filter);
      if (data) useDataStore.getState().setState(data);
    },
    renders: async () => {
      const filter = getProjectFilter();
      const data = await fetchRenderEvents(filter);
      if (data) useDataStore.getState().setRenders(data);
    },
    performance: async () => {
      const filter = getProjectFilter();
      const data = await fetchPerformanceEvents(filter);
      if (data) useDataStore.getState().setPerformance(data);
    },
    database: async () => {
      const filter = getProjectFilter();
      const data = await fetchDatabaseEvents(filter);
      if (data) useDataStore.getState().setDatabase(data);
    },
    breadcrumbs: async () => {
      const filter = getProjectFilter();
      const data = await fetchUIEvents(filter);
      if (data) useDataStore.getState().setUI(data);
    },
    processes: async () => {
      const [procs, ports] = await Promise.all([fetchProcesses(), fetchPorts()]);
      const s = useDataStore.getState();
      if (procs) s.setProcesses(procs);
      if (ports) s.setPorts(ports);
    },
    // Pages that need multiple event types fetch all
    overview: fetchAllFiltered,
    issues: fetchAllFiltered,
    'api-map': async () => {
      const filter = getProjectFilter();
      const data = await fetchNetworkEvents(filter);
      if (data) useDataStore.getState().setNetwork(data);
    },
    sessions: async () => {
      // Sessions page manages its own polling — no-op here
    },
  };
}

async function fetchAllFiltered(): Promise<void> {
  const filter = getProjectFilter();
  const [net, con, st, ren, perf, db] = await Promise.all([
    fetchNetworkEvents(filter),
    fetchConsoleEvents(filter),
    fetchStateEvents(filter),
    fetchRenderEvents(filter),
    fetchPerformanceEvents(filter),
    fetchDatabaseEvents(filter),
  ]);
  const s = useDataStore.getState();
  if (net) s.setNetwork(net);
  if (con) s.setConsole(con);
  if (st) s.setState(st);
  if (ren) s.setRenders(ren);
  if (perf) s.setPerformance(perf);
  if (db) s.setDatabase(db);
}

export function useLiveData(): void {
  const activeTab = useAppStore((s) => s.activeTab);
  const activeView = useAppStore((s) => s.activeView);
  const activeProjectTab = useAppStore((s) => s.activeProjectTab);
  const runtimeSubTab = useAppStore((s) => s.runtimeSubTab);
  const selectedProject = useAppStore((s) => s.selectedProject);
  const source = useDataStore((s) => s.source);
  const connected = useDataStore((s) => s.connected);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (source !== 'live') return;

    // When viewing a PM project, only poll runtime data if on the Runtime tab
    if (activeView === 'project' && activeProjectTab !== 'runtime') {
      return;
    }

    // Determine which tab to poll for
    const effectiveTab = activeView === 'project' ? runtimeSubTab : activeTab;

    const fetchers = makeFetchers();
    const fetcher = fetchers[effectiveTab] ?? fetchAllFiltered;

    // Always fetch once on tab switch or project change for fresh data
    fetcher();

    // Only poll when WS is disconnected — when connected, the WS pushes events in real-time
    if (!connected) {
      intervalRef.current = setInterval(fetcher, POLL_INTERVAL);

      // Pause when tab is hidden
      const onVisibility = () => {
        if (document.hidden) {
          if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
          }
        } else {
          fetcher();
          intervalRef.current = setInterval(fetcher, POLL_INTERVAL);
        }
      };
      document.addEventListener('visibilitychange', onVisibility);

      return () => {
        if (intervalRef.current) clearInterval(intervalRef.current);
        document.removeEventListener('visibilitychange', onVisibility);
      };
    }

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [activeTab, activeView, activeProjectTab, runtimeSubTab, source, selectedProject, connected]);
}

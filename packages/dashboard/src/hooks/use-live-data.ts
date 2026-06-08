import { useEffect, useRef } from 'react';
import { useAppStore, timeRangeToSinceSeconds } from '@/stores/use-app-store';
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

/**
 * The project filter plus the global header time-range scope.
 *
 * The active time range is converted to `since_seconds` (the collector's
 * "events newer than now - since_seconds*1000" filter). For the 'all' preset
 * this is `undefined` and no time bound is applied. This scopes the initial /
 * poll fetch only — WS-fed live appends are not filtered here (see useLiveData
 * notes); new events stream in within the window naturally as time advances.
 */
function getEventFilter(): { project_id?: string; session_id?: string; since_seconds?: number } {
  const filter = getProjectFilter();
  const since = timeRangeToSinceSeconds(useAppStore.getState().timeRange);
  return since !== undefined ? { ...filter, since_seconds: since } : filter;
}

type Fetcher = () => Promise<void>;

function makeFetchers(): Record<string, Fetcher> {
  return {
    network: async () => {
      const filter = getEventFilter();
      const data = await fetchNetworkEvents(filter);
      if (data) useDataStore.getState().setNetwork(data);
    },
    console: async () => {
      const filter = getEventFilter();
      const data = await fetchConsoleEvents(filter);
      if (data) useDataStore.getState().setConsole(data);
    },
    state: async () => {
      const filter = getEventFilter();
      const data = await fetchStateEvents(filter);
      if (data) useDataStore.getState().setState(data);
    },
    renders: async () => {
      const filter = getEventFilter();
      const data = await fetchRenderEvents(filter);
      if (data) useDataStore.getState().setRenders(data);
    },
    performance: async () => {
      const filter = getEventFilter();
      const data = await fetchPerformanceEvents(filter);
      if (data) useDataStore.getState().setPerformance(data);
    },
    database: async () => {
      const filter = getEventFilter();
      const data = await fetchDatabaseEvents(filter);
      if (data) useDataStore.getState().setDatabase(data);
    },
    breadcrumbs: async () => {
      const filter = getEventFilter();
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
      const filter = getEventFilter();
      const data = await fetchNetworkEvents(filter);
      if (data) useDataStore.getState().setNetwork(data);
    },
    sessions: async () => {
      // Sessions page manages its own polling — no-op here
    },
  };
}

async function fetchAllFiltered(): Promise<void> {
  const filter = getEventFilter();
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
  // Subscribe to the active time range so a range change re-runs the effect and
  // re-fetches scoped to the new window (setTimeRange flushes stale buffers).
  const timeRange = useAppStore((s) => s.timeRange);
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
  }, [activeTab, activeView, activeProjectTab, runtimeSubTab, source, selectedProject, connected, timeRange]);

  // When the global time range changes, refetch ALL event types — not just the
  // active tab — so always-mounted consumers (the notification bell, overview)
  // and the Issues page reflect the new window. (setTimeRange no longer wipes the
  // buffers, which previously blanked the bell until each tab was revisited.)
  const lastRangeRef = useRef(timeRange);
  useEffect(() => {
    if (source !== 'live') return;
    if (lastRangeRef.current === timeRange) return; // initial mount / unchanged
    lastRangeRef.current = timeRange;
    fetchAllFiltered();
  }, [timeRange, source]);

  // Evict events that age PAST the selected window. With WS connected, live
  // appends are unfiltered and backfilled events drift older than the window
  // over time — so without store-level eviction "Last 15m" silently widens.
  // For the 'all' preset (since === undefined) there is no bound: do nothing.
  // Widening the window triggers a full refetch (range-change effect above),
  // so pruned events return — we only ever need to trim here.
  useEffect(() => {
    if (source !== 'live') return;
    const since = timeRangeToSinceSeconds(timeRange);
    if (since === undefined) return; // 'all' — no time bound, no interval
    const prune = () => {
      useDataStore.getState().pruneOlderThan(Date.now() - since * 1000);
    };
    prune(); // once immediately
    const id = setInterval(prune, 5000);
    return () => clearInterval(id);
  }, [timeRange, source]);
}

import { useEffect, useRef } from 'react';
import { useAppStore } from '@/stores/use-app-store';
import { useDataStore } from '@/stores/use-data-store';
import {
  fetchNetworkEvents,
  fetchConsoleEvents,
  fetchStateEvents,
  fetchRenderEvents,
  fetchPerformanceEvents,
  fetchDatabaseEvents,
  fetchProcesses,
  fetchPorts,
} from '@/lib/api';

const POLL_INTERVAL = 2000;

/** Resolve selectedProject → session_id for API filtering */
function getSessionIdFilter(): string | undefined {
  const { selectedProject, projects } = useAppStore.getState();
  if (!selectedProject) return undefined;

  const project = projects.find((p) => p.appName === selectedProject);
  if (!project || project.sessions.length === 0) return undefined;
  return project.sessions[0];
}

type Fetcher = () => Promise<void>;

function makeFetchers(): Record<string, Fetcher> {
  return {
    network: async () => {
      const sid = getSessionIdFilter();
      const data = await fetchNetworkEvents({ session_id: sid });
      if (data) useDataStore.getState().setNetwork(data);
    },
    console: async () => {
      const sid = getSessionIdFilter();
      const data = await fetchConsoleEvents({ session_id: sid });
      if (data) useDataStore.getState().setConsole(data);
    },
    state: async () => {
      const sid = getSessionIdFilter();
      const data = await fetchStateEvents({ session_id: sid });
      if (data) useDataStore.getState().setState(data);
    },
    renders: async () => {
      const sid = getSessionIdFilter();
      const data = await fetchRenderEvents({ session_id: sid });
      if (data) useDataStore.getState().setRenders(data);
    },
    performance: async () => {
      const sid = getSessionIdFilter();
      const data = await fetchPerformanceEvents({ session_id: sid });
      if (data) useDataStore.getState().setPerformance(data);
    },
    database: async () => {
      const sid = getSessionIdFilter();
      const data = await fetchDatabaseEvents({ session_id: sid });
      if (data) useDataStore.getState().setDatabase(data);
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
      const sid = getSessionIdFilter();
      const data = await fetchNetworkEvents({ session_id: sid });
      if (data) useDataStore.getState().setNetwork(data);
    },
    sessions: async () => {
      const sid = getSessionIdFilter();
      const data = await fetchNetworkEvents({ session_id: sid });
      if (data) useDataStore.getState().setNetwork(data);
    },
  };
}

async function fetchAllFiltered(): Promise<void> {
  const sid = getSessionIdFilter();
  const params = sid ? { session_id: sid } : undefined;
  const [net, con, st, ren, perf, db] = await Promise.all([
    fetchNetworkEvents(params),
    fetchConsoleEvents(params),
    fetchStateEvents(params),
    fetchRenderEvents(params),
    fetchPerformanceEvents(params),
    fetchDatabaseEvents(params),
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
  const selectedProject = useAppStore((s) => s.selectedProject);
  const source = useDataStore((s) => s.source);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (source !== 'live') return;

    const fetchers = makeFetchers();
    const fetcher = fetchers[activeTab] ?? fetchAllFiltered;

    // Fetch immediately on tab switch or project change
    fetcher();

    // Poll on interval
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
  }, [activeTab, source, selectedProject]);
}

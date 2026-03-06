import { useEffect, useRef } from 'react';
import { useAppStore } from '@/stores/use-app-store';
import { useDataStore } from '@/stores/use-data-store';
import { usePmStore } from '@/stores/use-pm-store';
import { useDevServerStore } from '@/stores/use-dev-server-store';
import { AppShell } from '@/components/layout/app-shell';
import { checkHealth, fetchProjects } from '@/lib/api';
import { connectWs, setDevServerHandler } from '@/lib/ws-client';
import { useLiveData } from '@/hooks/use-live-data';

// Boost project polling temporarily (750ms for 15s) after starting a dev server
let boostTimer: ReturnType<typeof setTimeout> | null = null;
let boostInterval: ReturnType<typeof setInterval> | null = null;
let pollProjectsFn: (() => void) | null = null;

export function boostProjectPoll(): void {
  if (boostInterval || !pollProjectsFn) return;
  pollProjectsFn();
  boostInterval = setInterval(pollProjectsFn, 750);
  boostTimer = setTimeout(() => {
    if (boostInterval) { clearInterval(boostInterval); boostInterval = null; }
    boostTimer = null;
  }, 15_000);
}

export function App() {
  const projectPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // On mount: check if collector is running → set source + connect WS + discover projects
  useEffect(() => {
    // Fetch PM projects (always — works even without live connection)
    usePmStore.getState().fetchProjects();

    checkHealth().then((ok) => {
      if (ok) {
        useDataStore.getState().setSource('live');
        connectWs();

        // Wire dev server WS handler
        setDevServerHandler((msg: any) => {
          const store = useDevServerStore.getState();
          if (msg.type === 'dev_server_status') {
            store.setStatus(msg.projectId, msg.status, msg.pid, msg.port);
          } else if (msg.type === 'dev_server_log') {
            store.appendLog(msg.projectId, msg.stream, msg.line, msg.ts);
          }
        });

        // Poll for runtime projects (auto-detect SDK-connected apps)
        const pollProjects = async () => {
          const projects = await fetchProjects();
          if (projects) {
            const store = useAppStore.getState();
            store.setProjects(projects);

            // Auto-select if no project selected and exactly one is connected
            if (!store.selectedProject) {
              const connected = projects.filter((p) => p.isConnected);
              if (connected.length === 1) {
                store.setSelectedProject(connected[0].appName);
              }
            }
          }
        };

        pollProjectsFn = pollProjects;
        pollProjects();
        projectPollRef.current = setInterval(pollProjects, 5000);
      }
    });

    return () => {
      if (projectPollRef.current) clearInterval(projectPollRef.current);
      if (boostInterval) clearInterval(boostInterval);
      if (boostTimer) clearTimeout(boostTimer);
    };
  }, []);

  // Poll data for the active tab when in live mode
  useLiveData();

  return <AppShell />;
}

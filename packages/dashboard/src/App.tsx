import { useEffect, useRef } from 'react';
import { useAppStore } from '@/stores/use-app-store';
import { useDataStore } from '@/stores/use-data-store';
import { usePmStore } from '@/stores/use-pm-store';
import { useDevServerStore } from '@/stores/use-dev-server-store';
import { useAuthStore } from '@/stores/use-auth-store';
import { AppShell } from '@/components/layout/app-shell';
import { LoginScreen } from '@/components/auth/login-screen';
import { checkHealth, fetchProjects } from '@/lib/api';
import { connectWs, setDevServerHandler } from '@/lib/ws-client';
import { useLiveData } from '@/hooks/use-live-data';
import { useUrlSync } from '@/hooks/use-url-sync';

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

  const authReady = useAuthStore((s) => s.ready);
  const authRequired = useAuthStore((s) => s.required);
  const authed = useAuthStore((s) => s.authed);
  const gated = authReady && authRequired && !authed;

  // Bootstrap auth once: ask /api/health whether a token is required and validate
  // any stored one. Until this resolves we render nothing (sub-second).
  useEffect(() => {
    useAuthStore.getState().bootstrap();
  }, []);

  // On mount (and after a successful login): check if collector is running →
  // set source + connect WS + discover projects. Gated on auth so we don't fire
  // a wall of 401s before the token is in hand.
  useEffect(() => {
    if (!authReady || gated) return;

    // Fetch PM projects + workspaces (always — works even without live connection)
    usePmStore.getState().fetchProjects();
    import('@/stores/use-workspace-store').then((m) => m.useWorkspaceStore.getState().fetchWorkspaces());

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
  }, [authReady, gated]);

  // Keep the URL in sync with nav state (deep-linking + refresh restore)
  useUrlSync();

  // Poll data for the active tab when in live mode
  useLiveData();

  if (!authReady) return null; // brief: waiting on the /api/health auth probe
  if (gated) return <LoginScreen />;

  return <AppShell />;
}

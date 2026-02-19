import { useEffect, useRef } from 'react';
import { useAppStore } from '@/stores/use-app-store';
import { useDataStore } from '@/stores/use-data-store';
import { AppShell } from '@/components/layout/app-shell';
import { PageRouter } from '@/components/layout/page-router';
import { checkHealth, fetchProjects } from '@/lib/api';
import { connectWs } from '@/lib/ws-client';
import { useLiveData } from '@/hooks/use-live-data';

export function App() {
  const activeTab = useAppStore((s) => s.activeTab);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const projectPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // On mount: check if collector is running → set source + connect WS + discover projects
  useEffect(() => {
    checkHealth().then((ok) => {
      if (ok) {
        useDataStore.getState().setSource('live');
        connectWs();

        // Poll for projects (auto-detect SDK-connected apps)
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

        pollProjects();
        projectPollRef.current = setInterval(pollProjects, 5000);
      }
    });

    return () => {
      if (projectPollRef.current) clearInterval(projectPollRef.current);
    };
  }, []);

  // Poll data for the active tab when in live mode
  useLiveData();

  return (
    <AppShell activeTab={activeTab} onTabChange={setActiveTab}>
      <PageRouter activeTab={activeTab} />
    </AppShell>
  );
}

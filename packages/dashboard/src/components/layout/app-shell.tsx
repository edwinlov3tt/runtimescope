import { useState, useCallback } from 'react';
import { useAppStore } from '@/stores/use-app-store';
import { Rail, HOME_RAIL_ITEMS, HOME_RAIL_BOTTOM, RUNTIME_RAIL_ITEMS, RUNTIME_RAIL_BOTTOM } from '@/components/layout/rail';
import { Header } from '@/components/layout/header';
import { ExpandableSidebar } from '@/components/layout/expandable-sidebar';
import { PageRouter } from '@/components/layout/page-router';
import { ConnectionBanner } from '@/components/ui/connection-banner';
import { ToastContainer } from '@/components/ui/toast-container';

// ---------------------------------------------------------------------------
// Title / breadcrumb mapping
// ---------------------------------------------------------------------------

function getTitle(activeView: string, activeTab: string, activeProjectTab: string): { title: string; breadcrumb?: string } {
  if (activeView === 'home') return { title: 'Home' };
  if (activeView === 'project') {
    const tabTitles: Record<string, string> = {
      sessions: 'Sessions', tasks: 'Tasks', notes: 'Notes', memory: 'Memory',
      git: 'Git', capex: 'CapEx', sdk: 'SDK', rules: 'Rules',
    };
    return { title: tabTitles[activeProjectTab] ?? 'Project' };
  }
  // Runtime
  const runtimeTitles: Record<string, string> = {
    overview: 'Overview', network: 'Network', console: 'Console', issues: 'Issues',
    renders: 'Renders', state: 'State', performance: 'Performance', 'api-map': 'API Map',
    database: 'Database', breadcrumbs: 'Breadcrumbs', events: 'Events',
    processes: 'Processes', settings: 'Settings',
  };
  return { title: 'Runtime', breadcrumb: runtimeTitles[activeTab] ?? activeTab };
}

// ---------------------------------------------------------------------------
// AppShell
// ---------------------------------------------------------------------------

export function AppShell() {
  const activeView = useAppStore((s) => s.activeView);
  const activeTab = useAppStore((s) => s.activeTab);
  const activeProjectTab = useAppStore((s) => s.activeProjectTab);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const setActiveProjectTab = useAppStore((s) => s.setActiveProjectTab);

  const [sidebarOpen, setSidebarOpen] = useState(false);

  const isRuntime = activeView === 'runtime';
  const railItems = isRuntime ? RUNTIME_RAIL_ITEMS : HOME_RAIL_ITEMS;
  const railBottomItems = isRuntime ? RUNTIME_RAIL_BOTTOM : HOME_RAIL_BOTTOM;

  // Determine active rail item ID
  const activeRailId = isRuntime
    ? activeTab
    : activeView === 'home'
      ? 'home'
      : activeProjectTab;

  const selectedPmProject = useAppStore((s) => s.selectedPmProject);

  // Items that require a project to be selected
  const PROJECT_DEPENDENT = new Set(['sessions', 'git', 'tasks', 'memory', 'rules', 'capex']);
  const disabledIds = !isRuntime && !selectedPmProject ? PROJECT_DEPENDENT : undefined;

  const handleRailSelect = useCallback((id: string) => {
    if (isRuntime) {
      if (id === 'settings') {
        setActiveView('settings');
        return;
      }
      setActiveTab(id);
    } else {
      if (id === 'home') {
        setActiveView('home');
      } else if (id === 'runtime') {
        setActiveView('runtime');
        setActiveTab('overview');
      } else if (id === 'settings') {
        setActiveView('settings');
      } else if (id === 'processes') {
        // Processes is global, not per-project
        setActiveView('home');
      } else {
        // Project tab — only navigate to project view if a project is selected
        const tabMap: Record<string, string> = {
          sessions: 'sessions', git: 'git', tasks: 'tasks',
          memory: 'memory', rules: 'rules', capex: 'capex',
        };
        const tab = tabMap[id];
        if (tab) {
          if (selectedPmProject) {
            setActiveView('project');
            setActiveProjectTab(tab as any);
          } else {
            // No project selected — stay on home
            setActiveView('home');
          }
        }
      }
    }
  }, [isRuntime, selectedPmProject, setActiveView, setActiveTab, setActiveProjectTab]);

  const handleBack = useCallback(() => {
    setActiveView('home');
  }, [setActiveView]);

  const { title, breadcrumb } = getTitle(activeView, activeTab, activeProjectTab);

  return (
    <div className="h-screen w-screen flex overflow-hidden bg-bg-base">
      <Rail
        items={railItems}
        bottomItems={railBottomItems}
        activeId={activeRailId}
        onSelect={handleRailSelect}
        isSubContext={isRuntime}
        onBack={handleBack}
        disabledIds={disabledIds}
      />

      <ExpandableSidebar
        open={sidebarOpen}
        isSubContext={isRuntime}
        mainItems={railItems}
        mainBottomItems={railBottomItems}
        parentItems={isRuntime ? HOME_RAIL_ITEMS : undefined}
        parentBottomItems={isRuntime ? HOME_RAIL_BOTTOM : undefined}
        activeId={activeRailId}
        onSelect={handleRailSelect}
      />

      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <Header
          title={title}
          breadcrumb={breadcrumb}
          onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
          sidebarOpen={sidebarOpen}
        />
        <div className="flex-1 overflow-hidden flex flex-col">
          <ConnectionBanner />
          <PageRouter />
          <ToastContainer />
        </div>
      </div>
    </div>
  );
}

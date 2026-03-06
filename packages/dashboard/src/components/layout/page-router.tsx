import { useAppStore } from '@/stores/use-app-store';
import { EmptyState } from '@/components/ui/empty-state';
import { KitchenSink } from '@/components/showcase/kitchen-sink';
import { ProjectView } from './project-view';
import { HomePage } from '@/pages/pm/home-page';

// Legacy runtime pages — used in RuntimePage sub-tabs
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

export function PageRouter() {
  const activeTab = useAppStore((s) => s.activeTab);
  const activeView = useAppStore((s) => s.activeView);

  // Showcase/kitchen-sink for dev use
  if (activeTab === 'showcase') {
    return <KitchenSink />;
  }

  // PM views
  if (activeView === 'home') {
    return <HomePage />;
  }

  if (activeView === 'project') {
    return <ProjectView />;
  }

  // Fallback: legacy runtime pages (direct tab routing for backwards compat)
  const RUNTIME_PAGES: Record<string, () => React.JSX.Element> = {
    overview: () => <OverviewPage />,
    network: () => <NetworkPage />,
    console: () => <ConsolePage />,
    renders: () => <RendersPage />,
    state: () => <StatePage />,
    performance: () => <PerformancePage />,
    issues: () => <IssuesPage />,
    api: () => <ApiMapPage />,
    database: () => <DatabasePage />,
    processes: () => <ProcessesPage />,
    infra: () => <InfraPage />,
    sessions: () => <SessionsPage />,
  };

  const render = RUNTIME_PAGES[activeTab];
  if (render) return render();

  return <EmptyState title="Not Found" description="This page doesn't exist." />;
}

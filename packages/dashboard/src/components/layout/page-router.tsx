import { lazy, Suspense } from 'react';
import { useAppStore } from '@/stores/use-app-store';
import { EmptyState } from '@/components/ui/empty-state';
import { TableSkeleton } from '@/components/ui/skeleton';

// Lazy-loaded pages — each becomes its own chunk
const KitchenSink = lazy(() => import('@/components/showcase/kitchen-sink').then((m) => ({ default: m.KitchenSink })));
const ProjectView = lazy(() => import('./project-view').then((m) => ({ default: m.ProjectView })));
const HomePage = lazy(() => import('@/pages/pm/home-page').then((m) => ({ default: m.HomePage })));

// Legacy runtime pages
const OverviewPage = lazy(() => import('@/pages/overview/overview-page').then((m) => ({ default: m.OverviewPage })));
const NetworkPage = lazy(() => import('@/pages/network/network-page').then((m) => ({ default: m.NetworkPage })));
const ConsolePage = lazy(() => import('@/pages/console/console-page').then((m) => ({ default: m.ConsolePage })));
const RendersPage = lazy(() => import('@/pages/renders/renders-page').then((m) => ({ default: m.RendersPage })));
const StatePage = lazy(() => import('@/pages/state/state-page').then((m) => ({ default: m.StatePage })));
const PerformancePage = lazy(() => import('@/pages/performance/performance-page').then((m) => ({ default: m.PerformancePage })));
const IssuesPage = lazy(() => import('@/pages/issues/issues-page').then((m) => ({ default: m.IssuesPage })));
const ApiMapPage = lazy(() => import('@/pages/api-map/api-map-page').then((m) => ({ default: m.ApiMapPage })));
const DatabasePage = lazy(() => import('@/pages/database/database-page').then((m) => ({ default: m.DatabasePage })));
const ProcessesPage = lazy(() => import('@/pages/processes/processes-page').then((m) => ({ default: m.ProcessesPage })));
const InfraPage = lazy(() => import('@/pages/infra/infra-page').then((m) => ({ default: m.InfraPage })));
const SessionsPage = lazy(() => import('@/pages/sessions/sessions-page').then((m) => ({ default: m.SessionsPage })));
const BreadcrumbsPage = lazy(() => import('@/pages/breadcrumbs/breadcrumbs-page').then((m) => ({ default: m.BreadcrumbsPage })));

const RUNTIME_PAGES: Record<string, React.LazyExoticComponent<React.ComponentType>> = {
  overview: OverviewPage,
  network: NetworkPage,
  console: ConsolePage,
  renders: RendersPage,
  state: StatePage,
  performance: PerformancePage,
  issues: IssuesPage,
  api: ApiMapPage,
  database: DatabasePage,
  processes: ProcessesPage,
  infra: InfraPage,
  sessions: SessionsPage,
  breadcrumbs: BreadcrumbsPage,
};

function PageFallback() {
  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      <TableSkeleton rows={10} />
    </div>
  );
}

export function PageRouter() {
  const activeTab = useAppStore((s) => s.activeTab);
  const activeView = useAppStore((s) => s.activeView);

  // Showcase/kitchen-sink for dev use
  if (activeTab === 'showcase') {
    return (
      <Suspense fallback={<PageFallback />}>
        <KitchenSink />
      </Suspense>
    );
  }

  // PM views
  if (activeView === 'home') {
    return (
      <Suspense fallback={<PageFallback />}>
        <HomePage />
      </Suspense>
    );
  }

  if (activeView === 'project') {
    return (
      <Suspense fallback={<PageFallback />}>
        <ProjectView />
      </Suspense>
    );
  }

  // Fallback: legacy runtime pages
  const Page = RUNTIME_PAGES[activeTab];
  if (Page) {
    return (
      <Suspense fallback={<PageFallback />}>
        <Page />
      </Suspense>
    );
  }

  return <EmptyState title="Not Found" description="This page doesn't exist." />;
}

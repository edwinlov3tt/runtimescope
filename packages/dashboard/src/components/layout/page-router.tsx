import { lazy, Suspense } from 'react';
import { EmptyState } from '@/components/ui/empty-state';
import { KitchenSink } from '@/components/showcase/kitchen-sink';
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

const PAGE_META: Record<string, { label: string; description: string }> = {
  overview: { label: 'Overview', description: 'Dashboard overview with key metrics and activity feed' },
  network: { label: 'Network', description: 'Monitor HTTP requests, responses, and API calls' },
  console: { label: 'Console', description: 'View console logs, warnings, and errors' },
  renders: { label: 'Renders', description: 'Track React component render performance' },
  state: { label: 'State', description: 'Inspect state stores and mutations' },
  performance: { label: 'Performance', description: 'Web Vitals and performance metrics' },
  api: { label: 'API Map', description: 'Discover and monitor API endpoints' },
  database: { label: 'Database', description: 'Query monitoring and schema inspection' },
  issues: { label: 'Issues', description: 'Detected performance and code issues' },
  processes: { label: 'Processes', description: 'Running dev processes and port usage' },
  infra: { label: 'Infrastructure', description: 'Deploy logs and platform status' },
  sessions: { label: 'Sessions', description: 'Session history and comparison' },
};

interface PageRouterProps {
  activeTab: string;
}

export function PageRouter({ activeTab }: PageRouterProps) {
  // Showcase/kitchen-sink for dev use
  if (activeTab === 'showcase') {
    return <KitchenSink />;
  }

  if (activeTab === 'overview') {
    return <OverviewPage />;
  }

  if (activeTab === 'network') {
    return <NetworkPage />;
  }

  if (activeTab === 'console') {
    return <ConsolePage />;
  }

  if (activeTab === 'renders') {
    return <RendersPage />;
  }

  if (activeTab === 'state') {
    return <StatePage />;
  }

  if (activeTab === 'performance') {
    return <PerformancePage />;
  }

  if (activeTab === 'issues') {
    return <IssuesPage />;
  }

  if (activeTab === 'api') {
    return <ApiMapPage />;
  }

  if (activeTab === 'database') {
    return <DatabasePage />;
  }

  if (activeTab === 'processes') {
    return <ProcessesPage />;
  }

  if (activeTab === 'infra') {
    return <InfraPage />;
  }

  if (activeTab === 'sessions') {
    return <SessionsPage />;
  }

  const meta = PAGE_META[activeTab];
  if (!meta) {
    return <EmptyState title="Not Found" description="This page doesn't exist." />;
  }

  // Remaining pages start as EmptyState — will be replaced as each page is built
  return <EmptyState title={meta.label} description={meta.description} />;
}

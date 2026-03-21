import { memo } from 'react';
import { Sidebar } from './sidebar';
import { PageRouter } from './page-router';
import { ToastContainer } from '@/components/ui/toast-container';
import { ConnectionBanner } from '@/components/ui/connection-banner';

export const AppShell = memo(function AppShell() {
  return (
    <div className="h-screen w-screen bg-bg-base flex overflow-hidden">
      <Sidebar />
      <main className="flex-1 bg-bg-surface overflow-hidden flex flex-col">
        <ConnectionBanner />
        <PageRouter />
      </main>
      <ToastContainer />
    </div>
  );
});

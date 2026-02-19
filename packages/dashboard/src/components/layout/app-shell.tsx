import { Sidebar } from './sidebar';
import type { ReactNode } from 'react';

interface AppShellProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
  children: ReactNode;
}

/**
 * The "floating content" pattern — dark sidebar frame with a rounded
 * content container that floats inside it.
 */
export function AppShell({ activeTab, onTabChange, children }: AppShellProps) {
  return (
    <div className="h-screen w-screen bg-bg-base flex overflow-hidden">
      <Sidebar activeTab={activeTab} onTabChange={onTabChange} />
      <main className="flex-1 bg-bg-surface overflow-hidden flex flex-col">
        {children}
      </main>
    </div>
  );
}

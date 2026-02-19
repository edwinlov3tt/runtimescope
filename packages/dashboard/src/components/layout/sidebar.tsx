import { ProjectSelector } from './project-selector';
import { cn } from '@/lib/cn';
import {
  Activity,
  AlertTriangle,
  Database,
  Globe,
  Layout,
  Monitor,
  Network,
  Server,
  Terminal,
  Layers,
  GitCompare,
  Zap,
  Settings,
  type LucideIcon,
} from 'lucide-react';

interface NavItem {
  icon: LucideIcon;
  label: string;
  id: string;
}

interface NavSection {
  title?: string;
  items: NavItem[];
}

const NAV_SECTIONS: NavSection[] = [
  {
    items: [
      { icon: Layout, label: 'Overview', id: 'overview' },
    ],
  },
  {
    title: 'Observe',
    items: [
      { icon: Network, label: 'Network', id: 'network' },
      { icon: Terminal, label: 'Console', id: 'console' },
      { icon: Zap, label: 'Renders', id: 'renders' },
      { icon: Layers, label: 'State', id: 'state' },
      { icon: Activity, label: 'Performance', id: 'performance' },
    ],
  },
  {
    title: 'Discover',
    items: [
      { icon: Globe, label: 'API Map', id: 'api' },
      { icon: Database, label: 'Database', id: 'database' },
      { icon: AlertTriangle, label: 'Issues', id: 'issues' },
    ],
  },
  {
    title: 'System',
    items: [
      { icon: Monitor, label: 'Processes', id: 'processes' },
      { icon: Server, label: 'Infrastructure', id: 'infra' },
      { icon: GitCompare, label: 'Sessions', id: 'sessions' },
    ],
  },
];

interface SidebarProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
}

export function Sidebar({ activeTab, onTabChange }: SidebarProps) {
  return (
    <aside className="w-[240px] shrink-0 flex flex-col bg-bg-base border-r border-border-muted overflow-y-auto">
      {/* Logo */}
      <div className="h-14 flex items-center gap-2.5 px-5">
        <div className="w-6 h-6 rounded-md bg-brand-dark border border-brand-border flex items-center justify-center">
          <span className="text-brand-light text-xs font-bold">R</span>
        </div>
        <span className="text-sm font-semibold text-text-primary tracking-tight">
          RuntimeScope
        </span>
      </div>

      {/* Project Selector */}
      <ProjectSelector />

      {/* Navigation */}
      <nav className="flex-1 px-3 pb-4 space-y-5">
        {NAV_SECTIONS.map((section, si) => (
          <div key={si}>
            {section.title && (
              <div className="px-2 mb-1.5">
                <span className="text-[10px] font-medium text-text-muted uppercase tracking-widest">
                  {section.title}
                </span>
              </div>
            )}
            <div className="space-y-0.5">
              {section.items.map((item) => {
                const isActive = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => onTabChange(item.id)}
                    className={cn(
                      'w-full flex items-center gap-2.5 h-8 px-2.5 rounded-md text-[13px] font-medium transition-colors cursor-pointer',
                      isActive
                        ? 'bg-brand-muted text-text-primary'
                        : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'
                    )}
                  >
                    <item.icon
                      size={16}
                      strokeWidth={1.75}
                      className={cn(isActive ? 'text-brand' : 'text-text-tertiary')}
                    />
                    {item.label}
                    {isActive && (
                      <div className="ml-auto w-1 h-4 rounded-full bg-brand" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Bottom */}
      <div className="px-3 pb-4">
        <button className="w-full flex items-center gap-2.5 h-8 px-2.5 rounded-md text-[13px] font-medium text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer">
          <Settings size={16} strokeWidth={1.75} className="text-text-tertiary" />
          Settings
        </button>
      </div>
    </aside>
  );
}

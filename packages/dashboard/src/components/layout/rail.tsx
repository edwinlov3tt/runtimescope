import { memo, useState, useRef, useEffect, useCallback } from 'react';
import { cn } from '@/lib/cn';
import { useAppStore } from '@/stores/use-app-store';
import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard,
  MessagesSquare,
  Activity,
  GitCommitHorizontal,
  CheckSquare,
  Brain,
  ScrollText,
  Receipt,
  Cpu,
  Settings,
  Hexagon,
  ArrowLeft,
  // Runtime context icons
  Globe,
  Terminal,
  AlertTriangle,
  Layers,
  Box,
  Gauge,
  GitBranch,
  Database,
  Footprints,
  Radio,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Navigation definitions
// ---------------------------------------------------------------------------

export interface RailItem {
  id: string;
  icon: LucideIcon;
  label: string;
  badge?: boolean;
}

// Home context
export const HOME_RAIL_ITEMS: RailItem[] = [
  { id: 'home',     icon: LayoutDashboard,   label: 'Home' },
  { id: 'sessions', icon: MessagesSquare,    label: 'Sessions' },
  { id: 'runtime',  icon: Activity,          label: 'Runtime', badge: true },
  { id: 'git',      icon: GitCommitHorizontal, label: 'Git' },
  { id: 'tasks',    icon: CheckSquare,       label: 'Tasks' },
  { id: 'memory',   icon: Brain,             label: 'Memory' },
  { id: 'rules',    icon: ScrollText,        label: 'Rules' },
];

export const HOME_RAIL_BOTTOM: RailItem[] = [
  { id: 'capex',     icon: Receipt,  label: 'CapEx' },
  { id: 'processes', icon: Cpu,      label: 'Processes' },
  { id: 'settings',  icon: Settings, label: 'Settings' },
];

// Runtime context
export const RUNTIME_RAIL_ITEMS: RailItem[] = [
  { id: 'overview',     icon: LayoutDashboard, label: 'Overview' },
  { id: 'network',      icon: Globe,           label: 'Network' },
  { id: 'console',      icon: Terminal,        label: 'Console' },
  { id: 'issues',       icon: AlertTriangle,   label: 'Issues', badge: true },
  { id: 'renders',      icon: Layers,          label: 'Renders' },
  { id: 'state',        icon: Box,             label: 'State' },
  { id: 'performance',  icon: Gauge,           label: 'Performance' },
  { id: 'api-map',      icon: GitBranch,       label: 'API Map' },
  { id: 'database',     icon: Database,        label: 'Database' },
  { id: 'breadcrumbs',  icon: Footprints,      label: 'Breadcrumbs' },
  { id: 'events',       icon: Radio,           label: 'Events' },
];

export const RUNTIME_RAIL_BOTTOM: RailItem[] = [
  { id: 'processes', icon: Cpu,      label: 'Processes' },
  { id: 'settings',  icon: Settings, label: 'Settings' },
];

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

function RailTooltip({ label, anchorRect }: { label: string; anchorRect: DOMRect | null }) {
  if (!anchorRect) return null;
  return (
    <div
      className="fixed z-[9999] pointer-events-none px-2.5 py-1 text-[12px] font-semibold text-accent bg-bg-elevated border border-accent-border rounded-md shadow-md whitespace-nowrap"
      style={{
        top: anchorRect.top + anchorRect.height / 2,
        left: anchorRect.right + 10,
        transform: 'translateY(-50%)',
      }}
    >
      {label}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rail Item Button
// ---------------------------------------------------------------------------

function RailItemButton({
  item,
  isActive,
  disabled,
  onClick,
  onHover,
  onLeave,
}: {
  item: RailItem;
  isActive: boolean;
  disabled?: boolean;
  onClick: () => void;
  onHover: (rect: DOMRect, label: string) => void;
  onLeave: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const Icon = item.icon;

  return (
    <button
      ref={ref}
      onClick={disabled ? undefined : onClick}
      onMouseEnter={() => {
        if (ref.current) onHover(ref.current.getBoundingClientRect(), item.label);
      }}
      onMouseLeave={onLeave}
      className={cn(
        'relative w-11 h-11 rounded-xl flex items-center justify-center transition-all',
        disabled
          ? 'text-text-disabled/40 cursor-default'
          : isActive
            ? 'text-text-primary bg-bg-overlay cursor-pointer'
            : 'text-text-disabled hover:text-text-secondary hover:bg-bg-hover cursor-pointer',
      )}
    >
      {/* Active indicator bar */}
      {isActive && (
        <span className="absolute -left-2.5 top-1/2 -translate-y-1/2 w-[3px] h-5 bg-accent rounded-r-sm" />
      )}
      <Icon size={20} />
      {/* Badge dot */}
      {item.badge && (
        <span className="absolute top-2 right-2 w-[7px] h-[7px] rounded-full bg-green border-2 border-bg-base animate-pulse-dot" />
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Rail
// ---------------------------------------------------------------------------

export const Rail = memo(function Rail({
  items,
  bottomItems,
  activeId,
  onSelect,
  isSubContext = false,
  onBack,
  disabledIds,
}: {
  items: RailItem[];
  bottomItems: RailItem[];
  activeId: string;
  onSelect: (id: string) => void;
  isSubContext?: boolean;
  onBack?: () => void;
  disabledIds?: Set<string>;
}) {
  const [tooltip, setTooltip] = useState<{ rect: DOMRect; label: string } | null>(null);

  const handleHover = useCallback((rect: DOMRect, label: string) => {
    setTooltip({ rect, label });
  }, []);

  const handleLeave = useCallback(() => {
    setTooltip(null);
  }, []);

  return (
    <nav className="w-[var(--rail-width)] shrink-0 bg-bg-base border-r border-border-muted flex flex-col items-center py-4 z-10">
      {/* Logo / Back */}
      {isSubContext ? (
        <button
          onClick={onBack}
          onMouseEnter={(e) => handleHover(e.currentTarget.getBoundingClientRect(), 'Back to Home')}
          onMouseLeave={handleLeave}
          className="w-8 h-8 rounded-md bg-accent-muted border border-accent-border flex items-center justify-center text-accent mb-6 cursor-pointer hover:bg-accent/25 hover:border-accent transition-all"
        >
          <ArrowLeft size={18} />
        </button>
      ) : (
        <div className="w-8 h-8 rounded-md bg-gradient-to-br from-accent-dark to-accent-muted border border-accent-border flex items-center justify-center text-accent mb-6">
          <Hexagon size={18} />
        </div>
      )}

      {/* Main nav */}
      <div className="flex flex-col gap-1 flex-1">
        {items.map((item) => (
          <RailItemButton
            key={item.id}
            item={item}
            isActive={activeId === item.id}
            disabled={disabledIds?.has(item.id)}
            onClick={() => onSelect(item.id)}
            onHover={handleHover}
            onLeave={handleLeave}
          />
        ))}
      </div>

      {/* Bottom nav */}
      <div className="flex flex-col gap-1 mt-auto">
        <div className="w-8 h-px bg-border-muted my-2" />
        {bottomItems.map((item) => (
          <RailItemButton
            key={item.id}
            item={item}
            isActive={activeId === item.id}
            disabled={disabledIds?.has(item.id)}
            onClick={() => onSelect(item.id)}
            onHover={handleHover}
            onLeave={handleLeave}
          />
        ))}
      </div>

      {/* Tooltip portal */}
      {tooltip && <RailTooltip label={tooltip.label} anchorRect={tooltip.rect} />}
    </nav>
  );
});

import { memo } from 'react';
import { cn } from '@/lib/cn';
import type { RailItem } from '@/components/layout/rail';

// ---------------------------------------------------------------------------
// Sidebar Nav Item
// ---------------------------------------------------------------------------

function SidebarNavItem({
  item,
  isActive,
  onClick,
}: {
  item: RailItem;
  isActive?: boolean;
  onClick?: () => void;
}) {
  const Icon = item.icon;
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-2.5 h-[34px] px-2.5 rounded-md text-[13px] font-medium whitespace-nowrap transition-all cursor-pointer',
        isActive
          ? 'text-text-primary bg-bg-overlay'
          : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover',
      )}
    >
      <Icon size={16} className="shrink-0" />
      <span className="flex-1 text-left overflow-hidden text-ellipsis">{item.label}</span>
      {item.badge && (
        <span className="w-1.5 h-1.5 rounded-full bg-green shrink-0" />
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Section Label
// ---------------------------------------------------------------------------

function SectionLabel({ children, visible }: { children: React.ReactNode; visible: boolean }) {
  return (
    <div
      className={cn(
        'text-[10px] font-semibold text-text-muted uppercase tracking-[0.06em] px-4 py-1 pb-2 whitespace-nowrap transition-opacity',
        visible ? 'opacity-100' : 'opacity-0',
      )}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expandable Sidebar
// ---------------------------------------------------------------------------

export const ExpandableSidebar = memo(function ExpandableSidebar({
  open,
  isSubContext,
  mainItems,
  mainBottomItems,
  parentItems,
  parentBottomItems,
  activeId,
  onSelect,
}: {
  open: boolean;
  isSubContext: boolean;
  mainItems: RailItem[];
  mainBottomItems: RailItem[];
  parentItems?: RailItem[];
  parentBottomItems?: RailItem[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  if (isSubContext && parentItems && parentBottomItems) {
    // Runtime context: Runtime section on top, Project section below
    return (
      <aside
        className={cn(
          'shrink-0 bg-bg-app border-r border-border-muted flex flex-col overflow-hidden transition-all duration-200 ease-in-out z-[9]',
          open ? 'w-[var(--sidebar-width)] py-4 overflow-y-auto' : 'w-0',
        )}
      >
        <SectionLabel visible={open}>Runtime</SectionLabel>
        <div className="flex flex-col gap-px px-2">
          {mainItems.map((item) => (
            <SidebarNavItem
              key={item.id}
              item={item}
              isActive={activeId === item.id}
              onClick={() => onSelect(item.id)}
            />
          ))}
        </div>
        <div className="h-px bg-border-muted mx-4 my-2" />
        <div className="flex flex-col gap-px px-2">
          {mainBottomItems.map((item) => (
            <SidebarNavItem
              key={item.id}
              item={item}
              isActive={activeId === item.id}
              onClick={() => onSelect(item.id)}
            />
          ))}
        </div>
        <div className="h-px bg-border-muted mx-4 my-2" />
        <SectionLabel visible={open}>Project</SectionLabel>
        <div className="flex flex-col gap-px px-2">
          {parentItems.map((item) => (
            <SidebarNavItem key={item.id} item={item} onClick={() => onSelect(item.id)} />
          ))}
        </div>
        <div className="h-px bg-border-muted mx-4 my-2" />
        <div className="flex flex-col gap-px px-2">
          {parentBottomItems.map((item) => (
            <SidebarNavItem key={item.id} item={item} onClick={() => onSelect(item.id)} />
          ))}
        </div>
      </aside>
    );
  }

  // Home context: Project nav on top
  return (
    <aside
      className={cn(
        'shrink-0 bg-bg-app border-r border-border-muted flex flex-col overflow-hidden transition-all duration-200 ease-in-out z-[9]',
        open ? 'w-[var(--sidebar-width)] py-4 overflow-y-auto' : 'w-0',
      )}
    >
      <SectionLabel visible={open}>Navigation</SectionLabel>
      <div className="flex flex-col gap-px px-2">
        {mainItems.map((item) => (
          <SidebarNavItem
            key={item.id}
            item={item}
            isActive={activeId === item.id}
            onClick={() => onSelect(item.id)}
          />
        ))}
      </div>
      <div className="h-px bg-border-muted mx-4 my-2" />
      <div className="flex flex-col gap-px px-2">
        {mainBottomItems.map((item) => (
          <SidebarNavItem
            key={item.id}
            item={item}
            isActive={activeId === item.id}
            onClick={() => onSelect(item.id)}
          />
        ))}
      </div>
    </aside>
  );
});

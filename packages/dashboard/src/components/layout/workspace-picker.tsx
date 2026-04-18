/**
 * Workspace picker — appears in the header next to the project dropdown.
 * Lets users filter their view to a single workspace or show all.
 */

import { memo, useState, useRef, useEffect } from 'react';
import { ChevronDown, Check, Plus, Settings } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useWorkspaceStore } from '@/stores/use-workspace-store';
import { useAppStore } from '@/stores/use-app-store';

export const WorkspacePicker = memo(function WorkspacePicker() {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const setActive = useWorkspaceStore((s) => s.setActiveWorkspace);
  const setActiveView = useAppStore((s) => s.setActiveView);

  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [open]);

  const active = workspaces.find((w) => w.id === activeId);
  const label = active?.name ?? 'All workspaces';

  // Hide the picker entirely if there's only one workspace — keeps the header
  // clean for single-user installs who don't need multi-tenancy.
  if (workspaces.length <= 1) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        className="flex items-center gap-1.5 h-8 px-2.5 rounded-md hover:bg-bg-hover transition-colors cursor-pointer"
      >
        <span className="text-[11px] text-text-muted uppercase tracking-wide">Workspace</span>
        <span className="text-[13px] font-medium text-text-primary">{label}</span>
        <ChevronDown size={12} className="text-text-muted" />
      </button>

      {open && (
        <div className="absolute top-[calc(100%+4px)] left-0 w-[280px] bg-bg-surface border border-border-strong rounded-lg shadow-lg z-[100] overflow-hidden">
          <div className="p-1">
            <button
              onClick={() => {
                setActive(null);
                setOpen(false);
              }}
              className={cn(
                'w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-md text-[13px] text-left transition-colors cursor-pointer',
                activeId === null ? 'bg-accent-muted text-text-primary' : 'hover:bg-bg-hover text-text-secondary',
              )}
            >
              <span>All workspaces</span>
              {activeId === null && <Check size={14} className="text-accent" />}
            </button>

            <div className="h-px bg-border-muted my-1" />

            {workspaces.map((ws) => (
              <button
                key={ws.id}
                onClick={() => {
                  setActive(ws.id);
                  setOpen(false);
                }}
                className={cn(
                  'w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-md text-[13px] text-left transition-colors cursor-pointer',
                  activeId === ws.id ? 'bg-accent-muted text-text-primary' : 'hover:bg-bg-hover text-text-secondary',
                )}
              >
                <span className="flex items-center gap-2 truncate">
                  <span className="truncate">{ws.name}</span>
                  {ws.isDefault && (
                    <span className="text-[10px] text-text-muted uppercase tracking-wide shrink-0">default</span>
                  )}
                </span>
                {activeId === ws.id && <Check size={14} className="text-accent" />}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 p-1 border-t border-border-muted">
            <button
              onClick={() => {
                setActiveView('settings');
                setOpen(false);
              }}
              className="flex-1 flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[12px] text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
            >
              <Plus size={12} />
              New workspace
            </button>
            <button
              onClick={() => {
                setActiveView('settings');
                setOpen(false);
              }}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-md text-[12px] text-text-tertiary hover:text-text-primary hover:bg-bg-hover transition-colors cursor-pointer"
              title="Workspace settings"
            >
              <Settings size={12} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
});

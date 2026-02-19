import { useState, useRef, useEffect } from 'react';
import { useAppStore } from '@/stores/use-app-store';
import { StatusDot } from '@/components/ui';
import { ChevronDown, Layers } from 'lucide-react';
import { cn } from '@/lib/cn';

export function ProjectSelector() {
  const projects = useAppStore((s) => s.projects);
  const selectedProject = useAppStore((s) => s.selectedProject);
  const setSelectedProject = useAppStore((s) => s.setSelectedProject);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (projects.length === 0) return null;

  const displayName = selectedProject ?? 'All Projects';
  const selected = projects.find((p) => p.appName === selectedProject);
  const hasConnected = selected?.isConnected ?? projects.some((p) => p.isConnected);

  return (
    <div ref={ref} className="relative px-3 mb-2">
      <button
        onClick={() => setOpen(!open)}
        className={cn(
          'w-full flex items-center gap-2 h-8 px-2.5 rounded-md text-[13px] font-medium transition-colors cursor-pointer',
          'bg-bg-hover hover:bg-bg-active text-text-primary',
        )}
      >
        {selectedProject ? (
          <StatusDot color={hasConnected ? 'green' : 'gray'} size="sm" />
        ) : (
          <Layers size={14} strokeWidth={1.75} className="text-text-tertiary" />
        )}
        <span className="truncate flex-1 text-left">{displayName}</span>
        <ChevronDown size={14} className={cn('text-text-muted transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="absolute left-3 right-3 top-9 z-50 bg-bg-surface border border-border-muted rounded-lg shadow-lg py-1 max-h-64 overflow-y-auto">
          <button
            onClick={() => { setSelectedProject(null); setOpen(false); }}
            className={cn(
              'w-full flex items-center gap-2.5 h-7 px-2.5 text-[12px] font-medium transition-colors cursor-pointer',
              'hover:bg-bg-hover',
              !selectedProject ? 'text-brand' : 'text-text-secondary',
            )}
          >
            <Layers size={12} className="text-text-tertiary" />
            All Projects
          </button>
          <div className="h-px bg-border-muted mx-2 my-1" />
          {projects.map((p) => (
            <button
              key={p.appName}
              onClick={() => { setSelectedProject(p.appName); setOpen(false); }}
              className={cn(
                'w-full flex items-center gap-2.5 h-7 px-2.5 text-[12px] font-medium transition-colors cursor-pointer',
                'hover:bg-bg-hover',
                selectedProject === p.appName ? 'text-brand' : 'text-text-secondary',
              )}
            >
              <StatusDot color={p.isConnected ? 'green' : 'gray'} size="sm" />
              <span className="truncate flex-1 text-left">{p.appName}</span>
              <span className="text-[10px] text-text-muted tabular-nums">{p.eventCount}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

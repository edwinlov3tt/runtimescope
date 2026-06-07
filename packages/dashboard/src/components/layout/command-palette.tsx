import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Search, CornerDownLeft, Globe, Terminal, AlertTriangle, FolderGit2 } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useAppStore } from '@/stores/use-app-store';
import { usePmStore } from '@/stores/use-pm-store';
import { useWorkspaceStore } from '@/stores/use-workspace-store';
import { useDataStore } from '@/stores/use-data-store';
import {
  HOME_RAIL_ITEMS,
  HOME_RAIL_BOTTOM,
  RUNTIME_RAIL_ITEMS,
  RUNTIME_RAIL_BOTTOM,
} from '@/components/layout/rail';

// ---------------------------------------------------------------------------
// Result model
// ---------------------------------------------------------------------------

type ResultKind = 'page' | 'project' | 'event';

interface PaletteResult {
  id: string;
  kind: ResultKind;
  label: string;
  hint?: string;
  icon: LucideIcon;
  /** Dispatches navigation when the item is chosen. */
  run: () => void;
}

const KIND_LABEL: Record<ResultKind, string> = {
  page: 'Pages',
  project: 'Projects',
  event: 'Recent activity',
};

// ---------------------------------------------------------------------------
// Navigation dispatch — mirrors handleRailSelect in app-shell.tsx so the
// palette drives the SAME store actions the rail/sidebar use (no new router).
// ---------------------------------------------------------------------------

/** Rail ids that map to a runtime tab. */
const RUNTIME_TAB_IDS = new Set([
  ...RUNTIME_RAIL_ITEMS.map((i) => i.id),
  ...RUNTIME_RAIL_BOTTOM.map((i) => i.id),
]);

/** Home-context project tabs (require a selected project). */
const HOME_PROJECT_TABS: Record<string, string> = {
  sessions: 'sessions', git: 'git', tasks: 'tasks',
  memory: 'memory', rules: 'rules', capex: 'capex',
};

function navigateToRailId(id: string) {
  const app = useAppStore.getState();
  if (id === 'settings') { app.setActiveView('settings'); return; }
  if (id === 'home') { app.setActiveView('home'); return; }
  if (id === 'runtime') { app.setActiveView('runtime'); app.setActiveTab('overview'); return; }
  if (id === 'processes') {
    // Processes is global; it lives under the home context in the rail.
    app.setActiveView('home'); return;
  }
  if (RUNTIME_TAB_IDS.has(id)) {
    // When a PM project is open the runtime tabs live INSIDE the project view
    // (as runtimeSubTab under the 'runtime' project tab) — navigating to the
    // legacy runtime view would yank the user out of their project context.
    if (app.selectedPmProject) {
      app.setActiveProjectTab('runtime');
      app.setRuntimeSubTab(id);
    } else {
      app.setActiveView('runtime');
      app.setActiveTab(id);
    }
    return;
  }
  const projectTab = HOME_PROJECT_TABS[id];
  if (projectTab) {
    if (app.selectedPmProject) {
      app.setActiveView('project');
      app.setActiveProjectTab(projectTab as never);
    } else {
      app.setActiveView('home');
    }
  }
}

// ---------------------------------------------------------------------------
// Static page registry — derived from the rail definitions (single source of
// truth for navigation), de-duplicated across home + runtime contexts.
// ---------------------------------------------------------------------------

const PAGE_ITEMS = (() => {
  const seen = new Set<string>();
  const items: { id: string; label: string; icon: LucideIcon; hint: string }[] = [];
  const push = (railItems: typeof HOME_RAIL_ITEMS, hint: string) => {
    for (const it of railItems) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      items.push({ id: it.id, label: it.label, icon: it.icon, hint });
    }
  };
  push(HOME_RAIL_ITEMS, 'Home');
  push(HOME_RAIL_BOTTOM, 'Home');
  push(RUNTIME_RAIL_ITEMS, 'Runtime');
  push(RUNTIME_RAIL_BOTTOM, 'Runtime');
  return items;
})();

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const projects = usePmStore((s) => s.projects);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const selectPmProject = useAppStore((s) => s.selectPmProject);
  const network = useDataStore((s) => s.network);
  const consoleEvents = useDataStore((s) => s.console);

  // Reset query each time the palette opens and focus the field.
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  // Modal a11y while open: lock body scroll and close on Escape even when focus
  // has left the search input (the input's own onKeyDown handles the focused
  // case; this document-level listener is the fallback).
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  const results = useMemo<PaletteResult[]>(() => {
    const q = query.trim().toLowerCase();
    const out: PaletteResult[] = [];

    // (a) Pages / tabs
    for (const p of PAGE_ITEMS) {
      out.push({
        id: `page:${p.id}`,
        kind: 'page',
        label: p.label,
        hint: p.hint,
        icon: p.icon,
        run: () => navigateToRailId(p.id),
      });
    }

    // (b) Projects / workspaces (scoped to active workspace, like the header dropdown)
    const scoped = activeWorkspaceId
      ? projects.filter((p) => p.workspaceId === activeWorkspaceId)
      : projects;
    for (const p of scoped) {
      out.push({
        id: `project:${p.id}`,
        kind: 'project',
        label: p.name,
        hint: 'Open project',
        icon: FolderGit2,
        run: () => selectPmProject(p.id),
      });
    }

    // (c) Recent activity — only surfaced when the user is searching, to keep
    // the default list focused on navigation. Jumps to the relevant runtime tab.
    if (q) {
      for (const ev of network.slice(-200).reverse()) {
        out.push({
          id: `net:${ev.eventId}`,
          kind: 'event',
          label: `${ev.method} ${ev.url}`,
          hint: ev.status ? `${ev.status}` : 'failed',
          icon: Globe,
          run: () => navigateToRailId('network'),
        });
      }
      for (const ev of consoleEvents.slice(-200).reverse()) {
        const isErr = ev.level === 'error';
        out.push({
          id: `con:${ev.eventId}`,
          kind: 'event',
          label: ev.message,
          hint: ev.level,
          icon: isErr ? AlertTriangle : Terminal,
          run: () => navigateToRailId('console'),
        });
      }
    }

    if (!q) return out;
    return out.filter(
      (r) => r.label.toLowerCase().includes(q) || (r.hint?.toLowerCase().includes(q) ?? false),
    );
  }, [query, projects, activeWorkspaceId, selectPmProject, network, consoleEvents]);

  // Clamp the highlighted index whenever the result set shrinks.
  useEffect(() => {
    setSelectedIndex((i) => Math.min(i, Math.max(0, results.length - 1)));
  }, [results.length]);

  const choose = useCallback(
    (index: number) => {
      const r = results[index];
      if (!r) return;
      r.run();
      onClose();
    },
    [results, onClose],
  );

  // Keyboard nav — handled on the input so it works while the field has focus.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((i) => Math.max(i - 1, 0));
          break;
        case 'Enter':
          e.preventDefault();
          choose(selectedIndex);
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    },
    [results.length, selectedIndex, choose, onClose],
  );

  // Keep the highlighted row scrolled into view.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, open]);

  if (!open) return null;

  // Group consecutive results by kind for section headers.
  let lastKind: ResultKind | null = null;

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-start justify-center pt-[12vh] bg-black/50"
      onMouseDown={onClose}
    >
      <div
        className="w-[560px] max-w-[90vw] bg-bg-surface border border-border-strong rounded-xl shadow-lg overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="relative border-b border-border-muted">
          <Search size={15} className="absolute left-4 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search pages, projects, recent activity..."
            className="w-full h-12 bg-transparent pl-11 pr-4 text-[14px] text-text-primary outline-none placeholder:text-text-muted"
          />
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <div className="px-3 py-6 text-center text-[13px] text-text-muted">No results</div>
          ) : (
            results.map((r, i) => {
              const Icon = r.icon;
              const isActive = i === selectedIndex;
              const showHeader = r.kind !== lastKind;
              lastKind = r.kind;
              return (
                <div key={r.id}>
                  {showHeader && (
                    <div className="text-[10px] font-semibold text-text-muted uppercase tracking-[0.06em] px-2.5 pt-2 pb-1">
                      {KIND_LABEL[r.kind]}
                    </div>
                  )}
                  <button
                    data-index={i}
                    onMouseEnter={() => setSelectedIndex(i)}
                    onClick={() => choose(i)}
                    className={cn(
                      'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-left transition-colors cursor-pointer',
                      isActive ? 'bg-accent-muted' : 'hover:bg-bg-hover',
                    )}
                  >
                    <Icon size={15} className="shrink-0 text-text-tertiary" />
                    <span className="flex-1 text-[13px] text-text-primary truncate">{r.label}</span>
                    {r.hint && (
                      <span className="text-[11px] text-text-muted font-mono shrink-0">{r.hint}</span>
                    )}
                    {isActive && <CornerDownLeft size={13} className="text-text-muted shrink-0" />}
                  </button>
                </div>
              );
            })
          )}
        </div>

        {/* Footer hint */}
        <div className="flex items-center gap-3 px-3 py-2 border-t border-border-muted text-[11px] text-text-muted">
          <span className="flex items-center gap-1">
            <kbd className="font-mono px-1 py-0.5 bg-bg-elevated border border-border-default rounded">↑↓</kbd> navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="font-mono px-1 py-0.5 bg-bg-elevated border border-border-default rounded">↵</kbd> select
          </span>
          <span className="flex items-center gap-1">
            <kbd className="font-mono px-1 py-0.5 bg-bg-elevated border border-border-default rounded">esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}

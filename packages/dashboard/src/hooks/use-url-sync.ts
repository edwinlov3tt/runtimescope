import { useEffect, useRef } from 'react';
import { useAppStore } from '@/stores/use-app-store';
import type { ProjectTab } from '@/lib/pm-types';

/**
 * Two-way sync between the navigation state in `useAppStore` and the URL query
 * string, so a refresh restores the current page instead of dropping back to
 * Home, and browser back/forward navigate between views.
 *
 * Scheme (query params on the current path):
 *   Home      → ?view=home
 *   Runtime   → ?view=runtime&tab=<runtime page id>
 *   Settings  → ?view=settings
 *   Analytics → ?view=analytics&atab=<analytics sub-tab>
 *   Project   → ?view=project&project=<id>&ptab=<project tab>[&sub=<runtime sub-tab>]
 *
 * The write side only `pushState`s when the URL actually changes, so applying a
 * URL on load / popstate doesn't loop back into a new history entry.
 */

const VIEWS = ['home', 'project', 'runtime', 'settings', 'analytics'] as const;
type View = (typeof VIEWS)[number];

const PROJECT_TABS: ProjectTab[] = ['tasks', 'sessions', 'git', 'sdk', 'runtime', 'notes', 'memory', 'rules', 'capex'];

interface NavSnapshot {
  view?: View;
  tab?: string;
  projectTab?: ProjectTab;
  runtimeSubTab?: string;
  analyticsSubTab?: string;
  pmProject?: string | null;
}

/** Parse the current URL into a nav snapshot, or null if it carries no `view`. */
function readUrl(): NavSnapshot | null {
  const p = new URLSearchParams(window.location.search);
  const view = p.get('view');
  if (!view || !VIEWS.includes(view as View)) return null;

  const nav: NavSnapshot = { view: view as View };
  const tab = p.get('tab');
  if (tab) nav.tab = tab;
  const ptab = p.get('ptab');
  if (ptab && PROJECT_TABS.includes(ptab as ProjectTab)) nav.projectTab = ptab as ProjectTab;
  const sub = p.get('sub');
  if (sub) nav.runtimeSubTab = sub;
  const atab = p.get('atab');
  if (atab) nav.analyticsSubTab = atab;
  const project = p.get('project');
  if (project) nav.pmProject = project;
  return nav;
}

/** Build the canonical URL (path + query) for the current nav state. */
function buildUrl(): string {
  const s = useAppStore.getState();
  const p = new URLSearchParams();
  p.set('view', s.activeView);
  if (s.activeView === 'runtime') {
    p.set('tab', s.activeTab);
  } else if (s.activeView === 'analytics') {
    p.set('atab', s.analyticsSubTab);
  } else if (s.activeView === 'project') {
    if (s.selectedPmProject) p.set('project', s.selectedPmProject);
    p.set('ptab', s.activeProjectTab);
    if (s.activeProjectTab === 'runtime') p.set('sub', s.runtimeSubTab);
  }
  return `${window.location.pathname}?${p.toString()}`;
}

export function useUrlSync(): void {
  // Hydrate from the URL on mount, and re-hydrate on browser back/forward.
  useEffect(() => {
    const apply = () => {
      const nav = readUrl();
      useAppStore.getState().restoreNav(nav ?? { view: 'home' });
    };
    apply();
    window.addEventListener('popstate', apply);
    return () => window.removeEventListener('popstate', apply);
  }, []);

  // Reflect nav changes into the URL. Only push when the URL actually changes —
  // applying a URL (load/popstate) rebuilds the same string, so it no-ops here.
  const activeView = useAppStore((s) => s.activeView);
  const activeTab = useAppStore((s) => s.activeTab);
  const activeProjectTab = useAppStore((s) => s.activeProjectTab);
  const runtimeSubTab = useAppStore((s) => s.runtimeSubTab);
  const analyticsSubTab = useAppStore((s) => s.analyticsSubTab);
  const selectedPmProject = useAppStore((s) => s.selectedPmProject);

  const firstWrite = useRef(true);
  useEffect(() => {
    const next = buildUrl();
    const cur = window.location.pathname + window.location.search;
    if (next !== cur) {
      // Canonicalize the initial URL in place; push real navigations so
      // back/forward work.
      if (firstWrite.current) window.history.replaceState(null, '', next);
      else window.history.pushState(null, '', next);
    }
    firstWrite.current = false;
  }, [activeView, activeTab, activeProjectTab, runtimeSubTab, analyticsSubTab, selectedPmProject]);
}

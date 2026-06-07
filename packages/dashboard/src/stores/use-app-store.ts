import { create } from 'zustand';
import { useDataStore } from '@/stores/use-data-store';
import type { ProjectInfo } from '@/lib/api';
import type { ProjectTab } from '@/lib/pm-types';

interface DetailPanelState {
  open: boolean;
  rowIndex: number | null;
}

type ActiveView = 'home' | 'project' | 'runtime' | 'settings';

// --- Time range (global header date-range filter) ---

/**
 * Preset time windows for scoping event/session queries.
 * - `'all'` means no time bound (no `since_seconds` sent).
 * - `'custom'` uses the `customSinceSeconds` value.
 * The numeric presets are durations in seconds, converted to the collector's
 * `since_seconds` param ("events newer than now - since_seconds*1000").
 */
export type TimeRangePreset = '15m' | '1h' | '24h' | '7d' | 'all' | 'custom';

export interface TimeRange {
  preset: TimeRangePreset;
  /** Used only when preset === 'custom'. Duration in seconds. */
  customSinceSeconds?: number;
}

/** Seconds for each numeric preset. */
export const TIME_RANGE_SECONDS: Record<Exclude<TimeRangePreset, 'all' | 'custom'>, number> = {
  '15m': 15 * 60,
  '1h': 60 * 60,
  '24h': 24 * 60 * 60,
  '7d': 7 * 24 * 60 * 60,
};

export const TIME_RANGE_LABELS: Record<TimeRangePreset, string> = {
  '15m': 'Last 15 minutes',
  '1h': 'Last hour',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  all: 'All time',
  custom: 'Custom range',
};

/** Short label for the header pill. */
export const TIME_RANGE_PILL_LABELS: Record<TimeRangePreset, string> = {
  '15m': 'Last 15m',
  '1h': 'Last 1h',
  '24h': 'Last 24h',
  '7d': 'Last 7d',
  all: 'All time',
  custom: 'Custom',
};

/**
 * Resolve a TimeRange to a `since_seconds` value for event reads.
 * Returns `undefined` for 'all' (no time bound).
 */
export function timeRangeToSinceSeconds(range: TimeRange): number | undefined {
  if (range.preset === 'all') return undefined;
  if (range.preset === 'custom') return range.customSinceSeconds;
  return TIME_RANGE_SECONDS[range.preset];
}

/**
 * Resolve a TimeRange to PM `start_date`/`end_date` (ISO strings).
 * `end` is now; `start` is now - sinceSeconds. Returns empty for 'all'.
 */
export function timeRangeToDates(range: TimeRange): { start_date?: string; end_date?: string } {
  const since = timeRangeToSinceSeconds(range);
  if (since === undefined) return {};
  const now = Date.now();
  return {
    start_date: new Date(now - since * 1000).toISOString(),
    end_date: new Date(now).toISOString(),
  };
}

interface AppState {
  // --- Navigation ---
  activeView: ActiveView;
  setActiveView: (view: ActiveView) => void;

  activeTab: string;
  setActiveTab: (tab: string) => void;

  activeProjectTab: ProjectTab;
  setActiveProjectTab: (tab: ProjectTab) => void;

  runtimeSubTab: string;
  setRuntimeSubTab: (tab: string) => void;

  selectedPmProject: string | null;
  selectPmProject: (id: string) => void;

  // --- Detail panel ---
  detailPanel: DetailPanelState;
  openDetail: (index: number) => void;
  closeDetail: () => void;

  // --- Connection ---
  connected: boolean;
  setConnected: (v: boolean) => void;

  // --- Runtime projects (live SDK connections) ---
  projects: ProjectInfo[];
  selectedProject: string | null;
  setProjects: (projects: ProjectInfo[]) => void;
  setSelectedProject: (project: string | null) => void;

  // --- Time range (global header date-range filter) ---
  timeRange: TimeRange;
  setTimeRange: (range: TimeRange) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  activeView: 'home',
  setActiveView: (view) => set({ activeView: view, detailPanel: { open: false, rowIndex: null } }),

  activeTab: 'overview',
  setActiveTab: (tab) => set({ activeTab: tab, detailPanel: { open: false, rowIndex: null } }),

  activeProjectTab: 'sessions',
  setActiveProjectTab: (tab) => set({ activeProjectTab: tab, detailPanel: { open: false, rowIndex: null } }),

  runtimeSubTab: 'overview',
  setRuntimeSubTab: (tab) => set({ runtimeSubTab: tab, detailPanel: { open: false, rowIndex: null } }),

  selectedPmProject: null,
  selectPmProject: (id) => {
    const prev = get().selectedPmProject;
    if (prev !== id) {
      // Clear selectedProject and flush runtime event buffers to prevent data leakage
      set({ selectedProject: null });
      useDataStore.getState().clearAll();
    }
    set({
      selectedPmProject: id,
      activeView: 'project',
      activeProjectTab: 'sessions',
      detailPanel: { open: false, rowIndex: null },
    });
  },

  detailPanel: { open: false, rowIndex: null },
  openDetail: (index) => set({ detailPanel: { open: true, rowIndex: index } }),
  closeDetail: () => set({ detailPanel: { open: false, rowIndex: null } }),

  connected: true,
  setConnected: (v) => set({ connected: v }),

  projects: [],
  selectedProject: null,
  setProjects: (projects) => {
    const current = get().projects;
    // Skip update if project list hasn't meaningfully changed
    if (current.length === projects.length &&
        current.every((p, i) => p.appName === projects[i].appName && p.isConnected === projects[i].isConnected && p.sessions.length === projects[i].sessions.length)) return;
    set({ projects });
  },
  setSelectedProject: (project) => set({ selectedProject: project }),

  // Default to "all time" — a bounded default (e.g. 24h) silently hides issues
  // and events older than the window on load, and with WS connected the single
  // bounded initial fetch is the only read. Users opt into a narrower window via
  // the header picker.
  timeRange: { preset: 'all' },
  setTimeRange: (range) => {
    if (get().timeRange.preset === range.preset && get().timeRange.customSinceSeconds === range.customSinceSeconds) return;
    // NB: we deliberately do NOT clearAll() here. Wiping all six event buffers
    // blanks always-mounted consumers (the notification bell, overview) until
    // each tab is revisited, since only the active tab refetches. Instead the
    // active tab's fetch fully replaces its data with the new window, and
    // useLiveData refetches all event types on a range change (see use-live-data).
    set({ timeRange: range });
  },
}));

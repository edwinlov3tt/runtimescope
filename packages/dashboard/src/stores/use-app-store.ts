import { create } from 'zustand';
import type { ProjectInfo } from '@/lib/api';
import type { ProjectTab } from '@/lib/pm-types';

interface DetailPanelState {
  open: boolean;
  rowIndex: number | null;
}

type ActiveView = 'home' | 'project' | 'runtime';

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
      // Clear selectedProject so runtime data doesn't leak between PM projects
      set({ selectedProject: null });
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
}));

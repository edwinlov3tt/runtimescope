import { create } from 'zustand';
import type { ProjectInfo } from '@/lib/api';

interface DetailPanelState {
  open: boolean;
  rowIndex: number | null;
}

interface AppState {
  activeTab: string;
  setActiveTab: (tab: string) => void;

  detailPanel: DetailPanelState;
  openDetail: (index: number) => void;
  closeDetail: () => void;

  connected: boolean;
  setConnected: (v: boolean) => void;

  projects: ProjectInfo[];
  selectedProject: string | null;
  setProjects: (projects: ProjectInfo[]) => void;
  setSelectedProject: (project: string | null) => void;
}

export const useAppStore = create<AppState>((set) => ({
  activeTab: 'overview',
  setActiveTab: (tab) => set({ activeTab: tab, detailPanel: { open: false, rowIndex: null } }),

  detailPanel: { open: false, rowIndex: null },
  openDetail: (index) => set({ detailPanel: { open: true, rowIndex: index } }),
  closeDetail: () => set({ detailPanel: { open: false, rowIndex: null } }),

  connected: true,
  setConnected: (v) => set({ connected: v }),

  projects: [],
  selectedProject: null,
  setProjects: (projects) => set({ projects }),
  setSelectedProject: (project) => set({ selectedProject: project }),
}));

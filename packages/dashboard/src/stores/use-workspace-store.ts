/**
 * Workspace store — tracks the list of workspaces, the active (selected)
 * workspace for filtering, and API key state for the currently-viewed
 * workspace.
 *
 * The active workspace is persisted in localStorage so it survives reloads.
 * An `allWorkspaces` mode (null activeId) shows projects from every workspace,
 * which is the default for single-workspace users who don't need filtering.
 */

import { create } from 'zustand';
import { toast } from '@/stores/use-toast-store';
import type { PmWorkspace, PmApiKey } from '@/lib/pm-types';
import * as pmApi from '@/lib/pm-api';

const STORAGE_KEY = 'rs.activeWorkspaceId';

function loadActive(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveActive(id: string | null): void {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* private mode — ignore */ }
}

interface WorkspaceState {
  // All workspaces, loaded from the collector
  workspaces: PmWorkspace[];
  workspacesLoading: boolean;

  // Active workspace — null = show all
  activeWorkspaceId: string | null;

  // API keys — keyed by workspace id, lazy-loaded
  apiKeysByWorkspace: Record<string, PmApiKey[]>;
  apiKeysLoading: Record<string, boolean>;

  // Newly-created key — shown once then cleared (never stored long-term)
  newlyCreatedKey: PmApiKey | null;

  // Actions
  fetchWorkspaces: () => Promise<void>;
  setActiveWorkspace: (id: string | null) => void;
  createWorkspace: (input: { name: string; slug?: string; description?: string }) => Promise<PmWorkspace | null>;
  updateWorkspace: (id: string, input: { name?: string; description?: string }) => Promise<void>;
  deleteWorkspace: (id: string) => Promise<void>;
  moveProjectToWorkspace: (projectId: string, workspaceId: string) => Promise<void>;

  fetchApiKeys: (workspaceId: string) => Promise<void>;
  createApiKey: (workspaceId: string, label: string) => Promise<PmApiKey | null>;
  revokeApiKey: (key: string, workspaceId: string) => Promise<void>;
  clearNewlyCreatedKey: () => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  workspacesLoading: false,
  activeWorkspaceId: loadActive(),
  apiKeysByWorkspace: {},
  apiKeysLoading: {},
  newlyCreatedKey: null,

  fetchWorkspaces: async () => {
    set({ workspacesLoading: true });
    const workspaces = await pmApi.fetchWorkspaces();
    set({ workspaces, workspacesLoading: false });

    // If the saved active workspace no longer exists, clear it
    const { activeWorkspaceId } = get();
    if (activeWorkspaceId && !workspaces.find((w) => w.id === activeWorkspaceId)) {
      saveActive(null);
      set({ activeWorkspaceId: null });
    }
  },

  setActiveWorkspace: (id) => {
    saveActive(id);
    set({ activeWorkspaceId: id });
  },

  createWorkspace: async (input) => {
    const ws = await pmApi.createWorkspace(input);
    if (ws) {
      set((s) => ({ workspaces: [...s.workspaces, ws] }));
      toast.success(`Created workspace "${ws.name}"`);
      return ws;
    }
    toast.error('Failed to create workspace');
    return null;
  },

  updateWorkspace: async (id, input) => {
    const updated = await pmApi.updateWorkspace(id, input);
    if (updated) {
      set((s) => ({
        workspaces: s.workspaces.map((w) => (w.id === id ? updated : w)),
      }));
      toast.success(`Workspace updated`);
    } else {
      toast.error('Failed to update workspace');
    }
  },

  deleteWorkspace: async (id) => {
    const ws = get().workspaces.find((w) => w.id === id);
    if (!ws) return;
    if (ws.isDefault) {
      toast.error('Cannot delete the default workspace');
      return;
    }
    const ok = await pmApi.deleteWorkspace(id);
    if (ok) {
      set((s) => ({
        workspaces: s.workspaces.filter((w) => w.id !== id),
        activeWorkspaceId: s.activeWorkspaceId === id ? null : s.activeWorkspaceId,
      }));
      if (get().activeWorkspaceId === null) saveActive(null);
      toast.success(`Deleted workspace "${ws.name}". Its projects moved to the default workspace.`);
    } else {
      toast.error('Failed to delete workspace');
    }
  },

  moveProjectToWorkspace: async (projectId, workspaceId) => {
    const ok = await pmApi.moveProjectToWorkspace(projectId, workspaceId);
    if (ok) {
      toast.success('Project moved');
    } else {
      toast.error('Failed to move project');
    }
  },

  fetchApiKeys: async (workspaceId) => {
    set((s) => ({ apiKeysLoading: { ...s.apiKeysLoading, [workspaceId]: true } }));
    const keys = await pmApi.fetchApiKeys(workspaceId);
    set((s) => ({
      apiKeysByWorkspace: { ...s.apiKeysByWorkspace, [workspaceId]: keys },
      apiKeysLoading: { ...s.apiKeysLoading, [workspaceId]: false },
    }));
  },

  createApiKey: async (workspaceId, label) => {
    const key = await pmApi.createApiKey(workspaceId, label);
    if (key) {
      set((s) => ({
        apiKeysByWorkspace: {
          ...s.apiKeysByWorkspace,
          [workspaceId]: [key, ...(s.apiKeysByWorkspace[workspaceId] ?? [])],
        },
        newlyCreatedKey: key,
      }));
      return key;
    }
    toast.error('Failed to create API key');
    return null;
  },

  revokeApiKey: async (key, workspaceId) => {
    const ok = await pmApi.revokeApiKey(key);
    if (ok) {
      set((s) => ({
        apiKeysByWorkspace: {
          ...s.apiKeysByWorkspace,
          [workspaceId]: (s.apiKeysByWorkspace[workspaceId] ?? []).filter((k) => k.key !== key),
        },
      }));
      toast.success('API key revoked');
    } else {
      toast.error('Failed to revoke API key');
    }
  },

  clearNewlyCreatedKey: () => set({ newlyCreatedKey: null }),
}));

/**
 * Hidden-projects store. Lets the user hide PM projects from the header project
 * dropdown (e.g. archived or noisy projects). The set of hidden project ids is
 * persisted per-browser in localStorage so it survives reloads.
 */

import { create } from 'zustand';

const KEY = 'rs.hiddenProjects';

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.filter((x) => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function save(value: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(Array.from(value)));
  } catch { /* private mode — ignore */ }
}

interface HiddenProjectsState {
  hiddenIds: Set<string>;
  /** Hide or unhide a project by id. */
  toggleHidden: (id: string) => void;
}

export const useHiddenProjects = create<HiddenProjectsState>((set, get) => ({
  hiddenIds: load(),
  toggleHidden: (id) => {
    const next = new Set(get().hiddenIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    save(next);
    set({ hiddenIds: next });
  },
}));

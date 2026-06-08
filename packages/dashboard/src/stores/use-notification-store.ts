/**
 * Notification read-state store.
 *
 * The notification bell derives its items from the live event store via the
 * same `detectIssues()` the Issues page uses (see notification-dropdown.tsx).
 * Detected issues are ephemeral and have no inherent "read" or "first seen"
 * concept, so this store layers two pieces of durable, per-browser state on top
 * of them, keyed by the issue's stable `id`:
 *
 *   - `readIds`   — which alerts the user has dismissed/read.
 *   - `firstSeen` — the wall-clock time each alert id was first observed, so the
 *                   bell can show a real "5m ago" timestamp instead of faking it.
 *
 * Both are persisted to localStorage so read-state and timestamps survive a
 * reload. State is per-browser (the spec's accepted minimum) — there is no
 * collector-side sync. To keep localStorage from growing without bound on a
 * noisy stream, both maps are pruned to the most-recent ids on every write.
 */

import { create } from 'zustand';

const READ_KEY = 'rs.notif.readIds';
const SEEN_KEY = 'rs.notif.firstSeen';
// Cap how many ids we retain so a noisy stream can't grow localStorage forever.
const MAX_TRACKED = 500;

function loadSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? new Set(arr.filter((x) => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function loadSeen(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function saveSet(key: string, value: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify(Array.from(value)));
  } catch { /* private mode — ignore */ }
}

function saveSeen(value: Record<string, number>): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(value));
  } catch { /* private mode — ignore */ }
}

/** Keep only the `MAX_TRACKED` most-recently-seen ids across both maps. */
function prune(
  readIds: Set<string>,
  firstSeen: Record<string, number>,
): { readIds: Set<string>; firstSeen: Record<string, number> } {
  const ids = Object.keys(firstSeen);
  if (ids.length <= MAX_TRACKED) return { readIds, firstSeen };
  const keep = new Set(
    ids.sort((a, b) => firstSeen[b] - firstSeen[a]).slice(0, MAX_TRACKED),
  );
  const nextSeen: Record<string, number> = {};
  for (const id of keep) nextSeen[id] = firstSeen[id];
  const nextRead = new Set(Array.from(readIds).filter((id) => keep.has(id)));
  return { readIds: nextRead, firstSeen: nextSeen };
}

interface NotificationState {
  readIds: Set<string>;
  firstSeen: Record<string, number>;

  /**
   * Reconcile durable state against the current set of active alert ids:
   * stamp first-seen for new ids, and drop read-state for ids no longer active
   * (their condition cleared) so a later recurrence alerts again. Idempotent.
   */
  observe: (activeIds: string[]) => void;
  /** Mark a single alert read. */
  markRead: (id: string) => void;
  /** Mark every currently-visible alert read. */
  markAllRead: (ids: string[]) => void;
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  readIds: loadSet(READ_KEY),
  firstSeen: loadSeen(),

  observe: (activeIds) => {
    const { firstSeen, readIds } = get();
    const active = new Set(activeIds);
    const now = Date.now();

    // Stamp first-seen for newly-detected ids.
    const nextSeen = { ...firstSeen };
    let changed = false;
    for (const id of activeIds) {
      if (nextSeen[id] === undefined) {
        nextSeen[id] = now;
        changed = true;
      }
    }

    // Forget read-state for alerts whose condition has CLEARED (id no longer in
    // the active detection set). Detector ids are stable, so without this a
    // recurrence after the user marked an alert read would stay silenced forever.
    let nextRead = readIds;
    if (readIds.size > 0) {
      const filtered = new Set(Array.from(readIds).filter((id) => active.has(id)));
      if (filtered.size !== readIds.size) {
        nextRead = filtered;
        changed = true;
      }
    }

    if (!changed) return;
    const pruned = prune(nextRead, nextSeen);
    saveSeen(pruned.firstSeen);
    if (pruned.readIds !== readIds) saveSet(READ_KEY, pruned.readIds);
    set({ firstSeen: pruned.firstSeen, readIds: pruned.readIds });
  },

  markRead: (id) => {
    const next = new Set(get().readIds);
    if (next.has(id)) return;
    next.add(id);
    saveSet(READ_KEY, next);
    set({ readIds: next });
  },

  markAllRead: (ids) => {
    const next = new Set(get().readIds);
    let changed = false;
    for (const id of ids) {
      if (!next.has(id)) {
        next.add(id);
        changed = true;
      }
    }
    if (!changed) return;
    saveSet(READ_KEY, next);
    set({ readIds: next });
  },
}));

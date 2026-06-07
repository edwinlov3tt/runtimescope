# Dashboard data-layer wiring map

**Branch:** `integration/dashboard-chrome`. **Purpose:** a reference for the data
flow of the dashboard chrome features (⌘K command palette, header date-range
filter, notification persistence) so changes don't leave a component *rendered
but not wired* (a dead control) or *wired but not rendered* (a dead module).

Two checks per component: **Mounted** (rendered somewhere in the tree) and
**Wired** (reads real data + every write reaches a real sink).

## Feature components

| Component | Mounted by | Reads (source) | Writes (sink) | Verdict |
|---|---|---|---|---|
| `NotificationDropdown` | `components/layout/header.tsx` | `useDataStore` ×6 event arrays → `detectIssues`; `useNotificationStore` (`readIds`, `firstSeen`); `useAppStore` (`selectedProject`, `selectedPmProject`); `usePmStore.projects` (badge name) | `useNotificationStore` (`observe`/`markRead`/`markAllRead`); `useAppStore` nav via `viewAll()` | ✅ wired |
| `CommandPalette` | `components/layout/header.tsx` (open state from `useCommandPalette`) | rail constants `HOME/RUNTIME_RAIL_ITEMS/BOTTOM` (`rail.tsx`); `usePmStore.projects`; `useWorkspaceStore.activeWorkspaceId`; `useDataStore.network/console` (recent activity) | `useAppStore` nav (`setActiveView`/`setActiveTab`/`setActiveProjectTab`/`setRuntimeSubTab`/`selectPmProject`) | ✅ wired |
| `DateRangePicker` | `components/layout/header.tsx` | `useAppStore.timeRange`; `TIME_RANGE_LABELS`/`TIME_RANGE_PILL_LABELS` | `useAppStore.setTimeRange` | ✅ wired |
| `useCommandPalette` (hook) | `components/layout/header.tsx` | local `open` + global ⌘K/Ctrl+K keydown | toggles `open` → `<CommandPalette>` + header search trigger | ✅ wired |

## Stores / slices (checked for half-wiring)

| Slice / store | Written by | Read by | Verdict |
|---|---|---|---|
| `useNotificationStore` (`readIds: Set`, `firstSeen: Record`; persisted to `localStorage` keys `rs.notif.readIds` / `rs.notif.firstSeen`) | `NotificationDropdown` (`observe`/`markRead`/`markAllRead`) | `NotificationDropdown` (badge count, per-row read state + timestamp) | ✅ both sides present |
| `useAppStore.timeRange` (`{ preset }`) | `DateRangePicker` (`setTimeRange`) | `use-live-data` (`getEventFilter` → `since_seconds`; refetch-all effect + prune effect), `events-page`, `date-range-picker` | ✅ both sides present |
| `timeRangeToSinceSeconds(range)` helper | — | `use-live-data`, `events-page` | ✅ consumed |
| `useAppStore.focusedEventId` (`string \| null`) | `CommandPalette` (sets on event-result select); `network-page`/`console-page` (clear after flash) | `network-page`/`console-page` (scroll-to + transient highlight) | ✅ both sides present |
| `useDataStore.pruneOlderThan(cutoffMs)` action | — | `use-live-data` prune effect (evicts events aged past the window) | ✅ consumed |
| `useDetectedIssues()` shared hook (module-memoized `detectIssues`) | — | `NotificationDropdown`, `overview-page`, `issues-page` (replaces 3 inline copies) | ✅ consumed |
| `useHiddenProjects` (`hiddenIds: Set`; persisted `localStorage` key `rs.hiddenProjects`) | `header.tsx` project dropdown (`toggleHidden` per-row eye button) | `header.tsx` project dropdown (filters hidden rows; "Show hidden" toggle) | ✅ both sides present |
| `useAppStore.restoreNav(nav)` action | `use-url-sync` (URL → state on load/popstate) | — (it's a setter) | ✅ consumed |

## URL deep-linking

`hooks/use-url-sync.ts` (mounted in `App.tsx`) is the two-way bridge between nav
state and the URL query string, so refresh restores the page and back/forward
work. Scheme: `?view=home` · `?view=runtime&tab=<id>` · `?view=settings` ·
`?view=project&project=<id>&ptab=<tab>[&sub=<runtime sub-tab>]`. Writes only
`pushState` when the URL changes (applying a URL no-ops), and hydrates via the
side-effect-free `restoreNav` store action.

**Removed because orphaned** (review finding #15): `timeRangeToDates()` (zero call
sites) and the `'custom'` preset + `customSinceSeconds` field (unreachable — the
picker never sets it).

## Shared plumbing

- `hooks/use-live-data.ts`: reads `timeRange` → `since_seconds` on every event
  fetch (`getEventFilter`); a dedicated effect refetches **all six** event types
  on a range change so always-mounted consumers (notification bell, overview)
  reflect the new window without being blanked. `setTimeRange` deliberately does
  **not** `clearAll()` the buffers (that previously blanked the bell). A second
  effect prunes the store buffers (`pruneOlderThan`) every 5s while a bounded
  window is active, so live WS appends don't let the buffer drift wider than the
  selected window (no-op for `'all'`).
- `hooks/use-detected-issues.ts`: the single source of truth for derived issues —
  the bell, overview, and issues page all call `useDetectedIssues()`, which
  computes `detectIssues()` once per event change (module-memoized on the six
  array references) instead of three independent recomputes.

## The live contract (what not to break)

If you touch the header or these stores, these are the load-bearing wires:

- `useAppStore.timeRange` / `setTimeRange` — the global window. New consumers
  must resolve it with `timeRangeToSinceSeconds` (event reads) — don't hardcode a
  window. Default is `'all'` (unbounded); a bounded default silently hides older
  data on load.
- Rail item constants in `components/layout/rail.tsx` — the command palette
  enumerates them, so a new rail item appears in ⌘K automatically.
- `useNotificationStore` — the bell's durable read-state. Detector ids are
  stable, so read-state is reconciled against the live detection set (a cleared
  issue's read-state is dropped so a recurrence re-alerts).
- `useDataStore`'s six event arrays — the bell, overview, and issues page all
  derive from them via `detectIssues`; they update live via the WS feed
  (`ws-client.ts` → `appendEvent`).

## Formerly-dead chrome — now wired by this branch

All header controls now have real behavior:

- ⌘K search box → `CommandPalette`; "Today, Apr 6" pill → `DateRangePicker`;
  fabricated notification bell → real `detectIssues` output.
- Project dropdown **"Show hidden"** → toggles `useHiddenProjects` visibility;
  per-row eye button hides/unhides; **"Full view"** → Home projects list.
- **Avatar** → `AvatarMenu` (workspace-derived label + Settings link); the
  hardcoded "Edwin L. / Admin" is gone.

No known dead (rendered-but-unwired) controls remain in the dashboard chrome.

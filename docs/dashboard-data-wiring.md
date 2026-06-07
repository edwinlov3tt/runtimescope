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
| `useAppStore.timeRange` (`{ preset }`) | `DateRangePicker` (`setTimeRange`) | `use-live-data` (`getEventFilter` → `since_seconds`; refetch-all effect), `events-page`, `date-range-picker` | ✅ both sides present |
| `timeRangeToSinceSeconds(range)` helper | — | `use-live-data`, `events-page` | ✅ consumed |

**Removed because orphaned** (review finding #15): `timeRangeToDates()` (zero call
sites) and the `'custom'` preset + `customSinceSeconds` field (unreachable — the
picker never sets it).

## Shared plumbing

- `hooks/use-live-data.ts`: reads `timeRange` → `since_seconds` on every event
  fetch (`getEventFilter`); a dedicated effect refetches **all six** event types
  on a range change so always-mounted consumers (notification bell, overview)
  reflect the new window without being blanked. `setTimeRange` deliberately does
  **not** `clearAll()` the buffers (that previously blanked the bell).

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

## Known still-dead chrome (pre-existing, out of scope for this branch)

Rendered but no handler (audit 0004, Category 4) — *not* introduced here:

- `header.tsx` project dropdown footer: **"Show hidden"** and **"Full view"** (no `onClick`).
- `header.tsx` **avatar / "Edwin L."** block (`cursor-pointer`, no menu).

Three former orphans are now wired by this branch: the ⌘K search box →
`CommandPalette`, the "Today, Apr 6" pill → `DateRangePicker`, the fabricated
notification bell → real `detectIssues` output.

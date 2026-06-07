# 0004 — Dashboard ⇄ Rust-collector drift audit

**Date:** 2026-06-02
**Scope:** `packages/dashboard/` (React/Vite SPA) audited against `crates/collector-core/src/server.rs` + `store.rs` and `crates/mcp-server/src/tools/`.
**Method:** static read of the dashboard's API/WS layer + the collector's route table and broadcast sites, then **live differential probing** against a running collector on `:6768` (v0.11.4) with the playground generating real events. Every claim cites `file:line` + evidence. Read-only audit — no app behavior changed.
**Detector:** `scripts/detect-ui-drift.mjs` (added) reproduces findings #1, #3, #6 automatically and gates CI. See [How to run the detector](#how-to-run-the-detector).

---

## TL;DR — ranked by user impact

| # | Severity | One-liner | Owner |
|---|----------|-----------|-------|
| 1 | **HIGH** | Live event filter keys off `data.projectId`, which the collector never puts on the wire → live updates silently break whenever a project is selected (the "console needs manual refresh" report) | Collector (+ dashboard hardening) |
| 2 | **MEDIUM-HIGH** | Dev-server status & logs never stream: `dev_server_status`/`dev_server_log` WS handlers are dead — collector never broadcasts them | Collector |
| 3 | **MEDIUM** | `clearEvents()` calls `DELETE /api/events` which returns **405** (route is POST-only); the function is also never called from any UI | Dashboard (dead) / Collector (route) |
| 4 | **MEDIUM** | Overview page shows a hardcoded SDK version `v0.9.3` (actual SDK is 0.11.4) | Dashboard |
| 5 | **LOW-MED** | `processes` page reads store arrays that nothing refreshes while WS is connected → frozen after first load | Dashboard |
| 6 | **LOW** | Read-API silently ignores 7 filter params the dashboard sends (`metric`, `table`, `min_duration_ms`, `store_id`, `component`, `name`, `action`) | Collector (or drop on dashboard) |
| 7 | **LOW** | Infra page is a hardcoded static placeholder (`PLATFORMS` constant); no endpoint exists | Collector (feature gap) |
| 8 | **LOW** | Database "Performance" tab renders a search box wired to a no-op | Dashboard |
| 9 | **LOW** | `SessionBar` fallback renders fake `a06af01e` / `v0.9.3` / `0m 0s` if `items` ever omitted (latent) | Dashboard |
| 10 | **MEDIUM** | Notification bell renders 7 fabricated alerts (`SAMPLE_NOTIFICATIONS`) + fake unread badge — see [Category 4](#category-4--dead--cosmetic-controls-clickable-but-inert--hardcoded-chrome) | Dashboard |
| 11 | **MEDIUM** | Tasks "Files" tab + composer + Open/Add-to-Board buttons are dead (hardcoded empty, no handlers) | Dashboard |
| 12 | **LOW-MED** | Header chrome mostly inert: "Full view", "Show hidden", `⌘K` search, "Today, Apr 6" date, avatar — all no-op/hardcoded | Dashboard |
| — | info | KitchenSink showcase is full of mock data but unreachable from real nav | (none) |

> **Categories 1–3** (below) are wire-protocol / data drift. **[Category 4](#category-4--dead--cosmetic-controls-clickable-but-inert--hardcoded-chrome)** is the full catalog of dead buttons, no-op handlers, and hardcoded chrome (findings 10–12 + more).

**Live-data verdict summary:** 10 data pages are correctly live (console, network, renders, performance, state, database, breadcrumbs, issues, overview, api-map — all read the WS-fed `useDataStore`). 2 self-poll (sessions 3s, events 5s) — correct, since their data isn't an `appendEvent` event type. The real gaps are **finding #1** (live filter drops events) and **#5** (processes) and **#2** (dev-server).

---

## Category 3 — Mis-wired / shape drift

### 1. HIGH — Live event filter reads `data.projectId`, which is never on the wire

**Evidence (dashboard):** `packages/dashboard/src/lib/ws-client.ts:82-89`
```ts
const eventProjectId = msg.data.projectId;
if (project.projectId && eventProjectId) {
  if (eventProjectId !== project.projectId) return;
} else if (!project.sessions.includes(msg.data.sessionId)) {
  return;                       // <-- the only path that ever runs
}
useDataStore.getState().appendEvent(msg.data);
```
The code comment at `:83` calls projectId the "reliable" match path.

**Evidence (collector):** broadcast events carry **no `projectId`**. The store emits `{ "type": "event", "data": ev }` where `ev` is the raw stored event (`crates/collector-core/src/store.rs:314`). Stored events have no projectId column/field.

**Live proof:** sampled **54 WS frames** over 35s (all event types) and **0/54 carried `projectId`** — `hasProjectId:false` for `ui, console, custom, render, network, performance`. Raw `/api/events/console` event keys: `args,eventId,eventType,level,message,sessionId,sourceFile,stackTrace,timestamp`. (`scripts/detect-ui-drift.mjs --live` re-confirms: "0/N live event frames carried a projectId field".)

**Consequence — this is the reported "console needs a manual refresh" bug.** Because `eventProjectId` is always `undefined`, the `if (project.projectId && eventProjectId)` branch is dead and filtering **always** falls to `project.sessions.includes(msg.data.sessionId)`. `project.sessions` is a snapshot from the last `/api/projects` poll (every 5s — `App.tsx:69`). When a project is selected (manually, or auto-selected when exactly one app is connected — `App.tsx:58-62`), any live event whose `sessionId` isn't yet in that polled list is **dropped** — most visibly for the high-frequency console stream and for freshly-reloaded browser sessions. A manual refresh / tab switch hides it because that re-runs the one-shot REST fetch (`use-live-data.ts:179`) which is **server-side** filtered by `project_id` and returns everything.

Note: this is NOT console-specific in the code — all event types pass through the same filter (`ws-client.ts:90`). Console is just where users notice first (highest volume, always-on).

**Verdict / fix:**
- **Primary — COLLECTOR:** attach `projectId` to the broadcast payload at `store.rs:314`, e.g. `json!({ "type": "event", "data": ev, "projectId": project })` (or inject it into `ev`). The project scoping key is in scope in `add_batch`. This restores the dashboard's documented "reliable" path. The session registry already knows each session's `project_id` (`store.rs:register_session`), and `/api/projects` + `session_connected` frames already carry it — only the per-event broadcast omits it.
- **Secondary — DASHBOARD hardening:** when `eventProjectId` is absent, resolve the event's project via a `sessionId → projectId` map built from the `projects` list instead of the stale `sessions.includes` membership test, so a not-yet-polled session isn't dropped.

---

### 3. MEDIUM — `DELETE /api/events` → 405; `clearEvents()` is also dead code

**Evidence (dashboard):** `packages/dashboard/src/lib/api.ts:232-238`
```ts
export async function clearEvents(): Promise<boolean> {
  const res = await fetch(`${BASE}/api/events`, { method: 'DELETE' });
  return res.ok;
}
```
**Evidence (collector):** `crates/collector-core/src/server.rs:164` registers `/api/events` with **`post(post_events)` only** — no DELETE handler.
**Live proof:** `curl -X DELETE http://localhost:6768/api/events` → **HTTP 405**.

**Double defect:** `clearEvents` is also **never imported anywhere** (grep: only its own definition). The dashboard's "clear" actions use the local-store `useDataStore.clearAll()` (`use-app-store.ts:65`, `runtime-page.tsx:212`), which wipes the client array only. So today nothing breaks visibly — but the function is a loaded gun: any UI wiring a "Clear server events" button to it would silently 405.

**Verdict / fix:** either delete `clearEvents` (dead) **or**, if a server-side clear is intended, add `.delete(delete_events)` to the `/api/events` route. Pick one; don't leave a 405-returning helper exported.

---

### 6. LOW — Read-API silently ignores 7 filter params the dashboard sends

**Evidence (dashboard sends them):** `api.ts` — `fetchPerformanceEvents({metric})` `:143`, `fetchDatabaseEvents({table,min_duration_ms})` `:152`, `fetchStateEvents({store_id})` `:125`, `fetchRenderEvents({component})` `:134`, `fetchCustomEvents({name})` `:163`, `fetchUIEvents({action})` `:172`.
**Evidence (collector ignores them):** `server.rs:482-508` `apply_filters` handles only `since_seconds, method, url_pattern, level, search, session_id`. The other params hit no branch and are dropped.

**Impact:** low — every page re-filters client-side (e.g. `console-page.tsx:146-154`, `database-page.tsx`), so results are still correct; only the over-fetch is wasted. But it's latent drift: a future caller trusting `?min_duration_ms=` server-side would silently get unfiltered data. **Fix:** drop the unused params from the API helpers, or implement them in `apply_filters`. (The `status`/network case is intentionally excluded per the conformance comment at `server.rs:480` — leave it.)

---

## Category 2 — Not wired up

### 2. MEDIUM-HIGH — Dev-server status & logs never stream live

**Evidence (dashboard is fully wired for it):**
- `ws-client.ts:62-66` routes `dev_server_status` / `dev_server_log` frames to `devServerHandler`.
- `App.tsx:41-48` installs that handler → `useDevServerStore.setStatus / appendLog`.
- `runtime-page.tsx:88-132` `DevServerLogPanel` renders `devState.logs`; `:219-222` comment: *"Only hydrate if we don't already have data from WS"* — the author **expected** WS log streaming.

**Evidence (collector never broadcasts it):** the only three broadcast sites are `store.rs:314` (`event`), `:372` (`session_connected`), `:381` (`session_disconnected`). The dev-server monitor `spawn_dev_monitor` (`server.rs:~2001`) only calls `pm.dev_server_update_status(...)` (`:2042`, writes pm.db) and has **no access to the broadcast channel**.
**Live proof:** 0 `dev_server_*` frames in 35s of sampling; `detect-ui-drift.mjs` reports both types as "handled by dashboard but NEVER broadcast by collector."

**Consequence:** `ws-client.ts:62-66` and `App.tsx:41-48` are **dead code**. Dev-server logs populate only from the one-shot `fetchDevServerStatus` on mount (`runtime-page.tsx:224-235`) — new stdout/stderr after mount never appears; a crash/stop after mount isn't reflected until a manual refresh.

**Verdict / fix — COLLECTOR:** give `spawn_dev_monitor` the `store` (or the `events_tx` broadcast sender) and emit `{type:"dev_server_status",projectId,status,pid,port}` on transitions and `{type:"dev_server_log",projectId,stream,line,ts}` per output line. The dashboard side already consumes both shapes correctly — no dashboard change needed once the frames arrive.

### 5. LOW-MED — `processes` page frozen after first load

**Evidence:** `processes-page.tsx:13-14` reads `useDataStore.processes` / `.ports`. These arrays are **not** updated by `appendEvent` (no `process`/`port` case — `use-data-store.ts:119 default`). They are set only by the `processes` fetcher in `use-live-data.ts:115-120`, which runs once on tab entry (`:179`) and then **only polls when WS is disconnected** (`:182 if (!connected)`). With WS connected (the normal case), the list never refreshes.
**Verdict / fix — DASHBOARD:** processes/ports are HTTP-poll-only (the collector can't broadcast them as events). The page should run its own interval poll (like `sessions-page` 3s / `events-page` 5s) instead of depending on the WS-gated `useLiveData`.

### 8. LOW — Dead search box on Database "Performance" tab

**Evidence:** `database-page.tsx:409` `<FilterBar search="" onSearchChange={() => {}} searchPlaceholder="">`. `FilterBar` unconditionally renders a `SearchInput` (`filter-bar.tsx:35-41`), so users see a search field whose handler is a no-op and whose value is pinned to `""`. **Fix:** give FilterBar a `showSearch={false}` mode, or remove the misuse.

---

## Category 1 — Mock / hardcoded data

### 4. MEDIUM — Stale hardcoded SDK version on the live Overview page

**Evidence:** `overview-page.tsx:47` `{ icon: Package, label: 'SDK', value: 'v0.9.3' }` — rendered in the live `<SessionBar>`. Actual SDK is 0.11.4. Real session data already carries `sdkVersion` (`sessions-page.tsx:154,187`); Overview ignores it and shows a frozen literal that drifts every release. **Fix:** source from session/health data or drop the row.

### 9. LOW — `SessionBar` fake fallback (latent)

**Evidence:** `session-bar.tsx:19-24` `items ?? [{…value:'a06af01e'},{…'v0.9.3'},{…'0m 0s'},{…'0'}]`. The only caller (`overview-page.tsx:43`) always passes `items`, so it never renders today — but a future caller omitting `items` would silently show fabricated session/SDK/uptime values. **Fix:** default to an empty/"—" state, not fake values.

### info — KitchenSink showcase (mock data, unreachable)

`components/showcase/kitchen-sink.tsx:6-89` holds `MOCK_REQUESTS` and hardcoded metrics (`'1,247'`, `'145'`, …) and mock `/api/campaigns`, `/api/invalid` URLs. It renders only when `activeTab === 'showcase'` (`page-router.tsx:67`), and **nothing ever sets that tab** (no nav/rail/sidebar writer). Real but dev-only/unreachable — excluded from the drift detector via `SKIP_DIRS`. No user impact; consider deleting to avoid future leakage.

---

## Verified NON-issues (false positives considered)

- **`source: 'mock'`** (`use-data-store.ts:67`) — a misnamed "collector-offline" sentinel; only ever flipped to `'live'` (`App.tsx:37`) and read once to show the real `<CollectorOffline>` screen (`page-router.tsx:62`). No mock-data generator exists in the repo.
- **Settings page** — workspace/API-key CRUD all call real `useWorkspaceStore` → `pm-api`. Wired.
- **Export buttons** (`export-button.tsx`, `lib/export.ts`) — real Blob download. Wired.
- **`Math.random()`** (`ws-client.ts:109`) — reconnect-backoff jitter. Legitimate.
- **Live pages** console/network/renders/performance/state/database/breadcrumbs/issues/overview/api-map — all read the WS-fed `useDataStore` and update live (the WS pipeline delivers `event` frames correctly; verified 12 console + 8 network + others over WS). Their only live risk is **finding #1**.
- **`/api/processes`, `/api/ports`** — served (`server.rs:192-193`); note collector-server returns these empty in standalone mode (comment `server.rs:~192`), populated under mcp-server. Not a drift, an env difference.
- **`served-but-uncalled` routes** — none surprising; `/api/events` (POST ingest) and admin/health probes are allowlisted as non-dashboard consumers.

---

## Category 4 — Dead & cosmetic controls (clickable-but-inert / hardcoded chrome)

A second pass found a cluster of interactive-looking controls that do nothing, and hardcoded values rendered as if live. None are wire-protocol drift, but all are user-facing "this lies / this is dead." Checks [5]–[7] of the detector catch the machine-detectable subset; the decorative `<div>` chrome (items marked † below) is documented here but not auto-detected (it's `cursor-pointer` divs without `onClick`, too false-positive-prone to gate on).

### Dead buttons — click does nothing (no handler)

| Severity | Control | Location | Evidence |
|----------|---------|----------|----------|
| MEDIUM | Tasks **"Files" tab** is a permanent dead-end | `pages/pm/tasks-page.tsx:207` | `const [files] = useState<ClaudeFile[]>([])` — never populated; tab (reachable via `:467`) always renders the empty state; preview pane shows literal `"File preview will render markdown content from …"` (`:355`) |
| MEDIUM | Tasks **"Quick draft composer"** input + Sparkles submit (×2) | `tasks-page.tsx:231-238`, `:321-328` | `<input placeholder="Quick idea or task..."/>` + `<Button><Sparkles/></Button>` — no `onChange`/`onClick`/state. "Claude will create a structured .md file" — does nothing |
| MEDIUM | Tasks file **"Open"** / **"Add to Board"** | `tasks-page.tsx:347, :350` | both `<button>` have no `onClick` |
| LOW | Notification **"View All Notifications"** | `components/layout/notification-dropdown.tsx:147` | `<button>` no `onClick` |
| LOW | Header **"Full view"** (project dropdown footer) | `components/layout/header.tsx:101-103` | no `onClick` — *user-reported* |
| LOW | Header **"Show hidden"** (project dropdown footer) | `header.tsx:98-100` | no `onClick` |
| LOW † | Header **global search box + `⌘K`** | `header.tsx:180-186` | styled `<div>`, no input/handler; **no `⌘K` listener exists** — `hooks/use-keyboard-nav.ts:35`'s `'k'` is vim list-up nav, unrelated. Decorative |
| LOW † | Header **avatar / "Edwin L." / "Admin"** | `header.tsx:199-205` | `cursor-pointer`, no menu/`onClick` |

### No-op handlers

| Severity | Control | Location | Evidence |
|----------|---------|----------|----------|
| LOW | Database **"Performance" tab search box** | `pages/database/database-page.tsx:409` | `<FilterBar onSearchChange={() => {}}>` — `FilterBar` always renders a `SearchInput` (`filter-bar.tsx:35-41`), so typing does nothing |

### Hardcoded data shown as if live

| Severity | What | Location | Reality |
|----------|------|----------|---------|
| MEDIUM | **Notification bell = 7 fabricated alerts** + fake "4 unread" badge | `notification-dropdown.tsx:38-46, :54` | `SAMPLE_NOTIFICATIONS` references projects that don't exist (`flowAI`, `gtm-helper`, `personal-site`, `runtime-profiler`); comment admits *"in production these come from the event store."* "Mark all read"/per-item read work but only mutate the fake array |
| MEDIUM | **"Today, Apr 6"** date pill | `header.tsx:190-193` | hardcoded literal, no picker, no state — *user-reported* (also stale: the audit date is Jun 2 2026) |
| MEDIUM | **Infra "Platform Connections"** always "0/3 connected" | `pages/infra/infra-page.tsx:21-36, :49-53` | every platform `configured: false` hardcoded; `useEffect` re-sets the same constant (`// platforms are all unconfigured in standalone mode`). Self-labeled "MCP Server Only", so partially honest |
| MEDIUM | Overview **SDK `v0.9.3`** | `pages/overview/overview-page.tsx:47` | actual SDK 0.11.4; real `sdkVersion` exists in session data but is ignored |
| LOW | Hardcoded user name **"Edwin"/"Edwin L."/"Admin"** | `header.tsx:202`, `pages/pm/home-page.tsx:395` | greeting is computed live but the name is a literal |
| LOW | `SessionBar` fake fallback (`a06af01e`/`v0.9.3`/`0m 0s`) | `components/ui/session-bar.tsx:19-24` | latent — only renders if a caller omits `items` (current sole caller always passes it) |
| LOW | Memory page placeholder path `~/.claude/projects/.../memory/` | `pages/pm/memory-page.tsx:156` | cosmetic — real file ops use the real key |

### UX dead-end (not strictly broken)

- **Workspace picker "New workspace"** (`components/layout/workspace-picker.tsx:95`) calls `setActiveView('settings')` — it does *not* open a create form, and the picker only renders when `workspaces.length > 1` (`:35`). So clicking it (a) is invisible to single-workspace installs and (b) just lands on Settings with no create form open → reads as "nothing happens." The working create flow is Settings → **"New"** (`settings-page.tsx:119`, wired to `createWorkspace`). Fix: have the picker open the create form directly, or relabel.

**Highest impact:** the Tasks "Files" tab (whole reachable sub-view, dead) and the notification bell (fabricated alerts that look like real incidents).

---

## How to run the detector

`scripts/detect-ui-drift.mjs` — zero-dependency Node ESM (uses the repo's `ws` for the optional live probe).

```bash
# Static checks only (no collector needed) — safe for CI:
node scripts/detect-ui-drift.mjs

# + live shape probe against a running collector (samples real WS frames):
node scripts/detect-ui-drift.mjs --live
node scripts/detect-ui-drift.mjs --live --url http://localhost:6768

# Machine-readable:
node scripts/detect-ui-drift.mjs --json
```

**What it checks & catches (exits non-zero on any blocking drift):**
1. **HTTP path drift** — every `/api/...` the dashboard calls (parsed from all of `packages/dashboard/src`, method-aware) vs every `.route(...)` the collector registers (`server.rs`). Reports *called-but-unserved* and (informational) *served-but-uncalled*. → catches a path the collector doesn't serve.
2. **HTTP method drift** — path served but not the method. → catches **finding #3** (`DELETE /api/events` served only as POST).
3. **WS type drift** — `msg.type` values handled in `ws-client.ts` vs `"type":"…"` frames broadcast in `store.rs`/`server.rs`. → catches **finding #2** (`dev_server_status`/`dev_server_log` handled-but-never-broadcast).
4. **No-op handlers** `[5]` — inline `on*={() => {}}` / `={() => undefined}` in shipped components. → catches the Database performance-tab search.
5. **Mock-data constants** `[6]` — `const SAMPLE_/MOCK_/FAKE_/DUMMY_/PLACEHOLDER_…` declared outside the dev-only `components/showcase/`. → catches `SAMPLE_NOTIFICATIONS`.
6. **Dead controls** `[7]`, *non-blocking warning* — `<button>`/`<Button>` whose (brace-aware, multi-line) opening tag carries no `on*` handler, `type=submit`, `{...spread}`, `asChild`, or `href`. → catches Full view / Show hidden / View All / the Tasks composer + Open / Add to Board buttons. Reported as warnings (not gated) because it's a heuristic; the current run has 0 false positives across 114 buttons. Decorative `<div>` chrome (`⌘K` box, date pill, avatar) is **not** covered — too false-positive-prone to gate.
7. **`--live` shape probe** `[8]` — samples `/api/ws/events`, asserts the fields `ws-client.ts` reads off `msg.data` (`projectId`, `sessionId`) are actually present. → catches **finding #1** (0/N frames carry `projectId`). Degrades to a non-blocking "skip" if the collector is down or the app is idle (no frames in 12s).

**Blocking** = HTTP path/method drift + WS handled-but-unbroadcast + no-op handlers + mock constants + (`--live`) projectId drift. Dead-control warnings do not affect the exit code.

Current run output (static): **5 blocking findings** — `DELETE /api/events`, `dev_server_status`, `dev_server_log`, the Database no-op search, and `SAMPLE_NOTIFICATIONS` — plus 7 dead-control warnings. With `--live` against an active app it adds the `projectId` drift. Wire `node scripts/detect-ui-drift.mjs` into CI to fail the build when the dashboard and collector diverge again.

# Changelog

All notable changes documented here.

## [0.7.2] - 2026-03-20

### Added
- **Dashboard P0–P2 hardening** — comprehensive stability and UX improvements:
  - React `ErrorBoundary` wrapping the entire app — catches render crashes with a "Try Again" recovery button
  - `ConnectionBanner` — amber warning bar shown when WebSocket disconnects, auto-hides on reconnect
  - Toast notification system (`use-toast-store` + `ToastContainer`) — success/error/info toasts on all PM mutations (task CRUD, note CRUD, memory save, rule save, git commit)
  - Export buttons (JSON/CSV) on Network, Console, and Database runtime pages
  - Loading skeleton components (`Skeleton`, `TableSkeleton`, `ListSkeleton`, `CardsSkeleton`) shown during initial data load
  - `ExportButton` dropdown component with proper CSV escaping
- **Stability hardening (items 1–10)**:
  - MCP tool response size limits (default 200, hard max 1000 events) with `truncated` flag
  - Dirty-flag caching for API Discovery engine — skips rebuild when no new events
  - Playwright scanner semaphore — limits concurrent browser contexts to 2
  - SQLite corruption recovery — detects corrupt DB on open, renames and recreates fresh
  - SQLite snapshot retention — max 50 per session with oldest-eviction pruning
- **Production readiness (Level 1)**:
  - Browser SDK sampling — `sampleRate` (probabilistic) and `maxEventsPerSecond` (rate limiter), matching server SDK API. Session and custom events bypass sampling.
  - User context — `RuntimeScope.setUser({ id, email, name })` attaches identity to all events. `setUser(null)` clears on logout. Included in session events.
  - `UserContext` type added to both SDK and collector type systems
- **Route-based code splitting** — `React.lazy()` + `Suspense` on all 20+ page components in `page-router.tsx` and `project-view.tsx`. Main bundle: 803KB → 280KB (65% reduction).

### Changed
- Smart polling in `use-live-data` — skips interval polling when WebSocket is connected (events stream real-time), falls back to 2s polling only on WS disconnect
- Runtime data buffers flush on PM project switch to prevent data leakage between projects
- `initialLoadDone` flag added to data store for skeleton display coordination
- `better-sqlite3` moved from `dependencies` to `optionalDependencies` — npm install no longer fails if native compilation fails (Docker, Windows, CI)
- `sqlite-store.ts` uses lazy `createRequire()` import instead of static `import` — module only loaded when `SqliteStore` is instantiated

### Fixed
- Semaphore permit leak in Playwright scanner — `newContext()`/`newPage()` moved inside `try` block
- API Discovery `rebuild()` double-fetch of network events
- Console, Network, State, HAR tools could return unbounded response sizes

## [0.7.1] - 2026-03-19

### Added
- SDK connection warnings and navigation tracking
- SQLite fallback storage for collector
- Dashboard buildout (PM features, Git tab, sessions, notes, memory, rules, capex)

## [0.7.0] - 2026-03-18

### Added
- Custom event tracking (`RuntimeScope.track()`)
- Dashboard project manager (standalone collector)
- Server SDK (`@runtimescope/server-sdk`) for Node.js instrumentation

## [0.6.2] - 2026-03-17

### Added
- `init()` alias on SDK — mirrors `connect()` for ergonomics
- All captures enabled by default (no opt-in required)

## [0.2.0] - 2026-02-11

### Added
- XHR interception (`interceptXhr`) alongside fetch
- State store observability — Zustand and Redux subscription with state diffing
- React render tracking via React Profiler API with render velocity and cause detection
- Performance metrics via PerformanceObserver (Web Vitals: LCP, FCP, CLS, TTFB, FID, INP)
- DOM snapshot capture via bidirectional server-to-SDK command protocol
- HAR export tool (`export_har`)
- Error aggregation tool (`get_errors`)
- Render summary tool (`get_render_summary`)
- State changes tool (`get_state_changes`)
- Performance metrics tool (`get_performance_metrics`)
- DOM snapshot tool (`capture_dom_snapshot`)
- Issue detectors: excessive re-renders, large state updates, poor Web Vitals
- `beforeSend` hook for event filtering/transformation
- Request/response body capture (opt-in, configurable size limits)
- Configurable batch size and flush interval
- Documentation system (claude-docs-system) with `/audit`, `/sync`, `/onboard` commands

## [0.1.0] - 2026-02-10

### Added
- Initial M1 implementation — full end-to-end runtime profiling pipeline
- Browser SDK with fetch interception and console patching
- WebSocket transport with batching, reconnection, and offline queue
- Collector server with ring buffer (10K events) and query API
- MCP server with stdio transport (6 core tools)
- Issue detection: failed requests, slow requests, N+1, console error spam, high error rate
- Header redaction for privacy
- Event timeline with filtering
- README with quick start guide

---

## Format

- **Added**: New features
- **Changed**: Changes to existing functionality
- **Fixed**: Bug fixes
- **Removed**: Removed features
- **Security**: Security fixes

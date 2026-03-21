# Known Issues

## Active Issues

### [LOW] DOM Snapshot Targets First Session Only
- **ID**: KI-002
- **Location**: `packages/mcp-server/src/tools/dom-snapshot.ts`
- **Symptom**: `capture_dom_snapshot` uses `getFirstSessionId()` — may snapshot the wrong app if multiple are connected
- **Workaround**: Only connect one app at a time
- **Proper Fix**: Add `sessionId` parameter to the tool
- **Added**: 2026-02-11

### [LOW] Port Cleanup Uses macOS-Specific lsof
- **ID**: KI-003
- **Location**: `packages/mcp-server/src/index.ts:26`
- **Symptom**: Stale process detection may fail on Linux distros without lsof, and on Windows
- **Workaround**: Manually kill processes on port 9090
- **Proper Fix**: Cross-platform port detection (e.g., `fkill` or platform-specific checks)
- **Added**: 2026-02-11

---

## Resolved Issues

### [MEDIUM] No Event Persistence — Data Lost on Restart
- **ID**: KI-001
- **Resolved**: 2026-03-18 (v0.7.0)
- **Fix**: SQLite persistence added via `sqlite-store.ts` in the collector. Events now survive restarts. Corruption recovery added in v0.7.2.

### [MEDIUM] No Test Suite
- **ID**: KI-004
- **Resolved**: 2026-03-18
- **Fix**: Vitest test suite added — 444 tests across 32 files including unit and integration tests. Runs with `pool: 'forks'` for native module compatibility.

### [MEDIUM] Dashboard Bundle Size Warning
- **ID**: KI-005
- **Resolved**: 2026-03-20
- **Fix**: Route-based code splitting with `React.lazy()` + `Suspense`. Main bundle reduced from 803KB → 280KB (65% reduction). Vite chunk warning eliminated.

---

## Severity Guide

| Level | Description |
|-------|-------------|
| CRITICAL | System unusable, data loss, security |
| HIGH | Major feature broken, no workaround |
| MEDIUM | Feature impaired, workaround exists |
| LOW | Minor inconvenience |

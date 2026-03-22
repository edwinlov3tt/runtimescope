# Known Issues

## Active Issues

### [LOW] DOM Snapshot Targets First Session Only
- **ID**: KI-002
- **Location**: `packages/mcp-server/src/tools/dom-snapshot.ts`
- **Symptom**: `capture_dom_snapshot` uses `getFirstSessionId()` — may snapshot the wrong app if multiple are connected
- **Workaround**: Use `project_id` param (added in v0.9.0) to scope to correct project
- **Proper Fix**: Fully resolved with project_id scoping
- **Added**: 2026-02-11

### [MEDIUM] Workers SDK DTS Build Fails
- **ID**: KI-006
- **Location**: `packages/workers-sdk/tsconfig.json`
- **Symptom**: `tsup` DTS build fails with "Cannot find type definition file for '@cloudflare/workers-types'" — JS build succeeds
- **Workaround**: JS output works fine, only type declarations are affected
- **Proper Fix**: Install `@cloudflare/workers-types` as devDependency
- **Added**: 2026-03-22

### [LOW] MCP Server Process Runs Old Code Until Restart
- **ID**: KI-007
- **Location**: MCP server (started by Claude Code)
- **Symptom**: Code changes to MCP server/collector require Claude Code restart to take effect. The running MCP process uses the compiled dist/ from when it started.
- **Workaround**: Restart Claude Code session, or use standalone collector for dashboard
- **Added**: 2026-03-22

---

---

## Resolved Issues

### [LOW] Port Cleanup Uses macOS-Specific lsof
- **ID**: KI-003
- **Resolved**: 2026-03-21
- **Fix**: Created `packages/collector/src/platform.ts` with cross-platform utilities. Uses `lsof` on macOS, `lsof`/`ss`/`/proc` on Linux, `netstat`/`tasklist` on Windows.

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

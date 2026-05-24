# Known Issues

## Active Issues

### [MEDIUM] No Event Persistence — Data Lost on Restart
- **ID**: KI-001
- **Location**: `packages/collector/src/store.ts`
- **Symptom**: Restarting the MCP server loses all captured events
- **Workaround**: Use `export_har` to save network data before restart. Don't restart during debugging sessions.
- **Proper Fix**: Add SQLite persistence (planned for M9)
- **Added**: 2026-02-11

### [MEDIUM] No Test Suite
- **ID**: KI-004
- **Location**: All packages
- **Symptom**: No unit, integration, or e2e tests exist
- **Workaround**: Manual testing only
- **Proper Fix**: Add test framework (vitest) and critical path tests
- **Added**: 2026-02-11

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

_No resolved issues yet._

---

## Severity Guide

| Level | Description |
|-------|-------------|
| CRITICAL | System unusable, data loss, security |
| HIGH | Major feature broken, no workaround |
| MEDIUM | Feature impaired, workaround exists |
| LOW | Minor inconvenience |

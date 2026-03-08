# Project Assessment

**Generated**: 2026-03-06
**Version**: v0.7.0 (50 MCP tools, 6 packages, 289 tests)
**Focus Areas**: Tracking gaps, collector completeness, installation friction

## Executive Summary

RuntimeScope has grown significantly since the last audit (Feb 11). The system now has 50 MCP tools (docs say 46), 6 packages, SQLite persistence, a dashboard, server SDK with 6 ORM integrations, and a new CLI. The core pipeline is solid.

**Two key concerns investigated:**
1. **Tracking Gaps** — The SDK covers ~55% of what a comprehensive runtime profiler should track. Strong on network/database/console, weak on user interactions, navigation, storage, and WebSocket traffic.
2. **Installation Difficulty** — The happy path is clean (`npx -y @runtimescope/mcp-server`), but native module compilation (better-sqlite3), platform-specific code (lsof), and silent SDK connection failures create real friction.

---

## Part 1: Tracking & Collection Gaps

### What's Currently Tracked

| Category | Browser SDK | Server SDK | Coverage |
|----------|------------|------------|----------|
| HTTP Requests | fetch + XHR | http/https + middleware | 90% |
| Console Output | All 6 levels + stack traces | All 6 levels + stack traces | 85% |
| Errors | Uncaught + unhandled + resource | Uncaught + unhandled | 70% |
| Web Vitals | LCP, FCP, CLS, TTFB, FID, INP | — | 95% |
| React Renders | Component counts, velocity, causes | — | 65% |
| State Stores | Zustand + Redux with diffs | — | 40% |
| Database Queries | — | Prisma, Drizzle, pg, Knex, MySQL2, better-sqlite3 | 85% |
| Server Metrics | — | Memory, CPU, event loop, GC | 95% |
| Custom Events | RuntimeScope.track() | RuntimeScope.track() | 100% |
| DOM Snapshots | On-demand via command | — | 100% |

### HIGH Priority Gaps (Things Users Will Ask About)

| Gap | Why It Matters | Effort |
|-----|----------------|--------|
| **No WebSocket traffic monitoring** | Real-time apps (chat, dashboards, multiplayer) are blind | M |
| **No user interaction events** | Can't correlate clicks/inputs/scrolls with app behavior | M |
| **No navigation/routing events** | SPA route transitions invisible; can't trace user flows | S |
| **No localStorage/sessionStorage tracking** | Cache mutations and local state changes invisible | S |
| **No Service Worker interception** | PWA caching, offline behavior, push notifications invisible | M |
| **No long task / jank detection** | Only Web Vitals exist; no Long Task API or rAF drops | S |
| **No memory leak detection** | Heap snapshots, detached DOM nodes, listener cleanup not tracked | L |

### MEDIUM Priority Gaps

| Gap | Why It Matters | Effort |
|-----|----------------|--------|
| **No MobX/Jotai/Recoil/Valtio support** | Only Zustand + Redux covered; modern state libs excluded | M |
| **No IndexedDB tracking** | PWAs and offline-first apps invisible | M |
| **No Server-Sent Events (SSE) tracking** | Streaming responses treated as single response | S |
| **No Web Worker monitoring** | Worker thread performance invisible | M |
| **No third-party script attribution** | Can't identify which 3P scripts are slow | M |
| **No Suspense/code-split monitoring** | Lazy load times, Suspense fallbacks not tracked | S |
| **console.assert/time/table not captured** | 3 console methods silently skipped | S |

### Interceptor Edge Cases Found

| Issue | Location | Impact |
|-------|----------|--------|
| **TTFB = duration** in fetch/XHR interceptors | sdk/src/interceptors/fetch.ts, xhr.ts | No real TTFB measurement; should use PerformanceResourceTiming |
| **Redux middleware chain can break** | sdk/src/interceptors/state-stores.ts | lastAction variable only captures first dispatch in sequence |
| **Shallow diff misses nested changes** | sdk/src/interceptors/state-stores.ts | `{ user: { name: 'new' } }` shows no diff if ref unchanged |
| **Render cause is heuristic** | sdk/src/interceptors/react-renders.ts | Can't distinguish context vs props changes |
| **No unmount tracking** | sdk/src/interceptors/react-renders.ts | Only mount/update phases captured |
| **sourceFile always undefined** | sdk/src/interceptors/console.ts | Console events lack source file info in browser |
| **FormData/Blob body → placeholder** | sdk/src/interceptors/fetch.ts | File uploads show "[FormData]" instead of metadata |

---

## Part 2: Collector & MCP Server Gaps

### Issue Detection Patterns (10 implemented)

| Pattern | Status | Notes |
|---------|--------|-------|
| Failed requests (4xx/5xx) | Done | Grouped by status + URL |
| Slow requests (>3s) | Done | |
| N+1 requests | Done | >5 calls same endpoint in 2s |
| N+1 database queries | Done | >5 SELECTs same table in 2s |
| Slow database queries (>500ms) | Done | |
| Console error spam | Done | Same error >5x in 10s |
| High error rate (>30%) | Done | |
| Excessive re-renders (>4/sec) | Done | |
| Large state updates (>100KB) | Done | |
| Poor Web Vitals | Done | LCP/CLS = HIGH, others = MEDIUM |

### Missing Detection Patterns

| Pattern | Severity | Notes |
|---------|----------|-------|
| Memory leak (monotonic heap growth) | HIGH | Server SDK has data, no trend analysis |
| API degradation over time | MEDIUM | ApiDiscoveryEngine has data, not surfaced well |
| Event loop blocking (>50ms) | MEDIUM | Data exists, no threshold check |
| Orphaned process detection | LOW | ProcessMonitor detects but doesn't alert |
| Cache hit rate analysis | LOW | Not tracked |

### Data Flow Gaps (Collected but Underutilized)

| Data | Stored In | Gap |
|------|-----------|-----|
| Request/response bodies | NetworkEvent | Never indexed, searched, or analyzed; bloats SQLite |
| GraphQL operation names | NetworkEvent.graphql | Parsed but no dedicated GraphQL analytics tool |
| Build metadata (git commit/branch) | Session | Stored but never cross-referenced with issues |
| State diffs | StateEvent.diff | Captured but no change analysis or visualization |
| Error phases (abort/timeout) | NetworkEvent.errorPhase | Not used in issue detection |
| Tables accessed per query | DatabaseEvent.tablesAccessed | No multi-table transaction detection |

### SQLite Persistence

- **Architecture**: Dual-write (in-memory RingBuffer + SQLite WAL mode)
- **Working well**: Write buffering (50 events, 100ms flush), proper indexes
- **Gaps**: No schema versioning for migrations, no orphaned snapshot cleanup, no CASCADE DELETE

---

## Part 3: Installation Friction Analysis

### The Happy Path (Works Well)

```bash
# Step 1: Register MCP server (one-time, 5 seconds)
claude mcp add runtimescope -s user -- npx -y @runtimescope/mcp-server

# Step 2: Add SDK (framework-dependent, 1-5 minutes)
npm install @runtimescope/sdk  # or script tag

# Step 3: Verify
# Ask Claude: "Use get_session_info to check if SDK is connected"
```

This is genuinely simple for macOS/Linux users with Node.js 20+ and build tools installed.

### CRITICAL Friction Points

| Issue | Impact | Who's Affected |
|-------|--------|----------------|
| **better-sqlite3 requires C++ compiler** | `npx @runtimescope/mcp-server` fails with cryptic gyp errors if build tools missing | Windows users, CI environments, Docker minimal images |
| **lsof-based process cleanup** | Port 9090 stays locked after crash on non-macOS; next startup fails | Windows users, minimal Linux |
| **HTTP API fails silently** | SDK snippet serving breaks (404), no user notification | Users relying on script tag installation |

### HIGH Friction Points

| Issue | Impact | Who's Affected |
|-------|--------|----------------|
| **SDK connection failure is silent** | WebSocket errors logged to `console.debug` (hidden by default in Chrome); users don't know if SDK is working | Everyone on first setup |
| **Playwright Chromium not pre-installed** | `scan_website` fails at runtime with "Chromium not found" | First-time scanner users |
| **Manual ORM wiring required** | Server SDK requires explicit `instrumentPrisma(prisma)` etc.; forgetting it = silent query capture failure | Server SDK users |
| **No unified health check** | No single tool that says "everything is working" vs "here's what's broken" | Everyone troubleshooting |

### MEDIUM Friction Points

| Issue | Impact | Who's Affected |
|-------|--------|----------------|
| **Port shift not communicated** | If 9090 in use, collector silently moves to 9091-9095; SDK still tries 9090 | Users with port conflicts |
| **CORS not documented** | `RUNTIMESCOPE_CORS_ORIGINS` env var exists but not in any docs | Cross-origin setups |
| **MCP vs standalone mode confusion** | Different default ports (9090 vs 9092), different capabilities | Users running both |
| **CLI exists but undocumented** | `packages/cli/` has setup wizard but README doesn't mention it | New users |

### Recommendations to Reduce Installation Friction

**Phase 1 — Quick Wins (S effort each)**
1. Add `console.warn` (not debug) in SDK if collector unreachable for >10s
2. Validate `better-sqlite3` loads at MCP startup; show platform-specific install instructions on failure
3. Print startup health summary to stderr: "Collector on ws://127.0.0.1:9090, HTTP on :9091"
4. Document `RUNTIMESCOPE_CORS_ORIGINS` env var in CLAUDE.md

**Phase 2 — Meaningful Improvements (M effort each)**
5. Cross-platform port detection (Node.js `net.createServer` probe instead of lsof)
6. Add `check_connection` MCP tool with troubleshooting hints
7. Auto-detect ORMs from package.json and suggest instrumentation calls
8. Pre-install Playwright Chromium during `npm install` (postinstall script)

**Phase 3 — Polish (L effort)**
9. Fallback to in-memory-only mode if better-sqlite3 fails (graceful degradation)
10. CLI setup wizard with interactive framework detection
11. Browser DevTools panel showing SDK connection status

---

## Part 4: Documentation & Code Health

### Documentation Freshness

| Document | Status | Notes |
|----------|--------|-------|
| ARCHITECTURE.md | Stale | Says "11 tools" and "3 packages"; reality is 50 tools, 6 packages |
| CHANGELOG.md | Stale | Last entry is v0.2.0; current version is v0.7.0 |
| DECISIONS.md | Current | 7 decisions still valid |
| KNOWN_ISSUES.md | Stale | KI-001 (no persistence) resolved; KI-004 (no tests) resolved |
| LOCAL_DEV.md | Current | Accurate setup instructions |
| ASSESSMENT.md | This file | Updated 2026-03-06 |

### Code Health

- **TODOs/FIXMEs**: 0 found in source (clean)
- **Tests**: 289 tests across 23 files (good coverage)
- **Type safety**: Zod schemas on all MCP tool inputs
- **Security**: Auth tokens, header redaction, CORS, TLS support exist
- **Build**: tsup builds all packages cleanly

### Security Gaps

| Gap | Severity |
|-----|----------|
| No HTTP-level rate limiting (only session-based) | MEDIUM |
| DOM snapshots contain full HTML (could leak sensitive markup) | MEDIUM |
| Request bodies stored unencrypted in SQLite | LOW |
| No audit log of who queried what | LOW |

---

## Summary Scorecard

| Category | Score | Notes |
|----------|-------|-------|
| **Core Pipeline** | A | Solid architecture, well-tested |
| **Browser Tracking** | B- | Good HTTP/console/errors; missing interactions, navigation, storage |
| **Server Tracking** | A- | Excellent DB/HTTP/metrics; missing WebSocket, transactions |
| **Issue Detection** | B | 10 patterns cover common cases; missing memory/degradation trends |
| **Installation (macOS)** | B+ | Clean happy path, silent failures need fixing |
| **Installation (Windows)** | D | Native module compilation is a blocker |
| **Installation (Linux)** | B | Works if build tools present |
| **Documentation** | C | Stale docs; gap between README (current) and internal docs (outdated) |
| **Security** | B | Auth + redaction + CORS exist; missing rate limiting + encryption |

---

## Top 5 Actions

1. **Fix silent SDK connection failure** — `console.warn` after 10s, add `check_connection` tool
2. **Graceful degradation for better-sqlite3** — Fall back to memory-only if compilation fails
3. **Add navigation/routing events** — Low effort, high impact for SPA debugging
4. **Add user interaction tracking** — Click/input events enable user flow correlation
5. **Update stale documentation** — ARCHITECTURE.md, CHANGELOG.md, KNOWN_ISSUES.md are all outdated

---

*Run `/task [action]` to create implementation tasks for any of these findings*

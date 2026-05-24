# RuntimeScope System Review & Research Guide

A deep audit of the current system — what it does well, where it's fragile, and focused areas to research for improvement. Written to serve as a research starting point, not a task list.

---

## What the System Does

RuntimeScope is a runtime observability SDK + collector + MCP server pipeline. The browser SDK monkey-patches browser APIs (fetch, XHR, console, PerformanceObserver, React DevTools hook, Zustand/Redux stores), batches the intercepted events over WebSocket, and sends them to a Node.js collector. The collector stores events in a fixed-size ring buffer (in-memory) with optional SQLite persistence. The MCP server exposes 44 tools that let Claude Code query this data in real time. A Playwright-based scanner can also visit URLs directly for recon.

**Data flow:** Browser SDK → WebSocket → Collector (RingBuffer + SQLite) → MCP Tools → Claude Code

**Key design decisions that are working well:**
- Zero-dependency browser SDK (no bundler lock-in, IIFE global works everywhere)
- Single-process MCP server + collector (no IPC overhead, shared EventStore)
- Ring buffer with hard cap (10K events, no unbounded memory growth on the server side)
- SQLite with WAL mode + write buffering for persistence without blocking ingestion
- Each interceptor returns a restore function for clean teardown

---

## Current Approaches & Their Trade-offs

### Monkey-patching for interception
**How it works:** Each interceptor saves the original API (`window.fetch`, `console.log`, etc.), replaces it with a wrapper that emits events, and returns a function that restores the original.

**Trade-off:** Simple and universal — works in any app without build plugins. But brittle if other libraries also patch the same APIs, or if the SDK initializes twice.

### Fixed-size ring buffer for event storage
**How it works:** FIFO circular buffer (default 10K). When full, oldest events are silently overwritten. No backpressure — the SDK never slows down.

**Trade-off:** Guaranteed O(1) memory on the server. But every query is O(n) — a full scan of the buffer with a filter predicate. At 10K events this is fine. At 100K it would hurt.

### Exponential backoff reconnection
**How it works:** On disconnect, SDK retries at 500ms x3, then doubles: 1s → 2s → 4s → ... → 30s max. Visibility change resets the timer.

**Trade-off:** Prevents hammering a dead server. But during the typical collector restart gap (1-3 seconds when Claude Code restarts the MCP server), the SDK can already be on a long backoff and miss the window.

### Rebuild-on-read for API discovery
**How it works:** Every API discovery tool call (`get_api_catalog`, `get_api_health`, etc.) calls `rebuild()` which clears all cached data and re-scans every network event from the ring buffer.

**Trade-off:** Always fresh data, no stale cache. But O(n) on every read, and some tools call rebuild twice (e.g., `get_api_docs` calls `getCatalog()` + `getHealth()`).

---

## Area 1: SDK Memory Leaks

**Severity: HIGH — this is the most likely source of real-world problems**

### The fetch interceptor's Set grows unbounded
`packages/sdk/src/interceptors/fetch.ts:14`

`fetchInterceptedRequests` is a module-level `Set<string>` that tracks in-flight requests. Each fetch adds a key and schedules a `setTimeout` to remove it after 5 seconds. Under high traffic (100+ requests/sec), thousands of timers accumulate. If URLs vary by query params or timestamps, the Set never fully drains.

**Research:** Replace with a `Map<string, number>` keyed by request ID with timestamps, and prune in a single `setInterval` instead of one `setTimeout` per request. Or use `WeakRef` / `FinalizationRegistry` if targeting modern browsers.

### XHR event listeners are never removed
`packages/sdk/src/interceptors/xhr.ts:134-187`

Four event listeners (`load`, `error`, `abort`, `timeout`) are added to every XHR instance via `addEventListener` but never removed. The closures hold references to `requestHeaders`, `startTime`, and `emitEvent`, preventing GC of completed requests.

**Research:** Use `{ once: true }` option on `addEventListener`, or use `AbortController` to batch-remove all listeners when the request completes. Alternatively, attach listeners in the `open()` override instead of `send()` to avoid duplicate attachment on retry.

### React component trackers never shrink
`packages/sdk/src/interceptors/react-renders.ts:47`

The `trackers` Map accumulates every component name ever seen. Components from code-split bundles that unmount and never remount still hold tracker objects. The reset function (line 254) zeros counters but never deletes entries.

**Research:** Add a TTL — if a component hasn't rendered in the last 2 snapshot windows (~20 seconds), delete its tracker. Or track by fiber identity instead of string name to avoid accumulation from dynamic names.

### Performance observers double-fire on reinit
`packages/sdk/src/interceptors/performance.ts`

PerformanceObservers are created with `buffered: true`, which replays all historical entries. If `connect()` is called twice (common in HMR / development), two observers fire all buffered entries — doubling metric emissions.

**Research:** Check if an observer for that entry type already exists before creating a new one. Or maintain a module-level `Set<string>` of observed types and skip if already watching.

---

## Area 2: Double-Initialization Safety

**Severity: HIGH — affects development experience and HMR scenarios**

The SDK's `connect()` method calls `disconnect()` first (line 30 of index.ts), which runs all restore functions. But the second `connect()` call patches the *already-restored* APIs — which should be fine in theory. The real problem:

1. **If `disconnect()` doesn't fully restore:** The second `connect()` captures the patched version as "original," creating a chain that never unwinds.
2. **If another library also patches:** The restore function replaces with the saved original, blowing away the other library's patch.
3. **Console methods drift:** Each init/teardown cycle can shift console methods further from the true originals.

**Research:**
- Add an `_initialized` guard that throws or warns if `connect()` is called while already connected
- Save originals only on first init, never overwrite them
- Consider a `Proxy`-based approach instead of direct assignment — proxies can be cleanly revoked without worrying about patch chains

---

## Area 3: Connection Stability

**Severity: MEDIUM — this is the "always disconnecting" symptom**

### The MCP server lifecycle problem
When Claude Code restarts (context reset, crash recovery, new conversation), it kills the MCP server process. `killStaleProcess()` in `index.ts:136-137` terminates anything on ports 9090/9091. The new MCP server starts a fresh collector. During this 1-3 second gap:

1. SDK sees disconnect, enters backoff
2. New collector is up within seconds
3. SDK might be waiting 8-30 seconds on backoff before retrying

The fast-retry fix (first 3 attempts at 500ms) helps but doesn't fully solve it. The real issue: **the SDK has no way to know the collector restarted** — it treats a restart the same as a crash.

**Research:**
- **Collector heartbeat broadcast:** Have the collector periodically send a UDP broadcast or write a timestamp to a well-known file. SDK can watch for it and reconnect immediately.
- **Shared port with process handoff:** Instead of killing the old process, the new MCP server could inherit the WebSocket connections (via `server.listen({ fd })` or IPC). Complex but zero-downtime.
- **SDK-side ping/pong:** Send a WebSocket ping every 5 seconds. If no pong within 2 seconds, immediately reconnect at fast-retry speed instead of waiting for onclose (which can take 30-60 seconds depending on TCP timeout).

### No persistent error handler on WSS
`packages/collector/src/server.ts`

The `wss.on('error')` handler during startup only handles `EADDRINUSE` — after startup, there was no runtime error handler (fixed in this session). But the fix just logs — it doesn't attempt recovery. A runtime error on the WebSocket server could leave it in a broken state where it accepts no new connections.

**Research:** On runtime WSS error, attempt to recreate the server on the same port. Or at minimum, emit a health status that the MCP tools can surface.

---

## Area 4: Query Performance at Scale

**Severity: MEDIUM — fine at 10K events, problematic at 100K+**

### Every tool query does a full buffer scan
`ring-buffer.ts:37-47` — `query()` iterates the entire buffer, testing each element against a predicate. With the default 10K buffer, this is ~1ms. But if `RUNTIMESCOPE_BUFFER_SIZE` is increased to 100K (reasonable for a long debugging session), every tool call takes 10-50ms.

**Research:**
- **Typed indexes:** Maintain a `Map<EventType, RingBuffer>` — one ring buffer per event type. Network tool only scans network events.
- **Time-based index:** Keep a sorted array of `[timestamp, bufferIndex]` pairs. Time-range queries use binary search instead of linear scan.
- **Lazy materialization:** Instead of `query()` returning an array, return an iterator. Tools that only need the first N results stop early.

### API Discovery rebuilds on every call
`packages/collector/src/engines/api-discovery.ts:233`

`rebuild()` clears the endpoint map and re-processes all network events. `getCatalog()`, `getHealth()`, `getDocs()`, `getServiceMap()` — all call `rebuild()` first. `getDocs()` calls both `getCatalog()` and `getHealth()`, triggering two rebuilds.

**Research:**
- **Dirty-flag caching:** Only rebuild if new events arrived since last rebuild. Track `lastRebuildEventCount` and compare to `store.getEventCount()`.
- **Incremental updates:** On each new network event, update the affected endpoint entry instead of rebuilding everything.
- **Separate cache TTL:** Rebuild at most once per 5 seconds, serve cached results between rebuilds.

### Issue detection is synchronous and unbounded
`packages/collector/src/issue-detector.ts`

`detectIssues()` is called on the full event array. The N+1 detection algorithm uses sliding-window checks that are O(M*K) where M = unique endpoints and K = requests per endpoint. For apps with many endpoints and high request volume, this can be expensive.

**Research:**
- Add a configurable limit to issue detection (e.g., only analyze last 1000 events)
- Run detection in a `setImmediate()` callback to avoid blocking event ingestion
- Cache results with a dirty flag (same pattern as API discovery)

---

## Area 5: Tool Response Sizes

**Severity: MEDIUM — can cause slow MCP responses and memory spikes**

Several tools return unbounded data:

| Tool | What's unbounded | Worst case |
|------|-----------------|------------|
| `get_console_messages` | All console events in time window | 50K+ messages from verbose logging |
| `get_network_requests` | All network events matching filter | 10K+ requests on busy app |
| `get_api_catalog` | All discovered endpoints | 500+ endpoints with full contracts |
| `compare_sessions` | Full session diff | Huge if sessions have many endpoints |
| `get_session_history` | All historical events from SQLite | Millions of rows |

The timeline tool is properly bounded (max 1000 events). DOM snapshot is capped at 500KB.

**Research:**
- Add a default `limit` parameter to all tools (e.g., 200 events)
- Add response size estimation — if response would exceed 100KB, truncate and add a `truncated: true` flag
- For tools that aggregate (catalog, health), cap the number of endpoints returned and sort by relevance (highest traffic or most errors first)

---

## Area 6: Playwright Scanner Resource Management

**Severity: LOW — but worth hardening**

### No concurrent scan limit
`packages/mcp-server/src/scanner/index.ts`

If 10 `scan_website` calls come in simultaneously, 10 browser contexts are created. Chromium memory usage is ~50-100MB per context. No queue or semaphore limits concurrency.

**Research:**
- Add a semaphore (concurrency limit of 2-3 contexts)
- Queue additional scans and process FIFO
- Set per-context memory limit via Chromium flags (`--max-old-space-size`)

### No page-level timeout recovery
If `page.goto()` hangs beyond the 60s timeout, the error propagates but the browser context may not be properly cleaned up.

**Research:** Wrap scan operations in a `Promise.race` with a cleanup function that calls `context.close()` regardless of outcome.

---

## Area 7: SQLite Durability & Cleanup

**Severity: LOW — acceptable for monitoring data**

### Write buffer can lose ~100ms of events on crash
`packages/collector/src/sqlite-store.ts:25`

Events are buffered in memory and flushed every 100ms or every 50 events. A process crash loses the buffer. This is fine for monitoring data but worth documenting.

### Session snapshots accumulate forever
The 30-day retention policy (`RUNTIMESCOPE_RETENTION_DAYS`) only applies to raw events, not session snapshots. Auto-snapshots run every 5 minutes. Over weeks, this adds up.

**Research:** Apply the same retention policy to snapshots. Or cap at N snapshots per session (e.g., keep last 50).

### No corruption recovery
If the SQLite database file gets corrupted (disk error, process kill during write), `better-sqlite3` throws on open. The current code catches this and continues without SQLite, but doesn't attempt recovery.

**Research:** On corruption, rename the old file to `.corrupt`, create a fresh database, and log a warning. The user loses historical data but the system keeps running.

---

## Recommended Research Priority

If you have a few focused hours, these are the highest-impact areas to investigate:

### Hour 1-2: SDK Memory Safety
1. **Replace fetch `Set` with timed `Map` + single interval** — eliminates timer accumulation
2. **Add `{ once: true }` to XHR listeners** — eliminates listener leak
3. **Add TTL pruning to React trackers** — eliminates component tracker growth
4. **Guard double-init with a flag** — prevents all patch-chain issues

### Hour 3: Connection Reliability
4. **Add WebSocket ping/pong** — detect dead connections in 2s instead of 30-60s
5. **Fast-retry with jitter on reconnect** — already partially done, verify behavior
6. **Test the full restart cycle** — kill MCP server, time how long until SDK reconnects

### Hour 4: Query Performance
7. **Add dirty-flag caching to API Discovery** — eliminates redundant rebuilds
8. **Add default limits to unbounded tools** — prevents huge MCP responses
9. **Consider typed event indexes** — if buffer size is ever increased beyond 10K

---

## What's Actually Solid

Don't let the above create a false impression. These areas are well-designed and don't need work:

- **RingBuffer memory management** — hard cap, proper GC, no leaks on the server side
- **SQLite setup** — WAL mode, prepared statements, good indexes, write buffering
- **HTTP server** — CORS, body size limits, slow-read DoS protection, auth timeout
- **Graceful shutdown** — both standalone and MCP server handle SIGINT/SIGTERM properly
- **Rate limiting** — per-session rate limiter with automatic pruning
- **Auth system** — timing-safe comparison, TLS support, token-based
- **Event redaction** — deep-walks event payloads, configurable patterns
- **Issue detection patterns** — good heuristics for N+1, slow queries, error rates, poor vitals

The system architecture is sound. The issues above are all "v1 rough edges" — things that work fine in normal conditions but can degrade under stress or over long sessions. A few focused hours of hardening would make a meaningful difference.

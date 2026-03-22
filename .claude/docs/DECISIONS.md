# Architectural Decisions

Record of technical decisions and their context.

---

## D001: Combined MCP + Collector Process

- **Date**: 2026-02-10
- **Status**: Active

### Context
The MCP server needs access to the event store. Options: (1) shared process, (2) IPC between separate processes, (3) shared SQLite database.

### Decision
Run the collector WebSocket server and MCP stdio server in the same Node.js process. The MCP server shares the `EventStore` object directly.

### Alternatives
1. **IPC between processes**: Adds serialization overhead and complexity for no benefit at dev-tool scale
2. **Shared SQLite**: Adds persistence but introduces file locking and read latency

### Consequences
- **Positive**: Simplest architecture, zero latency between collector and MCP, single startup
- **Negative**: Can't scale independently (not needed for local dev tool)

---

## D002: In-Memory Ring Buffer (No Persistence Yet)

- **Date**: 2026-02-10
- **Status**: Active (persistence planned for M9)

### Context
Need fast event storage for real-time queries. PRD specifies SQLite for persistence.

### Decision
Use a 10K-capacity in-memory ring buffer with FIFO eviction. O(1) push, O(n) query.

### Alternatives
1. **SQLite from start**: More durable but adds dependency and write latency
2. **Write-ahead log + SQLite**: Best of both but complex for MVP

### Consequences
- **Positive**: Zero dependencies, fast reads, simple implementation
- **Negative**: Events lost on restart. Session history/diffing requires SQLite (M9)

---

## D003: Zero-Dependency Browser SDK

- **Date**: 2026-02-10
- **Status**: Active

### Context
The SDK runs inside user applications. Any dependency is a risk vector.

### Decision
Zero production dependencies. All functionality (WebSocket, monkey-patching, batching, reconnection) uses browser APIs only.

### Consequences
- **Positive**: Minimal bundle (~3KB gzip target), no dep conflicts, small attack surface
- **Negative**: Manual reimplementation of WebSocket transport features

---

## D004: Duplicated Types Between SDK and Collector

- **Date**: 2026-02-10
- **Status**: Active

### Context
SDK and collector need matching type definitions for the WebSocket wire format.

### Decision
Duplicate types in both packages (`packages/sdk/src/types.ts` and `packages/collector/src/types.ts`).

### Alternatives
1. **Shared types package**: Adds build dependency to SDK (violates D003)
2. **Code generation**: Complex tooling for few types that change rarely

### Consequences
- **Positive**: SDK stays dependency-free
- **Negative**: Risk of type drift. Mitigated by WebSocket protocol enforcement at runtime.

---

## D005: Stale Process Kill on Startup

- **Date**: 2026-02-10
- **Status**: Active

### Context
When Claude Code sessions crash, the previous MCP server can linger holding port 9090.

### Decision
On startup, use `lsof -ti :PORT` to find and SIGTERM any stale processes on the collector port.

### Consequences
- **Positive**: Reliable restart in the common crash case
- **Negative**: Platform-specific (`lsof` not available on Windows). Falls back silently.

---

## D006: Batched Event Transport

- **Date**: 2026-02-10
- **Status**: Active

### Context
High-frequency interceptors (console, renders) can generate 100+ events/sec.

### Decision
SDK batches events (default: 50 per batch or 100ms flush interval, configurable).

### Consequences
- **Positive**: Reduced WebSocket frame overhead, configurable for different workloads
- **Negative**: Events arrive with up to 100ms delay (acceptable for observability)

---

## D007: tsup for Build Tooling

- **Date**: 2026-02-10
- **Status**: Active

### Context
Need to build 3 TypeScript packages with different output format requirements (SDK needs IIFE + ESM, server packages need CJS + ESM).

### Decision
Use `tsup` (esbuild wrapper) for all package builds.

### Consequences
- **Positive**: Fast builds (<1s per package), zero-config for common cases, handles multiple formats
- **Negative**: Less control than raw esbuild for edge cases (not an issue so far)

---

## D008: Smart Polling — WS-Connected Skips HTTP Polling

- **Date**: 2026-03-20
- **Status**: Active

### Context
The dashboard polled the collector HTTP API every 2 seconds for runtime events, even when a WebSocket connection was actively pushing those same events in real-time. This doubled collector load for no benefit.

### Decision
When the WS connection is open (`connected === true`), skip interval polling entirely. Still perform a single fetch on tab switch for fresh data, but no timer. Fall back to 2s polling only when WS is disconnected.

### Alternatives
1. **Reduce poll interval when WS connected**: Simpler but still wasteful
2. **Remove polling entirely**: Risky — WS can miss events during brief disconnects

### Consequences
- **Positive**: Halves collector request load during normal operation, reduces browser network chatter
- **Negative**: Brief gap if WS reconnects and first push hasn't arrived yet (mitigated by the one-shot fetch on tab switch)

---

## D009: Zustand-Based Toast Notification System

- **Date**: 2026-03-20
- **Status**: Active

### Context
PM store operations (task create, git commit, note save, etc.) completed silently with no user feedback. Users couldn't tell if actions succeeded or failed.

### Decision
Lightweight Zustand store (`use-toast-store`) with `toast.success()`/`toast.error()`/`toast.info()` shorthands. Auto-dismiss after 3 seconds. Fixed-position container in app shell.

### Alternatives
1. **React context + portal**: More boilerplate for same result
2. **Third-party toast library (react-hot-toast, sonner)**: Adds dependency for a simple feature

### Consequences
- **Positive**: Zero dependencies, consistent with existing Zustand pattern, callable from store actions (outside React tree)
- **Negative**: No toast stacking animations (acceptable for MVP)

---

## D010: MCP Tool Response Size Limits

- **Date**: 2026-03-20
- **Status**: Active

### Context
MCP tools could return unbounded event arrays (10K+ events), causing context window overflow in Claude Code and slow responses.

### Decision
Default limit of 200 events per tool response, hard max of 1000. Add `truncated: boolean` and `totalCount: number` to metadata so Claude knows when data was cut.

### Alternatives
1. **Pagination with cursor**: More complex, requires stateful server
2. **No limit**: Status quo — causes context overflow

### Consequences
- **Positive**: Prevents context overflow, Claude can request more with explicit `limit` parameter
- **Negative**: Default may miss tail events — mitigated by newest-first ordering

---

## D011: Project ID System (proj_xxx)

- **Date**: 2026-03-21
- **Status**: Active

### Context
Multiple SDKs for the same project (browser, server, worker) used different `appName` strings and were matched via fuzzy heuristics in `autoLinkApp()`. This was fragile and couldn't reliably group sessions.

### Decision
Add a `projectId` field (`proj_` + 12 alphanumeric chars) across all SDKs, collector, and MCP tools. Auto-generated on connect if not provided. Persisted in `~/.runtimescope/` via ProjectManager.

### Consequences
- **Positive**: Deterministic grouping, all MCP tools accept `project_id` param, works across environments
- **Negative**: Adds a field to every config, handshake, and session — but optional/backwards-compatible

---

## D012: Unified Default Ports (9090/9091)

- **Date**: 2026-03-21
- **Status**: Active

### Context
MCP server and standalone collector used different default ports (9090/9091 vs 9092/9093) to allow simultaneous operation. This caused confusion about which collector the SDK was connecting to.

### Decision
Both MCP server and standalone collector default to 9090/9091. Only one should run at a time.

### Consequences
- **Positive**: Single mental model, SDK always connects to same port, dashboard always proxies to same port
- **Negative**: Can't run both simultaneously without env var overrides

---

## D013: .runtimescope/ Project Config Directory

- **Date**: 2026-03-22
- **Status**: Active

### Context
Project settings (projectId, capture flags, SDK entries) had no git-committable home. `.claude/` is gitignored, `~/.runtimescope/` is user-global.

### Decision
Create `.runtimescope/config.json` at the project root. Git-safe (no secrets). Server SDK auto-reads it. `/setup` scaffolds it.

### Consequences
- **Positive**: Settings travel with the repo, new Claude instances auto-discover projectId, central config surface
- **Negative**: Another dotfile directory in projects

---

## D014: setup_project as Deterministic MCP Tool

- **Date**: 2026-03-22
- **Status**: Active

### Context
The `/setup` command was a 200-line markdown file that instructed Claude to run bash commands and make judgment calls. Claude often missed steps or got confused.

### Decision
Replace with a `setup_project` MCP tool that does framework detection, config scaffolding, snippet generation, and hook registration in a single programmatic call.

### Consequences
- **Positive**: Deterministic, testable, single call does everything, no prompt-dependent behavior
- **Negative**: Framework detection is file-based heuristics (can miss exotic setups)

---

## D015: SDK Auto-Disable in Production

- **Date**: 2026-03-21
- **Status**: Active

### Context
Users deploying to Vercel/Netlify with `RuntimeScope.init()` and no explicit endpoint would attempt to connect to `ws://localhost:9090` in production, generating useless WebSocket errors.

### Decision
If no explicit `serverUrl`/`endpoint` is configured and `window.location.hostname` is not localhost/127.0.0.1/private IP, the SDK becomes a no-op.

### Consequences
- **Positive**: Zero-config production safety, no Vercel deployment issues
- **Negative**: Users with hosted collectors must explicitly set their endpoint

---

## Template

```markdown
## [Title]
- **Date**: YYYY-MM-DD
- **Status**: Active / Superseded / Deprecated

### Context
What problem needed solving.

### Decision
What was chosen and why.

### Alternatives
1. **Option A**: Why rejected

### Consequences
- **Positive**: What we gain
- **Negative**: What we give up
```

## When to Record

Record when:
- Choosing between technologies
- Designing data models or APIs
- Setting up infrastructure
- Establishing patterns that will be repeated
- Making tradeoffs that won't be obvious later

Don't record:
- Obvious standard patterns
- Temporary implementations

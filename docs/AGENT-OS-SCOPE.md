# AgentOS — Full Scope Document

> FlowAI evolves into an AI Agent Orchestration platform. RuntimeScope remains a separate, pluggable observability layer. This document captures the full vision, architecture, and implementation plan.

---

## 1. What Exists Today

### RuntimeScope (separate repo: `runtime-profiler/`)
- **SDKs**: Browser, Server (Node), Workers (Cloudflare) — zero-dep telemetry collection
- **Collector**: WebSocket + HTTP event ingestion, SQLite persistence, ring buffer
- **MCP Server**: 44+ tools for Claude Code integration
- **Dashboard**: React/Vite project management + runtime profiling UI
- **Design System**: Supabase-inspired dark theme with teal accent (prototyped in `docs/ui-update/`)

### FlowAI (this repo: `flowAI/`)
- **Core DSL**: 70+ workflow node types (browser, data, logic, AI, API)
- **Runner**: Platform-agnostic workflow executor with node callbacks
- **Runtimes**: Desktop (Puppeteer/SQLite), Docker (Playwright/PostgreSQL), Cloud (Workers/D1/R2)
- **Agents**: Desktop (Tauri) and Docker execution agents with REST+WebSocket APIs
- **Extension**: Chrome extension with visual flow builder, action recorder, side panel
- **Client**: React 19 web app with flow editor (XYFlow), Supabase auth
- **MCP Server**: Exposes workflows to Claude Code

---

## 2. What We're Building

### The Core Idea
An AI agent orchestration system where:
1. **Agents** have capabilities, access to workflows, and can execute tasks autonomously
2. **Workflows** (FlowAI's existing engine) are the "hands" — concrete sequences of actions
3. **Knowledge Bases** give agents context — docs, code, schemas, past decisions
4. **RuntimeScope** is the "eyes" — telemetry from running applications
5. **The Orchestrator** is the "brain" — routes tasks to agents, decomposes problems, manages state

### The Loop
```
App has an issue → RuntimeScope detects it → Orchestrator receives alert
    → Orchestrator pulls context from Knowledge Base
    → Orchestrator dispatches Agent with a FlowAI workflow
    → Agent executes workflow (browser automation, API calls, code changes)
    → RuntimeScope confirms the fix worked → loop closes
```

---

## 3. Architecture

### Two Repos, Connected via API

```
runtime-profiler/                    flowAI/ (→ AgentOS)
├── @runtimescope/sdk               ├── @flowai/core (exists)
├── @runtimescope/server-sdk         ├── @flowai/runner (exists)
├── @runtimescope/workers-sdk        ├── @flowai/agent-protocol (exists)
├── @runtimescope/collector          ├── @flowai/mcp-server (exists)
├── @runtimescope/mcp-server         ├── @flowai/runtime-* (exists)
└── @runtimescope/dashboard          │
    └── Exports embeddable views     ├── @flowai/agents ← NEW
                                     ├── @flowai/knowledge ← NEW
                                     ├── @flowai/orchestrator ← NEW
                                     └── @flowai/dashboard ← NEW (AgentOS control board)
```

### Connection Points
```
AgentOS Dashboard ──HTTP──▶ RuntimeScope Collector (/api/events, /api/pm/*)
       │
       ├──▶ FlowAI Runner (execute workflows)
       ├──▶ Agent Registry (manage agent fleet)
       ├──▶ Knowledge Store (RAG + document retrieval)
       └──▶ RuntimeScope MCP tools (agents use these to diagnose apps)
```

---

## 4. New Packages

### `@flowai/agents` — Agent Definitions & Lifecycle

The agent layer sits between the orchestrator and the workflow runner. Each agent declares capabilities, manages its own state, and can be dispatched by the orchestrator.

```
packages/agents/
├── src/
│   ├── agent.ts              # Base Agent class
│   │   - id, name, description, status (idle/busy/error)
│   │   - capabilities: string[] (what this agent can do)
│   │   - execute(task): Promise<TaskResult>
│   │   - health check, heartbeat
│   │
│   ├── registry.ts           # Agent Registry
│   │   - register(agent), deregister(id)
│   │   - discover(): Agent[] (all available agents)
│   │   - findByCapability(cap): Agent[]
│   │   - health monitoring, auto-restart
│   │
│   ├── built-in/             # Pre-built agents
│   │   ├── diagnostics.ts    # Uses RuntimeScope MCP to diagnose apps
│   │   │   - Capabilities: analyze-errors, check-performance, detect-n+1
│   │   │   - Connects to RuntimeScope collector HTTP API
│   │   │
│   │   ├── automation.ts     # Executes FlowAI workflows
│   │   │   - Capabilities: run-workflow, browser-automation, data-extraction
│   │   │   - Dispatches to FlowAI runner with appropriate runtime
│   │   │
│   │   ├── researcher.ts     # Web research via browser automation
│   │   │   - Capabilities: web-search, page-analysis, content-extraction
│   │   │   - Uses Playwright/Puppeteer headless
│   │   │
│   │   ├── coder.ts          # Code generation and modification
│   │   │   - Capabilities: generate-code, fix-bug, refactor
│   │   │   - Uses Claude API + file system access
│   │   │
│   │   └── deployer.ts       # Deployment management
│   │       - Capabilities: deploy, rollback, health-check
│   │       - Integrates with Cloudflare, Vercel APIs
│   │
│   └── types.ts              # Agent types, capability declarations
```

**Key Design Decisions:**
- Agents are **not** LLM wrappers. They're execution units with defined capabilities.
- An agent CAN use an LLM (via Claude API) as part of its execution, but it's not required.
- Agents run in-process (desktop), in Docker containers, or on Cloudflare Workers.
- The existing `@flowai/agent-protocol` HTTP contract extends to support orchestration.

---

### `@flowai/knowledge` — Knowledge Base System

Evolves from RuntimeScope's memory system (markdown files with frontmatter) into a proper knowledge store with retrieval capabilities.

```
packages/knowledge/
├── src/
│   ├── store.ts              # Document store abstraction
│   │   - ingest(doc): void
│   │   - query(q, opts): Document[]
│   │   - delete(id): void
│   │   - listCollections(): Collection[]
│   │
│   ├── ingest.ts             # Document ingestion pipeline
│   │   - Markdown parsing + frontmatter extraction
│   │   - Code file indexing (AST-aware for TS/JS)
│   │   - URL crawling + content extraction
│   │   - Chunking strategies (fixed, semantic, code-aware)
│   │
│   ├── retrieval.ts          # RAG retrieval
│   │   - Full-text search (SQLite FTS5 / D1)
│   │   - Vector similarity (Cloudflare Vectorize, future)
│   │   - Hybrid ranking (text + vector combined)
│   │   - Context window management
│   │
│   ├── connectors/           # Storage backends
│   │   ├── sqlite.ts         # Local SQLite (dev, compatible with D1)
│   │   ├── d1.ts             # Cloudflare D1 (production)
│   │   └── vectorize.ts      # Cloudflare Vectorize (future)
│   │
│   └── types.ts              # Document, Collection, Query types
```

**Document Model:**
```typescript
interface Document {
  id: string;
  collectionId: string;
  title: string;
  content: string;
  contentType: 'markdown' | 'code' | 'text' | 'url';
  metadata: Record<string, unknown>;
  tags: string[];
  embedding?: number[];    // future: vector embedding
  chunkedFrom?: string;    // parent document ID if chunked
  createdAt: number;
  updatedAt: number;
}

interface Collection {
  id: string;
  name: string;           // e.g., "API Docs", "Codebase", "Decisions"
  projectId?: string;     // scoped to a project, or global
  documentCount: number;
  totalSize: number;
}
```

**Migration Path from RuntimeScope Memory:**
```
Memory files (.md with frontmatter)  →  Documents in KB
├── name → title
├── description → metadata.description
├── type (user/feedback/project) → collection + tags
└── content → content (markdown)
```

---

### `@flowai/orchestrator` — The Brain

Routes tasks to agents, decomposes complex problems, manages execution state.

```
packages/orchestrator/
├── src/
│   ├── router.ts             # Task → Agent routing
│   │   - matchCapabilities(task, agents): Agent[]
│   │   - prioritize(matches): Agent (best fit)
│   │   - fallback strategies
│   │
│   ├── planner.ts            # Multi-step task decomposition
│   │   - decompose(task): Step[]
│   │   - Uses LLM for complex decomposition
│   │   - DAG execution (parallel where possible)
│   │   - Re-planning on failure
│   │
│   ├── scheduler.ts          # Triggers and scheduling
│   │   - Cron-based recurring tasks
│   │   - Event-driven triggers (RuntimeScope alerts)
│   │   - Webhook receivers
│   │   - Rate limiting and queue management
│   │
│   ├── context.ts            # Shared context across agents
│   │   - Task context (what are we trying to do)
│   │   - Environment context (what project, what state)
│   │   - Knowledge context (relevant docs from KB)
│   │   - Telemetry context (RuntimeScope data)
│   │
│   ├── api.ts                # HTTP API for dashboard
│   │   - POST /tasks — submit a new task
│   │   - GET /tasks/:id — task status + result
│   │   - GET /agents — fleet overview
│   │   - GET /agents/:id/logs — agent execution logs
│   │   - WebSocket /stream — real-time updates
│   │
│   └── types.ts
```

**Task Model:**
```typescript
interface Task {
  id: string;
  description: string;         // natural language or structured
  requiredCapabilities: string[];
  priority: 'low' | 'medium' | 'high' | 'critical';
  status: 'pending' | 'planning' | 'executing' | 'completed' | 'failed';
  assignedAgentId?: string;
  steps?: TaskStep[];          // from planner decomposition
  context: {
    projectId?: string;        // which project this relates to
    telemetrySessionId?: string; // RuntimeScope session for context
    knowledgeCollectionId?: string;
  };
  result?: unknown;
  error?: string;
  createdAt: number;
  completedAt?: number;
}
```

---

### `@flowai/dashboard` — AgentOS Control Board

The unified dashboard for the orchestration platform. Shares the same design system as RuntimeScope dashboard (tokens, components, patterns from `docs/ui-update/`).

```
packages/dashboard/
├── src/
│   ├── pages/
│   │   ├── overview/         # Fleet overview — agents, tasks, system health
│   │   ├── agents/           # Agent management — status, logs, capabilities
│   │   ├── workflows/        # FlowAI builder (embedded or linked)
│   │   ├── tasks/            # Task queue — submitted, running, completed
│   │   ├── knowledge/        # KB management — collections, documents, search
│   │   ├── telemetry/        # RuntimeScope data — queries collector API
│   │   └── settings/         # Platform configuration
│   │
│   ├── components/
│   │   └── (shared design system from RuntimeScope)
│   │
│   └── lib/
│       ├── api.ts            # Orchestrator API client
│       ├── runtimescope.ts   # RuntimeScope collector API client
│       └── ws.ts             # WebSocket for real-time updates
```

---

## 5. Integration with Existing FlowAI

### What Changes
| Component | Before | After |
|-----------|--------|-------|
| `@flowai/runner` | Standalone workflow executor | Called by agents via orchestrator |
| `@flowai/agent-protocol` | Simple job submission API | Extended with orchestration endpoints |
| `agents/desktop` | Direct workflow execution | Registers as an agent in the orchestrator |
| `agents/docker` | Direct workflow execution | Registers as an agent in the orchestrator |
| `client/frontend` | Workflow builder UI | Embedded in AgentOS dashboard, or standalone |
| `extension/` | Action recorder + builder | Unchanged — feeds workflows into the system |

### What Doesn't Change
- `@flowai/core` — DSL types are stable
- `@flowai/runner` — execution engine is stable, just gets called differently
- `@flowai/runtime-*` — runtime providers are stable
- `extension/` — Chrome extension works as-is
- `cloud/worker/` — Cloudflare deployment stays separate

---

## 6. RuntimeScope Integration Details

### What RuntimeScope Exposes
| Endpoint | Used By | Purpose |
|----------|---------|---------|
| `GET /api/health` | Orchestrator | Connectivity check |
| `GET /api/events/*` | Diagnostics Agent | Query network, console, state events |
| `GET /api/pm/projects` | Dashboard | List monitored projects |
| `GET /api/pm/sessions` | Dashboard | Claude session history |
| `POST /api/events` | Workers Agent | Push events from Cloudflare |
| MCP tools (44+) | Any Agent | Full RuntimeScope toolkit via MCP protocol |

### The Diagnostics Agent Flow
```
1. Orchestrator detects: RuntimeScope reports 5xx errors on /api/deploy
2. Orchestrator creates Task: "Investigate 5xx errors on deploy endpoint"
3. Router selects: Diagnostics Agent (capability: analyze-errors)
4. Agent executes:
   a. Queries RuntimeScope: GET /api/events/network?status=500
   b. Queries RuntimeScope: GET /api/events/console?level=error
   c. Pulls context from KB: relevant deploy documentation
   d. Analyzes: identifies root cause (missing env var)
   e. Returns: structured diagnosis with fix recommendation
5. Orchestrator routes to: Coder Agent (capability: fix-bug)
6. Coder Agent:
   a. Reads the diagnosis
   b. Generates fix (add env var to wrangler.toml)
   c. Creates PR or applies fix
7. RuntimeScope confirms: no more 5xx errors → task completed
```

---

## 7. Dashboard Pages (AgentOS)

Based on the design system we built in `runtime-profiler/docs/ui-update/`, the AgentOS dashboard will have these pages — using the same rail+sidebar+header pattern:

| Page | Description | Key Components |
|------|-------------|----------------|
| **Overview** | Fleet health — active agents, pending tasks, system metrics | KPI cards, activity feed, agent status grid |
| **Agents** | Agent management — register, configure, monitor | Agent cards, capability badges, log viewer |
| **Agent Detail** | Single agent — logs, current task, capabilities, health | Timeline, log viewer, metric cards |
| **Tasks** | Task queue — submit, track, review results | Table with status badges, detail panel |
| **Workflows** | FlowAI builder — create/edit workflows | XYFlow editor (existing), workflow list |
| **Knowledge** | KB management — collections, documents, search | File tree, markdown viewer, metadata sidebar |
| **Telemetry** | RuntimeScope data — embedded views | Network table, console log, activity feed |
| **Settings** | Platform config — agents, connections, credentials | Form grids, toggles, workspace cards |

---

## 8. Implementation Phases

### Phase 1: Foundation (2-3 weeks)
- [ ] Create `@flowai/agents` with base Agent class and registry
- [ ] Create `@flowai/knowledge` with SQLite store and markdown ingestion
- [ ] Extend `@flowai/agent-protocol` with orchestration endpoints
- [ ] Build one built-in agent: `diagnostics.ts` (connects to RuntimeScope)
- [ ] Basic orchestrator: task submission → agent routing → execution

### Phase 2: Intelligence (2-3 weeks)
- [ ] Build `@flowai/orchestrator` planner (LLM-powered task decomposition)
- [ ] Add `coder.ts` and `automation.ts` built-in agents
- [ ] Knowledge base ingestion: code files, URL crawling
- [ ] Full-text search retrieval (FTS5)
- [ ] Scheduler: cron tasks and event-driven triggers

### Phase 3: Dashboard (2-3 weeks)
- [ ] Create `@flowai/dashboard` using the design system from `docs/ui-update/`
- [ ] Overview, Agents, Tasks, Knowledge pages
- [ ] Embed RuntimeScope telemetry views
- [ ] Real-time WebSocket updates for task progress
- [ ] Workflow builder integration (embed existing XYFlow editor)

### Phase 4: Production (2-3 weeks)
- [ ] Deploy orchestrator on Cloudflare Workers
- [ ] Vector search via Cloudflare Vectorize
- [ ] Multi-user support (Supabase auth already partially built)
- [ ] Agent health monitoring and auto-restart
- [ ] Deploy agent (Cloudflare, Vercel integration)

---

## 9. Tech Stack Decisions

| Concern | Decision | Rationale |
|---------|----------|-----------|
| Orchestrator runtime | Cloudflare Workers | Already using D1/R2/KV, Hono is shared |
| Knowledge storage | SQLite/D1 + FTS5 | Consistent with existing stack, D1-compatible |
| Vector embeddings | Cloudflare Vectorize (phase 4) | Native Workers integration |
| Dashboard framework | React + Vite | Same as RuntimeScope, shared design system |
| Agent communication | HTTP + WebSocket | Existing pattern from `@flowai/agent-protocol` |
| LLM integration | Claude API via `@anthropic-ai/sdk` | Primary AI provider |
| Design system | Shared tokens.css + shell.js | Already built in `runtime-profiler/docs/ui-update/` |

---

## 10. Open Questions

1. **Should the workflow builder be embedded in AgentOS or stay standalone?**
   - Embedding = simpler UX, one app to manage everything
   - Standalone = FlowAI keeps its identity, can be used without AgentOS
   - Recommendation: **Both** — the builder works standalone AND can be embedded as a React component

2. **Where does the orchestrator run?**
   - Option A: In-process with the desktop agent (local development)
   - Option B: On Cloudflare Workers (production, shared)
   - Recommendation: **Both** — local mode for dev, Workers for production

3. **How do agents authenticate with RuntimeScope?**
   - Option A: Shared API key (simple)
   - Option B: Per-agent tokens (more secure, auditable)
   - Recommendation: **Start with shared key**, move to per-agent tokens in Phase 4

4. **Should the KB support real-time code indexing?**
   - Watching file system for changes and re-indexing
   - vs. Manual re-index on demand
   - Recommendation: **Manual first**, file watcher in Phase 4

---

## 11. File Structure After Implementation

```
flowAI/
├── packages/
│   ├── core/                    # (exists) Workflow DSL types
│   ├── runner/                  # (exists) Workflow executor
│   ├── agent-protocol/          # (exists, extended) HTTP API contract
│   ├── mcp-server/              # (exists) MCP for Claude Code
│   ├── runtime-desktop/         # (exists) Puppeteer runtime
│   ├── runtime-docker/          # (exists) Playwright runtime
│   ├── runtime-cloudflare/      # (exists) Workers runtime
│   │
│   ├── agents/                  # NEW — Agent definitions
│   ├── knowledge/               # NEW — Knowledge base
│   ├── orchestrator/            # NEW — Task routing + planning
│   └── dashboard/               # NEW — AgentOS control board
│
├── agents/
│   ├── desktop/                 # (exists) Tauri agent → registers with orchestrator
│   └── docker/                  # (exists) Docker agent → registers with orchestrator
│
├── extension/                   # (exists) Chrome extension, unchanged
├── client/                      # (exists) Web app → may merge into dashboard
├── cloud/worker/                # (exists) Cloudflare deployment
├── shared/core/                 # (exists) Shared types
└── docs/
    ├── AGENT-OS-SCOPE.md        # This document
    └── design-system.html       # Portable design reference
```

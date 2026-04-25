---
name: runtimescope
description: Use when the user asks about RuntimeScope, mentions runtime monitoring, asks to capture network/console/renders/queries/Web Vitals from a running app, references ws://localhost:6767 or the RuntimeScope dashboard, wants to install or configure the RuntimeScope SDK, manage workspaces or API keys, start/stop the collector as a background service, or the project contains a .runtimescope/config.json file. Also trigger when the user invokes any /runtimescope:* command or asks to diagnose a live app's behavior.
---

# RuntimeScope

RuntimeScope is an MCP server that captures live telemetry from a running app — network, console, state, renders, Web Vitals, DB queries, server metrics, breadcrumbs, custom events — and exposes it as 63 MCP tools under the `mcp__runtimescope__*` namespace.

Data flow: **SDK (in the user's app) → Collector (ws://localhost:6767) → MCP tools → Claude Code**. The MCP server and collector run in the same Node process by default, but the collector can also run as a persistent background service (launchd/systemd) so multiple Claude Code sessions share one buffer.

## When to reach for RuntimeScope tools

| User intent | Tool |
|---|---|
| Set up monitoring on a new project | `mcp__runtimescope__setup_project` |
| Wait for SDK to connect after start | `mcp__runtimescope__wait_for_session` |
| Quick health snapshot | `mcp__runtimescope__runtime_qa_check` |
| "What's wrong with my app?" | `mcp__runtimescope__detect_issues` |
| Inspect HTTP traffic | `mcp__runtimescope__get_network_requests` |
| Inspect console / errors | `mcp__runtimescope__get_console_messages` |
| Slow renders / React perf | `mcp__runtimescope__get_render_profile` |
| Core Web Vitals | `mcp__runtimescope__get_performance_metrics` |
| Slow DB queries / N+1 | `mcp__runtimescope__get_query_performance` |
| Trail of user actions before a bug | `mcp__runtimescope__get_breadcrumbs` |
| Custom analytics events | `mcp__runtimescope__get_custom_events` |
| End-to-end flow (UI → API → DB) | `mcp__runtimescope__get_event_flow` |
| "Is the SDK connected?" | `mcp__runtimescope__get_session_info` |
| Start/stop the collector process | `mcp__runtimescope__start_collector` / `stop_collector` |
| Workspaces & API keys | `list_workspaces`, `create_workspace`, `move_project_to_workspace`, `create_workspace_api_key` |

A connected SDK is a prerequisite for every data-reading tool. If a tool returns "no session," call `get_session_info` and — if no app is running — either prompt the user to start their dev server or call `wait_for_session` to block until one connects.

## The one-projectId invariant (critical)

Every SDK in a project — browser, server, worker — **must share the same `projectId`**. The source of truth is `.runtimescope/config.json` at the repo root. Violating this is the #1 cause of silent telemetry bugs.

Rules:
- Browser SDK init **must** include `projectId` inline — browsers can't read the config file.
- Server SDK reads `.runtimescope/config.json` automatically if `projectId` is omitted.
- Workers SDK **must** include `projectId` inline — Workers have no filesystem.
- A monorepo has **one** `.runtimescope/config.json` at the root, not one per app.
- Never hardcode a projectId in committed source; always read from the config file when generating init code.

After any setup or config change, call `get_session_info` (or `wait_for_session`) and verify every connected app reports the same `projectId`.

## Setup flow

Always prefer `/runtimescope:setup` or the `setup_project` tool over manual instructions — it auto-detects the framework, scaffolds `.runtimescope/config.json`, picks the right package (framework-specific when available), and generates the init snippet.

**Never** restart, kill, or modify the user's dev server during setup. Only scaffold files and generate snippets; the user starts their own app.

If `setup_project` is unavailable (older MCP versions), fall back to:
1. Detect framework from `package.json` / `wrangler.toml` / `pyproject.toml`.
2. Pick the right package (see SDK guides below — Next.js, Remix, SvelteKit, Vite, and Python all have dedicated packages).
3. Call `get_sdk_snippet` with `{ app_name, framework, project_id }`.
4. Paste the returned snippet into the user's entrypoint.

## Running the collector as a background service

By default the collector lives inside the MCP server process — it dies when Claude Code exits, losing the event buffer. For persistent monitoring, install it as an OS service (launchd on macOS, systemd on Linux):

```bash
npx runtimescope service install   # installs and starts the service
npx runtimescope status            # check health
npx runtimescope doctor            # diagnose port conflicts, SDK connectivity
npx runtimescope service logs      # tail service logs
npx runtimescope service update    # pull the newest published version
```

MCP-side equivalents: `start_collector` and `stop_collector` tools. Use these when you need to confirm the collector is alive, restart it, or kick it after a port change.

Only one process can bind ports 6767/6768 — if the background service is running, don't also run the MCP-embedded collector. `doctor` flags this.

## Workspaces (multi-tenant collectors)

Workspaces separate projects by tenant in hosted/shared collectors. A workspace owns an API key; the SDK authenticates by embedding that key as the **password component of the DSN** (e.g. `https://proj_abc:wsk_secret@collector.example.com/1`).

When to touch workspace tools:
- User is running a shared / hosted collector (not the default local one).
- User wants to separate staging from production telemetry.
- User mentions "API key", "workspace", or sees an auth error from the collector.

Relevant MCP tools: `list_workspaces`, `create_workspace`, `move_project_to_workspace`, `create_workspace_api_key`. Details in [workspaces.md](workspaces.md).

For single-user local dev, workspaces are transparent — ignore unless the user asks.

## SDK-specific guidance

Only load these when the detected stack matches — don't front-load all three.

- **Browser apps** (React, Vue, Svelte, vanilla): see [browser.md](browser.md)
- **Server apps** (Node, Express, Next.js, Remix, SvelteKit, Vite, Python, Django, Flask, Rails, PHP): see [server.md](server.md)
- **Cloudflare Workers / edge**: see [workers.md](workers.md)
- **Workspaces, API keys, hosted collectors**: see [workspaces.md](workspaces.md)

## Slash commands bundled with this plugin

All commands live under `/runtimescope:*`. The most-used:

- `/runtimescope:setup` — install the SDK end-to-end
- `/runtimescope:diagnose` — full-stack health report
- `/runtimescope:network` / `:queries` / `:renders` / `:api` — targeted audits
- `/runtimescope:trace` — reproduce a user flow and analyze the causal chain
- `/runtimescope:devops` — processes, ports, build/deploy status
- `/runtimescope:onboard` — orient a fresh Claude instance to the project

Use `/help` for the full list.

## Ports and environment

- WebSocket collector: `ws://localhost:6767` (env: `RUNTIMESCOPE_PORT`)
- HTTP API: `http://localhost:6768` (env: `RUNTIMESCOPE_HTTP_PORT`)
- Dashboard: `http://localhost:3200` (start with `npm run dashboard` in the runtimescope repo)
- Ring buffer size: 10,000 events (env: `RUNTIMESCOPE_BUFFER_SIZE`)
- DSN: `RUNTIMESCOPE_DSN` (production / hosted collectors)

The defaults migrated from 9090/9091 → 6767/6768 in v0.10.0. Older docs may still reference the old ports — trust the env vars, not stale docs.

## Never-do list

- Don't tell a user RuntimeScope is incompatible with their stack. `get_sdk_snippet` generates install code for any framework (incl. Python, Rails, PHP, WordPress).
- Don't omit `projectId` from browser or Workers init.
- Don't create multiple `.runtimescope/config.json` files in a monorepo.
- Don't restart the user's dev server as part of setup.
- Don't hardcode a projectId in committed source — read from the config file.
- Don't run two collectors at once (background service + MCP-embedded). Use `doctor` to check.

## Verification after any setup or config change

1. `get_project_config` — confirm the config file is valid.
2. `wait_for_session` — block until the SDK actually connects (better than polling `get_session_info`).
3. `get_session_info` — every app reports the same `projectId`.
4. `runtime_qa_check` — one-call health snapshot.

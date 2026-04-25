# RuntimeScope — Claude Code Plugin

Runtime monitoring for Claude Code. Captures live telemetry from your running app (network, console, state, renders, Web Vitals, DB queries, server metrics, breadcrumbs, custom events) and exposes it to Claude as 63 MCP tools.

**One install**: registers the MCP server, ships 23 slash commands, and teaches Claude the one-projectId invariant, workspaces, and background-collector management.

## Install

### From the RuntimeScope marketplace

```bash
/plugin marketplace add runtimescope/marketplace
/plugin install runtimescope@runtimescope
```

### From a local checkout (development)

```bash
/plugin marketplace add /path/to/runtimescope/plugin
/plugin install runtimescope@runtimescope
```

That's it. The plugin:

1. Registers the `@runtimescope/mcp-server` via `.mcp.json` (auto-installed via `npx`).
2. Loads the `runtimescope` skill so Claude knows when and how to use the tools.
3. Exposes 23 slash commands under `/runtimescope:*`.

Verify installation:

```
/help
```

You should see `/runtimescope:setup`, `/runtimescope:diagnose`, `/runtimescope:network`, and the rest.

## Quickstart

**One-time per machine** (run once, ever):
1. Run `/runtimescope:install` — installs the global CLI, registers the collector as a launchd/systemd background service so it persists across reboots, and verifies the MCP server is wired up. Takes ~30s on a clean machine.

**Per project** (run in each project you want to monitor):
2. Open the project directory.
3. Run `/runtimescope:setup` — Claude detects the framework, scaffolds `.runtimescope/config.json`, installs the right SDK package, and generates the correct init snippet.
4. Start your dev server.
5. Run `/runtimescope:diagnose` for a full health report, or ask Claude questions like "What's slow about this app?" or "Show me failing network requests."

**Maintenance** (run any time):
- `/runtimescope:update-all` — finds every project on this machine that has RuntimeScope installed and bumps everything (CLI, service, MCP, plugin, every project's `@runtimescope/*` packages) to the latest version in one pass.

## What's inside

### MCP server (63 tools)

Registered automatically. Categories:
- **Session** (3): get_session_info, wait_for_session, clear_events
- **Network / console / errors** (4): get_network_requests, get_console_messages, get_errors_with_source_context, detect_issues
- **Performance** (2): get_performance_metrics, get_render_profile
- **State / timeline / custom events** (5): get_state_snapshots, get_event_timeline, get_breadcrumbs, get_custom_events, get_event_flow
- **DOM / HAR** (2): get_dom_snapshot, capture_har
- **API discovery** (5): catalog, health, docs, service map, changes
- **Database** (7): query log, query performance, schema, table data, mutate, connections, index suggestions
- **Process monitor** (5): dev processes, kill, port usage, purge caches, restart dev server
- **Infrastructure** (4): deploy logs, runtime logs, build status, overview
- **Session diff** (4): create/get snapshot, compare, history
- **Scanner + setup** (4): scan_website, get_sdk_snippet, get_project_config, setup_project
- **Recon** (9): page metadata, design tokens, layout, fonts, a11y, assets, computed styles, element snapshot, style diff
- **History** (2): historical events, list projects
- **QA** (1): runtime_qa_check
- **Collector control** (2): start_collector, stop_collector
- **Workspaces** (4): list_workspaces, create_workspace, move_project_to_workspace, create_workspace_api_key

### Slash commands (17)

**Lifecycle**: `install`, `setup`, `update-all`, `update-runtime`, `fix-config`.
**Diagnose**: `diagnose`, `network`, `queries`, `renders`, `api`, `devops`, `trace`.
**Capture**: `events`, `snapshot`, `history`.
**UI**: `recon`, `clone-ui`.

All under the `/runtimescope:` namespace.

### Skill

`skills/runtimescope/SKILL.md` — triggers whenever the user asks about runtime monitoring, references `ws://localhost:6767`, or the project has `.runtimescope/config.json`. Contains the one-projectId invariant, setup flow, background-collector management, and workspaces overview. Stack-specific guidance lives in sibling files loaded only when relevant:

- `browser.md` — `@runtimescope/sdk` (vanilla browser init)
- `server.md` — framework packages (`@runtimescope/nextjs`, `remix`, `sveltekit`, `vite`) + `@runtimescope/server-sdk` + Python (`runtimescope` on PyPI)
- `workers.md` — `@runtimescope/workers-sdk` for Cloudflare Workers / edge
- `workspaces.md` — multi-tenant workspaces, DSN auth, API key management

## Prerequisites

- **Node.js 20+** on the user's machine (for `npx` to run the MCP server).
- **Port 6767** (WebSocket) and **6768** (HTTP) free on localhost. Override via `RUNTIMESCOPE_PORT` / `RUNTIMESCOPE_HTTP_PORT`. (Defaults migrated from 9090/9091 in v0.10.0.)

## Background collector (optional)

By default the collector lives inside the MCP server and dies when Claude Code exits. For persistent telemetry across sessions, install it as an OS service:

```bash
npx runtimescope service install   # launchd on macOS, systemd on Linux
npx runtimescope status
npx runtimescope doctor            # diagnose ports, connectivity
```

Only one collector can bind the WebSocket port at a time — don't run the background service and the MCP-embedded collector simultaneously. `doctor` flags this.

## The one-projectId invariant

Every SDK in a project — browser, server, worker — **must share the same `projectId`**. The source of truth is `.runtimescope/config.json` at the repo root. The skill teaches Claude to enforce this; most setup bugs come from violating it.

## Links

- Main repo: https://github.com/runtimescope/runtimescope
- SDK packages on npm: `@runtimescope/sdk`, `@runtimescope/server-sdk`, `@runtimescope/workers-sdk`, `@runtimescope/mcp-server`
- Issues: https://github.com/runtimescope/runtimescope/issues

## License

MIT

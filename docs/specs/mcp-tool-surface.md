# MCP tool surface — catalog

> **Status:** Locked by Phase Wire-Protocol-Lock, shipped as v0.10.13. (v0.11.0 is reserved for the Rust collector.)
> **63 tools across 34 files** (`grep -c "server\.tool(" packages/mcp-server/src/tools/*.ts`). Each tool's authoritative input schema is its `zod` definition in code; this doc is a static **index**, not a re-specification. The MCP stdio JSON-RPC contract (tools/list + tools/call envelope) is guarded by [`tests/conformance/specs/mcp-tools.conformance.test.ts`](../../tests/conformance/specs/mcp-tools.conformance.test.ts).

> ⚠️ The mcp-server's startup log still prints "55 tools" — that string is **stale**; the real count is 63. Fix it during Phase Rust-Collector.

**Every tool returns the same envelope** (validated by conformance): a single text content block whose body is JSON:

```json
{ "summary": "human-readable one-liner",
  "data": { /* tool-specific */ },
  "issues": ["..."],
  "metadata": { "timeRange": {"from","to"}, "eventCount": 0, "sessionId": null, "projectId": null } }
```

Most read tools accept an optional `project_id` (the `proj_xxx` from `.runtimescope/config.json`) to scope results.

---

## Core (read the captured event stream)

| Tool | File |
|---|---|
| `get_network_requests` | network |
| `get_console_messages` | console |
| `get_state_snapshots` | state |
| `get_render_profile` | renders |
| `get_performance_metrics` | performance |
| `get_event_timeline` | timeline |
| `get_errors_with_source_context` | errors |
| `get_breadcrumbs` | breadcrumbs |
| `detect_issues` | issues |
| `capture_har` | har |
| `get_session_info`, `wait_for_session`, `clear_events` | session |
| `runtime_qa_check` | qa-check |
| `get_dom_snapshot` 🔌 | dom-snapshot |

## Custom events

| Tool | File |
|---|---|
| `get_custom_events`, `get_event_flow` | custom-events |

## API discovery

| Tool | File |
|---|---|
| `get_api_catalog`, `get_api_health`, `get_api_documentation`, `get_service_map`, `get_api_changes` | api-discovery |

## Database

| Tool | File |
|---|---|
| `get_query_log`, `get_query_performance`, `get_schema_map`, `get_table_data`, `modify_table_data`, `get_database_connections`, `suggest_indexes` | database |

## Process / dev environment

| Tool | File |
|---|---|
| `get_dev_processes`, `get_port_usage`, `kill_process`, `purge_caches`, `restart_dev_server` | process-monitor |

## Infrastructure

| Tool | File |
|---|---|
| `get_deploy_logs`, `get_runtime_logs`, `get_build_status`, `get_infra_overview` | infra-connector |

## Sessions / history / snapshots

| Tool | File |
|---|---|
| `compare_sessions`, `get_session_history`, `create_session_snapshot`, `get_session_snapshots` | session-diff |
| `get_historical_events`, `list_projects` | history |

## Setup / config / collector lifecycle

| Tool | File |
|---|---|
| `setup_project` | setup |
| `get_project_config`, `get_sdk_snippet` | scanner |
| `start_collector`, `stop_collector` | collector-control |

## Workspaces

| Tool | File |
|---|---|
| `create_workspace`, `list_workspaces`, `create_workspace_api_key`, `move_project_to_workspace` | workspaces |

## Recon (page/DOM analysis)

| Tool | File |
|---|---|
| `get_page_metadata` | recon-metadata |
| `get_design_tokens` | recon-design-tokens |
| `get_layout_tree` 🔌 | recon-layout |
| `get_font_info` | recon-fonts |
| `get_accessibility_tree` | recon-accessibility |
| `get_computed_styles` 🔌 | recon-computed-styles |
| `get_element_snapshot` 🔌 | recon-element-snapshot |
| `get_asset_inventory` | recon-assets |
| `get_style_diff` | recon-style-diff |

## Scanner

| Tool | File |
|---|---|
| `scan_website` 🎭 | scanner |

---

## 🎭 / 🔌 — Rust-port porting hazards

- **🎭 Playwright dependency.** `scan_website` drives a headless browser via Playwright (`playwright` is a hard dep of `mcp-server`). **There is no clean Rust equivalent** — this is the single biggest mcp-server porting hazard. Resolve per the Phase Rust-Collector handoff (Hard Spot #1) and ADR-0007: recommended path is a **Node sidecar** the Rust mcp-server spawns on demand, isolating the one tool that genuinely needs a JS browser engine.
- **🔌 Command-channel dependency.** These tools trigger an on-demand capture by sending a server→SDK `command` and awaiting the `command_response` (see [`wire-protocol.md` §5](./wire-protocol.md)). They only work with a live, connected SDK/extension. **Mechanism resolved ([ADR-0008](../decisions/0008-rust-mcp-embeds-collector-core.md)):** the Rust `mcp-server` embeds `collector-core` in-process, so `send_command` stays in-process — no bridge.
- The remaining ~50 tools are **pure store reads** — once the Rust `Store` query API exists, they're mechanical and parallelizable (Phase Rust-Collector Milestone 3 fan-out).

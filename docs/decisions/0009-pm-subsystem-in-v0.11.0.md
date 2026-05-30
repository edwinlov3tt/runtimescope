# ADR-0009: Port the `pm/` subsystem into v0.11.0 (not a fast-follow)

- **Date**: 2026-05-30
- **Status**: Accepted

## Context

The Rust collector port (v0.11.0) reached the point where everything except the
`pm/` project-manager subsystem (M5) is done — M1–M4 complete, conformance at
68/68 vs Node AND Rust. The open question was whether `pm/` (~4.4K LOC) is a
launch blocker or a post-launch fast-follow.

A grounded investigation of the Node source established that **`pm/` is orthogonal
to the core monitoring loop**:
- SDK connect → event ingest → WAL+SQLite persist → MCP read tools → Claude all
  run with `pmStore == null` (consulted only for optional workspace assignment).
- Auth works via `RUNTIMESCOPE_AUTH_TOKEN` / config.json; pm/-managed workspace
  API keys (`tk_xxx`) are one of two accepted token sources, not the only one.
- Only 4 tools are pm/-backed (`list_workspaces`, `create_workspace`,
  `move_project_to_workspace`, `create_workspace_api_key`).
- `pm/` provides: multi-tenant workspaces, workspace-scoped API keys, project
  discovery, Claude-Code session-transcript parsing (cost/token/**CapEx**
  accounting), and the dashboard's `/api/pm/*` project-management UI.

So deferring was technically safe (v0.10.13 stays installable for anyone needing
pm/ features until a v0.11.1 fast-follow). The choice was a product call.

## Decision

**Include `pm/` in v0.11.0** — full Node parity at cutover, no temporary feature
regression for workspaces / API-keys / CapEx / session-cost analysis. The path to
launch is **M5 → M6 → M7** (M5 back on the critical path, serial).

## Material caveat surfaced by the investigation

**`pm/` has essentially no test coverage in Node** — no tests reference `pmStore`,
`session-parser`, `project-discovery`, `createApiKey`, or CapEx. The roadmap's
assumption ("port with the existing TS tests as the behavioral spec") does not
hold. Consequences for M5:

- The port is **conformance-first**: write `*.conformance.test.ts` specs against
  the **Node `pm/`** first (green-vs-Node), characterizing the currently-untested
  behavior, *then* make Rust pass them — same discipline as audit 0002. These
  specs double as the missing Node characterization tests and the Rust port spec.
- Gateable surfaces: the 4 workspace MCP tools (via `McpDriver`) and the
  `/api/pm/*` HTTP routes (via `spawnCollector` + fetch). `session-parser` /
  `project-discovery` are internal but observable end-to-end through those routes
  (discover → list → assert), plus targeted Rust unit tests for the parser's
  edge cases (cost/token/active-time/compaction extraction from JSONL).
- This **raises the M5 estimate** beyond the original "~1.5 wk / 2–4 sessions":
  characterizing 4.4K LOC of untested, stateful logic before porting is the bulk
  of the work, and `session-parser` has many edge cases.

## Consequences

- **Positive**: v0.11.0 = full feature parity; clean single-cutover deprecation of
  Node; the untested Node `pm/` finally gets a behavioral spec (net quality win).
- **Negative**: longest, riskiest, most-serial milestone; no fan-out (stateful +
  interconnected); pushes launch out by the M5 duration.
- **Revisit trigger**: if M5 characterization reveals `pm/` behavior that's buggy
  or unused in Node, narrow the port scope (port what's real, mark the rest) rather
  than faithfully replicating dead/broken paths — same lesson as the dormant
  DB/infra engines.

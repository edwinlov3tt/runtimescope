# ADR-0011: Remote MCP over Streamable HTTP (coding agents reach a deployed app)

**Status:** `Proposed`
**Date:** 2026-06-02
**Deciders:** Edwin (owner) + implementing instance
**Phase:** `Deploy & Remote-MCP`

---

## Context

A coding agent today can only see the runtime of an app whose collector is on the
**same machine**. The MCP server is **stdio-only** (`crates/mcp-server/src/lib.rs:154`,
`serve(stdio())`) and every tool reads the **in-process `StoreHandle`** — there is
no HTTP client and no `RUNTIMESCOPE_COLLECTOR_URL`. So an agent on a laptop reads
the laptop's `collector.db`, never a deployed app's.

We want: *an agent (Claude Code, Claude.ai/Desktop) inspecting a **deployed**
app's live runtime* — network, console, renders, issues — through the same MCP
tools, against the collector running on the droplet (ADR-0010).

Current remote-MCP standard (verified this turn):
- Transport is **Streamable HTTP** (MCP protocol `2025-06-18`): served at root
  `/`, session management, HEAD for discovery. **SSE is being deprecated.**
- Auth is **OAuth 2.1** (Authorization Code + PKCE, dynamic client registration,
  protected-resource metadata) — or a pre-obtained bearer `authorization_token`
  via the MCP connector API. Claude's OAuth callback is
  `https://claude.ai/api/mcp/auth_callback`.
- The Rust MCP SDK (`rmcp`) supports a streamable-HTTP server transport, so this
  is additive to the existing stdio path, not a rewrite.

Constraint from ADR-0008: the MCP server **embeds collector-core in-process** and
the M-cutover added an **attach mode** (this project, earlier) so a second MCP
instance reads the standalone collector's shared `collector.db`. That means a
remote MCP on the droplet already has a populated store to read from.

## Decision

**Add a Streamable HTTP transport to the MCP server, gated by OAuth 2.1 / bearer,
and run it on the droplet behind the ADR-0010 tunnel.** stdio stays the default
for local use; remote is opt-in.

**What we are doing:**

- Add a **Streamable HTTP** server transport (rmcp) alongside `stdio`, selected by
  config/env (e.g. `RUNTIMESCOPE_MCP_TRANSPORT=stdio|http`, bind from
  `RUNTIMESCOPE_HOST`/a dedicated MCP port). Same `Mcp` handler + combined
  `tool_router` — transport-only change.
- **Reuse the embedded/attached collector**: the remote MCP reads the droplet's
  shared store (ADR-0008 + attach mode). No per-tool HTTP rewrite.
- **Require auth** on the remote transport: OAuth 2.1 (preferred for Claude.ai
  custom connectors) and/or a bearer token reusing the existing `AuthManager` /
  workspace `tk_` keys (`auth.rs`). The transport is **never** exposed
  unauthenticated.
- Expose it through the ADR-0010 tunnel (Cloudflare Tunnel / Access), so a coding
  agent adds it as a **custom connector** (remote MCP URL) and authenticates.
- Document the agent-side setup (Claude Code `claude mcp add` remote / Claude.ai
  connector) pointing at the deployed URL.

**What we are explicitly NOT doing:**

- **Not** building Option B (a *local* MCP that calls a remote collector's HTTP
  read API). Too much tool logic (`detect_issues`, API catalog, timeline) runs
  in-process over the store, not via HTTP endpoints — it would mean an
  HTTP-backed store adapter or duplicating analysis. Rejected as more invasive
  for less capability.
- **Not** implementing the deprecated **SSE** transport.
- **Not** exposing the MCP transport without auth, ever.

## Consequences

**Positive:**

- A coding agent can inspect a **deployed** app's runtime through the full MCP
  tool surface, remotely, with the same envelopes.
- Additive: stdio (local) is unchanged; the collector + tools are reused as-is.
- Auth reuses the existing token/workspace machinery.

**Negative / accepted trade-offs:**

- A new internet-exposed control surface — OAuth/bearer correctness is now
  security-critical (constant-time, scope checks, token refresh). Must be tested
  like the ingest auth was.
- **Command-channel tools** (`capture_dom_snapshot`, future `show_survey`) only
  work when a live SDK is connected to *that* collector's WS — true for the
  deployed app, but a remote agent can't drive an SDK that isn't connected there.
  Pure read tools are unaffected.
- Streamable HTTP session/lifecycle handling adds transport complexity vs stdio.

**Reversal cost:** Cheap-to-moderate. The transport is opt-in and isolated; remove
the HTTP path and stdio remains. The auth model, once consumers (connectors)
depend on it, is harder to change — pick OAuth scopes/claims carefully up front.

## Alternatives considered

1. **Option B — local MCP → remote read API.** Keep stdio, point tools at a
   remote collector over HTTP. Rejected: in-process analysis tools would need a
   full HTTP store adapter; high effort, partial capability.
2. **SSE transport.** The older remote-MCP transport. Rejected — deprecating in
   favor of Streamable HTTP; no reason to build legacy.
3. **VPN / SSH tunnel + stdio.** Run stdio MCP and reach it over a network tunnel.
   Works for one power user but doesn't fit Claude.ai/Desktop custom connectors
   and isn't a product-grade story. Rejected as the primary path (still possible
   ad hoc).
4. **Bearer-only (no OAuth).** Simpler, but Claude.ai custom connectors expect an
   OAuth flow; bearer suits API/headless use. Decision: support both, OAuth for
   interactive connectors.

## Cross-links

- Depends on: [`./0010-self-hosted-deployment-topology.md`](./0010-self-hosted-deployment-topology.md)
  (the tunnel + host this rides on).
- Builds on: [`./0008-rust-mcp-embeds-collector-core.md`](./0008-rust-mcp-embeds-collector-core.md)
  (in-process store the remote MCP reads), plus this project's MCP **attach mode**.
- Source: [`../../crates/mcp-server/src/lib.rs`](../../crates/mcp-server/src/lib.rs)
  (transport), [`../../crates/collector-core/src/auth.rs`](../../crates/collector-core/src/auth.rs).
- External: MCP Streamable HTTP + remote-server spec; Claude custom-connector /
  MCP-connector docs (see this turn's sources).

## Notes

Sequence after ADR-0010 — the transport is only useful once there's a deployed
collector to attach to. Settle the WS-routing/DSN single-443 detail (ADR-0010
Notes) alongside, since the deployed SDK and the remote MCP both need consistent
endpoint resolution through the tunnel.

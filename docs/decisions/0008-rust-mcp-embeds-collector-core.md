# ADR-0008: The Rust mcp-server embeds collector-core in-process; the command channel stays in-process

**Status:** Accepted
**Date:** 2026-05-29
**Deciders:** Project owner + implementing instance
**Phase:** Rust-Collector (Milestone 0)

---

## Context

[`wire-protocol.md` §5](../specs/wire-protocol.md) flagged an open question for the Rust port: the server→SDK **command channel** (`capture_dom_snapshot`, `capture_performance_metrics`, `clear_renders`, recon captures) is triggered today by an MCP tool calling `collector.sendCommand(sessionId, …)` **in-process** — the Node `mcp-server` embeds the collector (`CollectorServer`) in the same process and shares its `EventStore`. ADR-0002's crate layout lists `collector-server` and `mcp-server` as separate **crates/bins**, which raised the worry that the Rust split would put them in separate **processes**, breaking the in-process `sendCommand` path (an `mcp-server` process can't reach the WS connections held by a different `collector-server` process without an IPC bridge).

How the current Node system actually behaves (read at [`packages/mcp-server/src/index.ts:222–262`](../../packages/mcp-server/src/index.ts#L222)):

- `mcp-server` **always starts its own in-process `CollectorServer`** (WS + HTTP) and reads from *that* instance's `EventStore`.
- If a standalone collector (the launchd daemon, for the tray/dashboard) is already on `:6768`, `mcp-server` does **not** attach to it and does **not** kill it — it binds **alternate ports** and runs its own collector. SDKs that want their events visible to MCP tools connect to the MCP server's WS port (logged at startup); the launchd daemon backs the tray.
- This is why the command channel works: the MCP tool, the `EventStore` it reads, and the SDK's WS connection are all **in one process**.

The [conformance MCP test](../../tests/conformance/specs/mcp-tools.conformance.test.ts) validated exactly this topology — it spawns `mcp-server`, connects an SDK to *its* WS port, and the `capture_dom_snapshot` round-trip succeeds in-process.

## Decision

**Crates are separate; processes are not (when MCP is active). The Rust `mcp-server` bin links `collector-core` and runs its own embedded collector (WS + HTTP) in-process — exactly as the Node `mcp-server` does today. The command channel stays an in-process call; no cross-process bridge is built.**

- `crates/collector-core` — the shared library (store, WAL, WS/command machinery, engines). Linked by both bins.
- `crates/collector-server` — the standalone daemon bin (launchd / `runtimescope service`). WS + HTTP + dashboard. No MCP. This is the tray's backend.
- `crates/mcp-server` — links `collector-core`, **embeds a collector instance in-process**, and adds the stdio MCP tool surface. MCP tools call the in-process `Store` and the in-process `send_command(...)`.
- "Separate crates" (ADR-0002) means **separate compilation units / binaries with clean library boundaries**, not separate OS processes for the command channel.

The Rust `mcp-server` replicates the Node embed-vs-detect behavior: detect an existing healthy collector on the default ports; if present, bind alternate ports for its own embedded collector (and skip the heavy startup recovery, per the boot-time fix the Node version already has); otherwise take the default ports.

## Consequences

**Positive:**
- The command channel needs **no new IPC/bridge** — the highest-risk part of §5's open question evaporates. The Rust `send_command` is an in-process `await` on the embedded collector's WS connection map, mirroring the Node `pendingCommands`/`requestId` correlation.
- Preserves the exact observable behavior the conformance suite pins. The Rust port's acceptance gate doesn't change.
- Honors ADR-0002's crate layout (both bins link core) without over-reading it as a process-separation mandate.

**Negative / accepted:**
- Carries forward the existing **"two stores" characteristic**: when the launchd daemon and an MCP-spawned collector both run, they hold separate in-memory stores on different ports, and SDK events are only visible to whichever collector the SDK connected to. This is a pre-existing trait of the Node system, not introduced by the port. The port's job is behavioral equivalence; **improving this (e.g. a true attach-mode where MCP queries the daemon's store over the wire) is explicitly out of scope** for v0.11.0 and would be its own ADR.
- `collector-core` must expose its WS/command internals as a library API the `mcp-server` bin can drive — a slightly larger public surface for the core crate than if it were daemon-only. Acceptable and natural.

**Reversal cost:** medium. If a future version wants real attach-mode (one shared store across daemon + MCP), that's a new transport between the bins — a contained, ADR-worthy change behind the same tool interface.

## Cross-links

- The open question this closes: [`../specs/wire-protocol.md` §5](../specs/wire-protocol.md).
- Crate layout: [`./0002-rust-port-sequence-and-distribution.md`](./0002-rust-port-sequence-and-distribution.md).
- Current behavior read from: [`packages/mcp-server/src/index.ts`](../../packages/mcp-server/src/index.ts) (embed-vs-detect, `skipRecovery`), [`packages/collector/src/server.ts`](../../packages/collector/src/server.ts) (`sendCommand`, `pendingCommands`).
- Validated topology: [`../../tests/conformance/specs/mcp-tools.conformance.test.ts`](../../tests/conformance/specs/mcp-tools.conformance.test.ts).

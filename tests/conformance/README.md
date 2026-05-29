# Conformance suite — the executable wire-protocol contract

These tests **are** the contract the RuntimeScope collector must honor ([ADR-0006](../../docs/decisions/0006-conformance-tests-are-the-spec.md)). They pass against the Node collector today and become the **acceptance gate for the Rust port** (Phase Rust-Collector) — unchanged.

```bash
npm run conformance          # run against the Node collector (default)
```

## Running against a different collector binary

The suite launches the collector/mcp-server through a swappable seam — the same one the `stress/` and `bench/` suites use. Point it at any binary that honors `RUNTIMESCOPE_PORT` / `RUNTIMESCOPE_HTTP_PORT` and serves `/readyz`:

```bash
# Rust collector-server (WS + HTTP wire specs)
RUNTIMESCOPE_COLLECTOR_CMD=./target/release/collector-server npm run conformance

# Rust mcp-server (the MCP stdio spec) — set both for a full run
RUNTIMESCOPE_COLLECTOR_CMD=./target/release/collector-server \
RUNTIMESCOPE_MCP_CMD=./target/release/mcp-server \
  npm run conformance
```

`RUNTIMESCOPE_COLLECTOR_CMD` and `RUNTIMESCOPE_MCP_CMD` accept a full command (may include args, e.g. `"cargo run -q --bin collector-server"`).

## What's covered

| Spec | Locks |
|---|---|
| `handshake.conformance.test.ts` | WS handshake → session registered; auth-on → 4001 close within 5s; authed handshake accepted |
| `event-roundtrip.conformance.test.ts` | events sent over WS are queryable over HTTP with fields intact; project isolation |
| `command-channel` (in `mcp-tools`) | server→SDK `capture_dom_snapshot` round-trips by `requestId` |
| `http-contracts.conformance.test.ts` | `/api/health`, `/readyz`, `/metrics`, `/api/sessions`, 404 shape, public/auth gate (401) |
| `durability.conformance.test.ts` | committed events survive SIGKILL + restart (fsync-before-commit) |
| `mcp-tools.conformance.test.ts` | MCP stdio JSON-RPC: tool catalog (≥60), data round-trip, envelope shape |

Invariants are documented (with `file:line` citations) in [`docs/specs/wire-protocol.md`](../../docs/specs/wire-protocol.md) and [`docs/specs/mcp-tool-surface.md`](../../docs/specs/mcp-tool-surface.md). **If a doc and a green test disagree, the test wins.**

## Design notes

- Kept **out** of the `npm test` workspace (`vitest.workspace.ts`): these spawn real processes, so they're slow and run sequentially (`fileParallelism: false`) to avoid port contention.
- The harness re-exports the shared `stress/utils` seam + SDK driver, plus `McpDriver` (stdio JSON-RPC client). One launch contract, three consumers (conformance, stress, bench).
- The MCP driver waits for the `"running on stdio"` stderr marker before sending JSON-RPC — the mcp-server resumes stdin early (parent-death watchdog) but attaches the transport reader last, so frames sent before that are lost.

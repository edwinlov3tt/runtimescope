# Phase Rust-Collector — milestones & agent-team strategy

> Companion to [`../handoffs/phase-rust-collector-handoff.md`](../handoffs/phase-rust-collector-handoff.md). That doc is the *what* and the *contract*; this is the *order* and the *who* (serial vs. agent-team fan-out).

## The governing shape: serial spine → parallel ribs → serial close

A from-scratch Rust port has a hard critical path (everything depends on `collector-core`) but parallel interiors (63 MCP tools, 4 engines, N route handlers are mutually independent). The failure mode of throwing a team at it on day one is **convention drift**: 63 agents inventing 63 error-handling styles, 63 envelope-shaping helpers, 63 ways to call the store — which costs more to reconcile than it saved.

So the rule is: **one coherent author settles the conventions and proves one vertical slice end-to-end. Only then do you fan out.**

```
M0 ─ M1   serial, one author      ← spine + conventions + 1 green slice
M2..M5    fan out (with care)     ← ribs: tools, engines, routes; pm/ as own track
M6 ─ M7   serial, one author      ← close: integrate, gate, embed, cutover
```

## "A lot of sessions?" — yes. Here's the honest shape.

ADR-0002 budgets **~8 weeks**. In Claude-Code working-session terms that's **dozens of sessions**, not a handful. A team compresses *wall-clock* on M2–M5 but not total effort/tokens. M1 and M7 are the make-or-break milestones and want undistracted serial attention. Don't let the team-parallelism tempt you into rushing M1 — a shaky `Store` trait or event-type model poisons everything downstream.

---

## Milestone 0 — Prerequisites & decisions (serial, ~2–3 days) — ✅ COMPLETE (2026-05-29)

**Gate to enter the phase at all.** All four resolved:

- [x] Phase Wire-Protocol-Lock shipped (v0.10.13): `npm run conformance` green against Node — the acceptance gate exists.
- [x] **Playwright strategy → Node sidecar** ([ADR-0007](../decisions/0007-playwright-node-sidecar.md)). `mcp-server` keeps `scan_website` + browser-recon by spawning a lazy Node sidecar; everything else stays pure Rust.
- [x] **`rmcp` 1.7.0 validated** ([research note 0001](../research/0001-rust-foundational-spikes.md)). Throwaway spike served a tool over stdio JSON-RPC with the exact `{summary,data,issues,metadata}` envelope; input schema auto-derives from the Rust struct via `schemars` (the zod replacement). Stable 1.x API.
- [x] **rusqlite concurrency → dedicated DB-owner thread** fed via `mpsc`/`oneshot` ([research note 0001](../research/0001-rust-foundational-spikes.md)). Spike: 5000 concurrent-task inserts, WAL active, ~33k ins/sec. (Mirrors the current single-writer EventStore.)
- [x] **Command-channel mechanism → `mcp-server` embeds `collector-core` in-process** ([ADR-0008](../decisions/0008-rust-mcp-embeds-collector-core.md)). Closes the `wire-protocol.md` §5 open question: separate crates, same process when MCP is active; `send_command` stays in-process — no bridge.

**Team?** No. These were judgment calls + spikes. **Done — proceed to M1.**

## Milestone 1 — Spine: `collector-core` + one vertical slice (serial, ~1 wk) — 🟡 IN PROGRESS

The most important week of the phase. **One author. No fan-out.**

- [x] Workspace `Cargo.toml` + 4 crate skeletons (`collector-core`, `collector-server`, `mcp-server`, `cli`) + CI wiring (`.github/workflows/rust.yml`: `cargo build/clippy -D warnings/test` on macos-14). Built clean first try (axum 0.8.9, rmcp 1.7.0, tokio).
- [x] **Vertical slice GREEN against the Rust binaries, via the same conformance harness that validates Node:**
  - `collector-server`: `event-roundtrip` 2/2 — WS handshake → ingest → `/api/events/network` query → project_id isolation (`RUNTIMESCOPE_COLLECTOR_CMD=…/collector-server npx vitest … event-roundtrip`).
  - `mcp-server`: the `get_network_requests` data round-trip — SDK → embedded in-process collector → MCP tool reads the shared `Store` (`RUNTIMESCOPE_MCP_CMD=…/mcp-server`). Proves the ADR-0008 embed-in-process topology.
- [x] Patterns established by the slice: the `{summary,data,issues,metadata}` envelope, the rmcp `#[tool]` + schemars-arg pattern, the axum route-handler signature, and **the `Store` query seam both HTTP routes and MCP tools call** (`events_by_type`). `collector-core::serve()` is shared by both bins.
- [ ] **Remaining M1:** the full 19 serde event types (slice keeps events as raw `Value`); the `Store` **trait** + the **rusqlite + WAL (fsync-before-commit)** persistence impl behind the dedicated-DB-owner thread (research 0001); auth (the handshake-4001 + HTTP-401 paths); a short written patterns doc.

**Exit criterion:** a second engineer (or agent) could look at the slice + patterns doc and write a new tool/route/engine without asking how. The slice proves the shape; persistence + the type set complete it.

**Team?** No — this is the convention-setting pass by definition.

## Milestone 2 — `collector-server`: WS + HTTP (partial fan-out, ~1.5 wk)

- [ ] WS: handshake (5s auth timeout, close 4001), event-batch ingest, `requestId` command channel. *(Conformance: `handshake`, `command-channel`.)* — **serial, it's stateful.**
- [ ] HTTP router skeleton + the public/auth gate + static dashboard serving. — **serial** (skeleton), then
- [ ] The `/api/*` route handlers. — **fan-out** once the skeleton + `Store` exist; each handler is independent. *(Conformance: `http-contracts`.)*

**Team?** Partial — one author does the WS + router skeleton; route handlers fan out.

## Milestone 3 — `mcp-server`: the 63 tools (heavy fan-out, ~1.5 wk)

The biggest LOC chunk and the most parallelizable.

- [ ] Tool-registration pattern proven in M1; now batch the 63 tools by family (core / api / database / process / infra / session / history / scanner / recon / setup).
- [ ] Each tool: serde input validation → `Store` call → standard envelope. The conformance `mcp-driver` + per-tool smoke is the check.
- [ ] Scanner + browser-recon tools follow the ADR-0007 decision (likely the sidecar — isolate them).

**Team?** **Yes — this is the textbook fan-out.** Batch tools across agents (e.g. 5–8 agents, ~8–12 tools each), each handed the patterns doc + the conformance spec for its family. Reconcile against `cargo clippy` + conformance, not by eyeball.

## Milestone 4 — Engines + native recon (fan-out, ~1 wk)

- [ ] `api-discovery`, `query-monitor`, `process-monitor`, `infra-connector` — mutually independent. Fan out, one agent per engine.
- [ ] Non-browser recon (design tokens, layout from stored events, etc.) where it doesn't need Playwright.

**Team?** Yes — 4 independent engines map cleanly to 4 agents.

## Milestone 5 — `pm/` project-manager subsystem (own serial track, ~1.5 wk)

~4.4K LOC, stateful, interconnected (pm-store, pm-routes, project-discovery, session-parser). **Not rib-shaped** — don't fan out *within* it. But it *can* run as a parallel track to M3–M4 (different author/agent, different subsystem).

- [ ] Port with the existing TS tests as the behavioral spec (session-transcript parsing has many edge cases).

**Team?** One dedicated author/agent for the whole subsystem, running concurrently with the M3–M4 fan-out.

## Milestone 6 — `cli` + curl-install + dashboard embed (serial, ~0.5 wk)

- [ ] Port `service.ts` shell-outs (incl. the new `service stop`) to `std::process::Command`.
- [ ] **New:** `install.sh` + self-update against signed GitHub Releases; `~/.runtimescope/bin` layout; `runtimescope` on PATH.
- [ ] `include_bytes!` the dashboard build output; verify `/dashboard` serves with no `packages/dashboard` on disk.
- [ ] First-run data-wipe warning + `RUNTIMESCOPE_PRESERVE_LEGACY_DATA=1`.

**Team?** No — small, integration-flavored, owner-facing.

## Milestone 7 — Gate, cutover, ship (serial, ~1 wk)

- [ ] Full `npm run conformance` green against the Rust binary.
- [ ] `npm run stress` 7/7; `npm run bench:compare -- node <rust>` within gates (target: Rust beats Node).
- [ ] Signed-binary release workflow + the conformance/bench gate in CI.
- [ ] Delete `packages/collector|mcp-server|cli`; verify git-tag rollback.
- [ ] v0.11.0; deprecate Node packages (final v0.10.13) on npm; completion report; CURRENT_STATE + HANDOFF → Phase SDK-Channel-Migration.

**Team?** No — this is the careful close. One author owns the destructive cutover.

---

## Critical-path / parallelism summary

```
M0 ─▶ M1 ─▶ M2 ─┬─▶ M3 (team) ─┐
                ├─▶ M4 (team) ─┤
                └─▶ M5 (solo, parallel track) ─┴─▶ M6 ─▶ M7
```

- **Serial, no team:** M0, M1, M6, M7 (the spine and the close).
- **Team fan-out:** M3 (63 tools — biggest win), M4 (4 engines), partial M2 (routes).
- **Parallel solo track:** M5 (`pm/`) overlaps M3–M4.

The wall-clock win from a team is concentrated in M3. Everything else is either too serial (spine/close) or already small. So: **invest the team in the 63 tools, after the skeleton is proven — and nowhere before M1 is green.**

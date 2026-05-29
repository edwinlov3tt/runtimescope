# Phase Rust-Collector Handoff — port the collector + mcp-server + cli to Rust (v0.11.0)

> **Audience:** the Claude Code instance(s) executing Phase Rust-Collector.
> **This is the big one — ~8 weeks honest** ([ADR-0002](../decisions/0002-rust-port-sequence-and-distribution.md) §37). Read this whole file, then read [`../roadmap/rust-collector-milestones.md`](../roadmap/rust-collector-milestones.md) for the execution sequence and where to fan out vs. stay serial.
> **Hard prerequisite:** Phase Wire-Protocol-Lock must be **done and green** before you write Rust. Its conformance suite + the bench are your acceptance gate — without them you're porting 24K LOC with no way to know when a piece is correct. If `npm run conformance` doesn't exist yet, stop and finish that phase first.

---

## Why this phase, in one paragraph

The Node collector is sound (v0.10.9 audit closed all five lifetime findings), but the *distribution* is the problem: `npm install -g` + a ~200-dep dashboard build tree is the supply-chain surface [ADR-0002](../decisions/0002-rust-port-sequence-and-distribution.md) exists to kill. Rust gives a single signed binary delivered by `curl | sh`, the dashboard embedded via `include_bytes!`, and no npm CLI ever again. This phase replaces three Node packages with four Rust crates. It ships as **v0.11.0** (the clean number reserved for the Rust cutover per the [ADR-0002 addendum](../decisions/0002-rust-port-sequence-and-distribution.md)); the Node packages stay on npm at **v0.10.13** (Wire-Protocol-Lock, the final Node release) as a git-tagged rollback (deprecate, don't unpublish).

---

## The contract (from ADR-0002 — this is non-negotiable scope)

**Crate layout** ([ADR-0002 §37](../decisions/0002-rust-port-sequence-and-distribution.md)):

```
crates/collector-core      ring buffer, sqlite/WAL, engines, types, redaction, metrics
crates/collector-server    bin: WS + HTTP server, links core
crates/mcp-server          bin: stdio JSON-RPC + the 63 tools, links core
crates/cli                 bin: replaces the runtimescope npm CLI
```

**Hard rules:**
1. **Fresh data, no migration.** First Rust run wipes `~/.runtimescope/` (one-time warning; opt-out `RUNTIMESCOPE_PRESERVE_LEGACY_DATA=1`). You write a *clean* schema in rusqlite — you are NOT byte-compatible with the better-sqlite3 file. This is a feature: it removes the single biggest source of port complexity.
2. **The wire protocol is frozen.** Whatever `docs/specs/wire-protocol.md` + `tests/conformance/` lock is the contract. The Rust collector must pass the conformance suite unchanged. If you think an invariant is wrong, that's an ADR, not a code change.
3. **The dashboard is embedded, not rewritten.** `include_bytes!` the built Vite output from `packages/dashboard/dist/`. No Leptos/Dioxus ([ADR-0002 alt §5](../decisions/0002-rust-port-sequence-and-distribution.md)).
4. **Distribution is `curl -sSL https://runtimescope.dev/install.sh | sh`** → 4 binaries under `~/.runtimescope/bin`, single `runtimescope` on PATH, auto-update via signed GitHub Releases. No npm.
5. **The tray does not change.** It talks HTTP-only; the backend swap is invisible to it. If you find yourself editing `packages/tray/`, you've broken the wire contract — stop.
6. **At the end, delete `packages/collector/`, `packages/mcp-server/`, `packages/cli/` outright** ([ADR-0002 §60](../decisions/0002-rust-port-sequence-and-distribution.md)). Git tags are the rollback; no `-legacy/` copy in the tree.

**Acceptance gate (all four, or it's not done):**
- `RUNTIMESCOPE_COLLECTOR_CMD=<rust-binary> npm run conformance` — fully green.
- `RUNTIMESCOPE_COLLECTOR_CMD=<rust-binary> npm run stress` — 7/7.
- `RUNTIMESCOPE_COLLECTOR_CMD=<rust-binary> npm run bench` then `npm run bench:compare -- node <rust>` — within gates (Rust should *beat* Node on throughput + memory, not squeak past).
- All 63 MCP tools answer with the same envelope shape Claude Code expects.

---

## Module → crate mapping (grounded in the current source)

The Node collector is **~14.5K LOC**, mcp-server **~8.6K**, cli **~2.4K** — ~25K LOC total to port.

### `collector-core` (the serial spine — build this first, alone)

| Node source | LOC | Rust target | Notes |
|---|---|---|---|
| `types.ts` | 1074 | serde structs + the `EventType` enum | The 19 event types. Mechanical but big; do it carefully — everything downstream derives from these. |
| `ring-buffer.ts` | ~150 | `VecDeque`-backed ring | Trivial. |
| `store.ts` | 510 | the `Store` trait + impl | ★ Define the query API here. Every MCP tool and HTTP route calls it. Get this shape right before fanning out. |
| `sqlite-store.ts` | 580 | `rusqlite` | Fresh schema (3 tables + indexes per the wire spec). No better-sqlite3 compat. |
| `wal.ts` | 267 | `std::fs` + `fsync` | The fsync-before-commit + torn-tail recovery is the #1 durability invariant. `crash-recovery` conformance test guards it. |
| `redactor.ts`, `rate-limiter.ts`, `metrics.ts`, `issue-detector.ts`, `session-manager.ts` | ~1000 | direct ports | Mostly pure functions; straightforward. |
| `engines/` (api-discovery, query-monitor, process-monitor, infra-connector) | ~1500 | 4 independent modules | **Fan-out candidates** — mutually independent once `Store` exists. |

### `collector-server` (depends on core)

| Node source | LOC | Rust target | Notes |
|---|---|---|---|
| `server.ts` | 1165 | `tokio-tungstenite` WS server | Handshake (5s auth timeout, close 4001), event-batch ingest, the `requestId` command channel. Conformance: `handshake` + `command-channel`. |
| `http-server.ts` | 1088 | `axum` or `hyper` | The `/api/*` route table + the public/auth gate + static dashboard serving (`include_bytes!`). **Routes are partial fan-out** once the router skeleton exists. |
| `pm/` (pm-store, pm-routes, project-discovery, session-parser, pm-types) | **~4380** | own module / sub-track | ★ The project-manager subsystem — the single largest chunk. Stateful, interconnected. **Its own serial workstream**, not rib-shaped. Can run parallel to mcp-server work. |
| `standalone.ts`, `dashboard.ts`, `platform.ts` | ~740 | server bin entry + static serve | The `include_bytes!` embedding lives here. |

### `mcp-server` (depends on core — the big fan-out)

- **63 tools across 34 files, ~6.5K LOC.** Each tool: validate input (serde, replacing the zod schema) → call a `Store` method → shape the standard envelope `{ summary, data, issues, metadata }`. **Once the tool-registration pattern + `Store` query API exist, these batch beautifully** — this is where an agent team earns its keep.
- Rust MCP: use the official **`rmcp`** crate (modelcontextprotocol/rust-sdk) for stdio JSON-RPC. Less mature than the TS SDK — budget time to wrap rough edges.
- ⚠️ **The hard ones (see Known Hard Spots):** `scanner` (Playwright) and the browser-driven `recon-*` tools.

### `cli` (depends on nothing collector-internal — mostly shells out)

- `packages/cli/src/` ~2.4K LOC. Most of it is `launchctl`/`systemctl` shell-outs (`service.ts`) + help text + `setup`. Direct port to `std::process::Command`. The `service stop` you just added is in here — port it too.
- This crate also owns the **curl-install / self-update** logic (new — not in the Node CLI).

---

## Known Hard Spots (budget extra time, don't discover these late)

1. **Playwright is JS-only — and `scan_website` + several `recon-*` tools depend on it.** There is no drop-in Rust equivalent. Options, in rough preference order:
   - **(a) Defer the browser tools to a Node sidecar** the Rust collector spawns on demand. Keeps the port honest; isolates the one piece that genuinely needs a JS browser engine. **Recommended** — write this as a mini-ADR.
   - **(b) `chromiumoxide` / `fantoccini`+WebDriver** in Rust. More native, but reimplements a lot of Playwright's ergonomics and is a known time sink.
   - **(c) Cut the browser-recon tools from v0.11.0** and restore via sidecar in a follow-up. Acceptable if the owner doesn't use them daily.
   - **Decide this in Milestone 0 / 1, not Milestone 4.** It affects how `mcp-server` is structured.
2. **`rmcp` (Rust MCP SDK) maturity.** Validate it handles the 63-tool registration + the stdio framing Claude Code expects *before* porting all 63. Build one tool end-to-end against it in the vertical slice.
3. **`pm/` project-discovery** reads the filesystem and parses Claude session transcripts (`session-parser.ts`). FS-heavy, lots of edge cases. Port with its existing tests as the spec.
4. **`better-sqlite3` is synchronous; `rusqlite` in an async server** needs a blocking pool (`tokio::task::spawn_blocking`) or a dedicated DB thread. Decide the concurrency model in `collector-core`, once.
5. **Bench parity is a real gate, not a formality.** Rust *should* crush Node here, but the soak's steady-state tail-slope leak detector ([`bench/README.md`](../../bench/README.md)) will catch a Rust leak (e.g. an unbounded `HashMap` of sessions) just as readily. Run the bench continuously, not just at the end.

---

## Dependency translation cheat-sheet

| Node | Rust crate |
|---|---|
| `ws` | `tokio-tungstenite` |
| `better-sqlite3` | `rusqlite` (bundled feature) |
| `@modelcontextprotocol/sdk` | `rmcp` |
| `zod` | `serde` + manual validation (or `garde`/`validator`) |
| `http` (node) | `axum` (on `hyper` + `tokio`) |
| `reqwest`-equivalent (update check) | `reqwest` — already proven in the tray |
| structured logs | `tracing` + `tracing-subscriber` |
| `playwright` | **no equivalent — see Hard Spot #1** |

Toolchain is already pinned: `rust-toolchain.toml` → 1.90.0 (from the tray phase). tokio/serde/reqwest patterns are proven in `packages/tray/src-tauri/`.

---

## Files you will CREATE / TOUCH

```
crates/
├── collector-core/     lib
├── collector-server/   bin
├── mcp-server/         bin
├── cli/                bin
Cargo.toml              workspace root (add crates/* members)
docs/decisions/0007-playwright-sidecar-strategy.md   (the Hard Spot #1 decision)
docs/reports/phase-rust-collector-completion-report.md
install.sh              curl-install entry (hosted at runtimescope.dev)
```

**TOUCH:** `.github/workflows/` (new release workflow for signed binaries + the conformance/bench gate), root `package.json` (the conformance/bench/stress scripts already exist — point CI at them with `RUNTIMESCOPE_COLLECTOR_CMD`), `docs/CURRENT_STATE.md` + `docs/HANDOFF.md` at phase end.

**DELETE at the end (only after the gate is green):** `packages/collector/`, `packages/mcp-server/`, `packages/cli/`.

**DO NOT TOUCH:** `packages/tray/` (HTTP contract), `packages/sdk|server-sdk|workers-sdk|python-sdk/` (the SDKs stay; they're Phase SDK-Channel-Migration's concern), `packages/dashboard/src/` (you embed its *build output*, you don't edit it).

---

## Execution sequence + team strategy

The full milestone breakdown, the serial-spine-vs-parallel-ribs reasoning, and the per-milestone fan-out guidance live in **[`../roadmap/rust-collector-milestones.md`](../roadmap/rust-collector-milestones.md)**. The one-line version:

> **Serial spine → parallel ribs → serial close.** Build `collector-core` + one vertical slice by a single coherent author *first* (settles all conventions). Then fan out on the 63 MCP tools, the 4 engines, and the HTTP routes. Keep `pm/` as its own serial track. Reconvene serially for integration, the conformance/bench gate, the dashboard embed, and the destructive cutover.

Do **not** spawn a team at the bare Rust port — 63 agents before the skeleton exists produces 63 styles you'll spend longer reconciling than writing.

---

## Reproducible commands (the gate you're building toward)

```bash
# today, against Node — these define "correct":
npm run conformance                      # (after Wire-Protocol-Lock ships)
npm run stress                           # 7/7
npm run bench -- --baseline              # blesses bench/baselines/node.json

# during the Rust port — the same suites, against your binary:
cargo build --release
export RUNTIMESCOPE_COLLECTOR_CMD=./target/release/collector-server
npm run conformance                      # must go green incrementally
npm run stress
npm run bench && npm run bench:compare -- node collector-server
```

---

## Final checklist before Phase Rust-Collector is done

- [ ] All 4 crates build clean (`cargo build --release`, `cargo clippy` clean, `cargo test` green).
- [ ] `npm run conformance` green against the Rust binary.
- [ ] `npm run stress` 7/7 against the Rust binary.
- [ ] `npm run bench:compare -- node <rust>` within gates (ideally Rust beats Node).
- [ ] All 63 MCP tools answer Claude Code with the correct envelope (manual smoke + conformance `mcp-driver`).
- [ ] Dashboard served from the embedded bundle (`/dashboard` works with no `packages/dashboard` on disk).
- [ ] The Playwright Hard Spot is resolved per ADR-0007 (sidecar / native / cut).
- [ ] `curl | sh` install drops 4 binaries, `runtimescope` on PATH, self-update works against a signed GitHub Release.
- [ ] First-run data-wipe warning + `RUNTIMESCOPE_PRESERVE_LEGACY_DATA=1` opt-out implemented.
- [ ] `packages/collector/`, `packages/mcp-server/`, `packages/cli/` deleted; tagged rollback verified.
- [ ] Ships as v0.11.0. Node packages (final: v0.10.13) deprecated (not unpublished) on npm.
- [ ] Completion report + CURRENT_STATE + HANDOFF (pointing at Phase SDK-Channel-Migration) updated.

Resolution order if uncertain:
1. This handoff + [`../roadmap/rust-collector-milestones.md`](../roadmap/rust-collector-milestones.md).
2. `docs/specs/wire-protocol.md` + `tests/conformance/` — **the executable contract. The conformance suite is truth.**
3. [ADR-0002](../decisions/0002-rust-port-sequence-and-distribution.md) — the strategic frame + crate layout + hard rules.
4. The Node source under `packages/` — the behavior you're replicating (until you delete it).
5. [`../../CLAUDE.md`](../../CLAUDE.md).

If those don't resolve it — especially the Playwright strategy or a wire-protocol invariant you think is wrong — stop and write a SPEC QUESTION / ADR. A wrong invariant frozen into Rust is the most expensive mistake available in this phase.

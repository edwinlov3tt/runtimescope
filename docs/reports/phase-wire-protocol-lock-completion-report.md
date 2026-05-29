# Phase Wire-Protocol-Lock Completion Report

**Project:** RuntimeScope — freeze the collector's wire contract before the Rust port.
**Brief:** [`../handoffs/phase-wire-protocol-lock-handoff.md`](../handoffs/phase-wire-protocol-lock-handoff.md)
**Decision frame:** [`../decisions/0002-rust-port-sequence-and-distribution.md`](../decisions/0002-rust-port-sequence-and-distribution.md) (invariant #3)
**Initial commit:** `7e88f46` — *docs: Phase Rust-Collector plan*
**Released as:** v0.11.0 (version bumped in-tree; **tag/publish pending owner approval** — see §6).

---

## 1. What shipped

| Deliverable | Path | Status |
|---|---|---|
| Executable conformance suite | [`tests/conformance/`](../../tests/conformance/) | ✅ 15 tests / 5 specs, green vs. Node v0.11.0 |
| Wire-protocol spec (thin, cited) | [`../specs/wire-protocol.md`](../specs/wire-protocol.md) | ✅ |
| MCP tool catalog (63 tools) | [`../specs/mcp-tool-surface.md`](../specs/mcp-tool-surface.md) | ✅ |
| ADR — tests are the spec | [`../decisions/0006-conformance-tests-are-the-spec.md`](../decisions/0006-conformance-tests-are-the-spec.md) | ✅ Accepted |
| `npm run conformance` + CI gate | `package.json`, `.github/workflows/publish.yml` | ✅ |
| MCP stdio JSON-RPC driver | `tests/conformance/harness/mcp-driver.ts` | ✅ (the only genuinely new harness piece) |

The collector-launch seam (`RUNTIMESCOPE_COLLECTOR_CMD`), SDK driver, and bench were built in the prior session (commit `2800c4e`); this phase reused them and added `RUNTIMESCOPE_MCP_CMD` for the MCP bin.

## 2. Conformance coverage

```
✓ handshake.conformance.test.ts      (3)  WS handshake → session; auth-on 4001 close; authed accept
✓ event-roundtrip.conformance.test.ts(2)  WS→HTTP field fidelity; project_id isolation
✓ http-contracts.conformance.test.ts (6)  /api/health, /readyz, /metrics, /api/sessions, 404, public/auth gate
✓ durability.conformance.test.ts     (1)  committed events survive SIGKILL + restart (fsync-before-commit)
✓ mcp-tools.conformance.test.ts      (3)  tool catalog ≥60; data round-trip; command-channel requestId
Test Files  5 passed (5)   Tests  15 passed (15)   ~6.7s
```

All run against any binary via `RUNTIMESCOPE_COLLECTOR_CMD` / `RUNTIMESCOPE_MCP_CMD` — this is the Rust port's acceptance gate, unchanged.

## 3. Gate status

| Gate | Command | Result |
|---|---|---|
| Conformance | `npm run conformance` | ✅ 15/15 |
| Unit | `npm test` | ✅ 586/0 (unchanged — no product behavior touched) |
| Stress | `npm run stress` | ✅ 7/7 (incl. crash-recovery via the seam) |
| Bench | `npm run bench` | ✅ Node baseline intact |
| Build | `npm run build` | ✅ clean |

## 4. Deviations from the brief

1. **Command-channel lives in the MCP spec, not a standalone spec.** The server→SDK command (`capture_dom_snapshot`) is only triggerable through the MCP tool layer (no HTTP trigger on the bare collector), so it's tested where it's reachable — in `mcp-tools.conformance.test.ts` — which validates both the MCP tool *and* the underlying `requestId`-correlated frames. Same coverage, correct location.
2. **`mcp-driver` was load-bearing and surfaced a real startup-ordering bug in the harness** (not the product): the mcp-server `process.stdin.resume()`s for its parent-death watchdog before attaching the MCP transport reader, so JSON-RPC sent too early is silently dropped. The driver now waits for the `"running on stdio"` stderr marker. Documented in the conformance README.
3. **No standalone `wire-protocol.md` invariant went unguarded.** Every §3–§8 invariant cites both a `file:line` and the conformance spec that locks it — except two deliberately-unlocked areas (internal `/api/pm/*` + `/api/v1/admin/*` routes; perf, which is the bench's job).

## 5. Open question handed to Phase Rust-Collector

The command channel is triggered **in-process** today (mcp-server embeds the collector). ADR-0002 splits them into separate Rust bins — the Rust design must provide an equivalent path (shared process or internal bridge) for the command channel. The conformance test pins the **observable** round-trip; the **mechanism** is the Rust phase's call. Flagged in [`wire-protocol.md` §5](../specs/wire-protocol.md), [`mcp-tool-surface.md`](../specs/mcp-tool-surface.md), [ADR-0006](../decisions/0006-conformance-tests-are-the-spec.md), and the Rust handoff. **Must be decided before Rust Milestone 2.**

## 6. Release status — owner action required

Versions bumped in-tree to **v0.11.0** (11 npm packages + the 3 `SDK_VERSION` constants; tray stays at 0.1.0). The phase is "no behavior change" — this is the contract-maturity signal per ADR-0002.

**Not yet published.** Publishing is the owner's explicit call:

```bash
git tag v0.11.0 && git push --tags    # triggers the publish workflow (which now runs the conformance gate)
```

## 7. Next phase

Phase Rust-Collector. The plan is already written: [`../handoffs/phase-rust-collector-handoff.md`](../handoffs/phase-rust-collector-handoff.md) + [`../roadmap/rust-collector-milestones.md`](../roadmap/rust-collector-milestones.md). The acceptance gate is now real: `RUNTIMESCOPE_COLLECTOR_CMD=<rust> npm run conformance && npm run stress && npm run bench:compare`.

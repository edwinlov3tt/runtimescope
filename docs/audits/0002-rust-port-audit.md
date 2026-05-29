# Audit 0002 — Rust collector port (external adversarial review)

**Status:** Open — **Phases A (gate) + B (HTTP) + C-gate DONE**; Phase E + the #2/#8 broader sweep pending. Conformance gate = 33 tests / 12 specs: **33/33 vs Node, 30/33 vs Rust**. The 3 remaining reds: `auth-frames` (Phase E). ⚠️ See Phase C note — the gate's MCP tool coverage is still narrow (only `get_network_requests`).
**Date:** 2026-05-29
**Reviewer:** external coding agent (Codex), adversarial brief — see [`../audits/`](.) and the review prompt handed off by the owner.
**Scope:** the Rust collector port at `main` (commits `0e11346`…`338cf8c`): `crates/*`, `tests/conformance/`, `packages/recon-sidecar/`.

---

## Headline

**"17/17 conformance ⇒ behaviorally equivalent" was not justified.** The conformance suite asserted counts and existence, not shapes/filters/behavior, so the Rust HTTP + MCP surface diverged from Node while the gate stayed green. Build, clippy (`-D warnings`), and `cargo test` all pass; Rust unit coverage is only 2 WAL tests. **Treat the port as blocked for launch work until the gate is hardened and the parity gaps are closed.**

The class-level lessons are captured in [`../../CLAUDE.md`](../../CLAUDE.md) → "Engineering practices & review discipline."

## Findings (all accepted as valid)

| # | Sev | Area | Summary |
|---|---|---|---|
| 1 | **Critical** | `server.rs` HTTP API | Generic `/api/events/{kind}` ignores all filters; `POST /api/events` 404s (**Workers + Python SDK ingest broken**); `timeline` returns 0 (Node merges 5); unknown route returns `200 {count:0}` not 404; raw events returned where Node reshapes. |
| 2 | High | `core_tools.rs` MCP | `get_network_requests` ignores `since_seconds/url_pattern/status/method/limit`, no field reshaping/issues/timeRange. ~57 of 64 tools were never behavior-verified (compile-only). |
| 3 | High | `wal.rs` | No rotation/truncation → WAL grows forever, replays full history every boot (O(history) boot + disk). |
| 4 | High | `wal.rs` | Torn-tail recovery breaks on first bad line but **doesn't truncate** → good data *after* a tear is lost, and later appends behind it get skipped. |
| 5 | High | `store.rs` | `wal.append`/`commit`/SQLite `execute` Results discarded; `add_batch` returns `()` ack regardless → silent data loss while claiming fsync-before-commit. |
| 6 | Med (op: High) | `auth.rs` / `server.rs` | Token compare not constant-time (timing); bad token closes `4001` as `AUTH_TIMEOUT` with no `AUTH_FAILED` frame → server SDK never stops reconnecting (reconnect storm). |
| 7 | Med | `event.rs` / `store.rs` | `project` bound to `projectId` (conflates with `projectName=appName`); sessions in-memory only (Node persists + emits session event) → wrong/empty project metadata after restart. |
| 8 | Med | tool stubs | `tools/list ≥ 60` gate satisfied by `data: null` deferred stubs (database/process/infra/session-snapshot) → catalog count isn't parity evidence. |
| 9 | Med (sec: High) | `sidecar.rs` | `RUNTIMESCOPE_RECON_SIDECAR` whitespace-split breaks paths with spaces; `scan_website` forwards arbitrary URL to Playwright `page.goto` with no scheme/host allowlist → SSRF / internal-network / `file://` exposure. |

Full evidence (probe counts, `file:line`) in the review transcript. The differential probe (spawn Node + Rust, diff real HTTP/MCP outputs) is the reusable verification pattern.

## Remediation plan — gate first

- **Phase A — harden the conformance gate. ✅ DONE (2026-05-29).** Added 5 specs / 16 tests via a workflow fan-out: `http-filters`, `http-ingest-and-routes` (POST ingest + timeline + 404), `http-field-fidelity`, `mcp-tool-shapes`, `auth-frames`. Green 33/33 vs Node; **21/33 vs Rust** — the 12 reds catch exactly the divergences the old gate missed. The gate is now honest; remaining work is measurable against it.

  **Corrections the agents surfaced while encoding *real* Node behavior (ADR-0006):**
  - **The HTTP layer returns events VERBATIM in *both* Node and Rust** — no reshaping at `/api/events/*`. Finding #1's "raw vs reshaped" was misattributed: reshaping happens only in the **MCP tool** layer (`network.ts` → finding #2). `http-field-fidelity` is green vs Rust (already conformant). So **Phase B's HTTP work is narrower than #1 implied** — it's filters + `POST /api/events` ingest + `timeline` merge + unknown-route 404, **not** response reshaping.
  - Node's `/api/events/network` route **does not forward `status`** to the store (it's a no-op filter); `timeline` is **insertion-ordered**, not timestamp-sorted. Both locked as real behavior.
- **Phase B — HTTP parity** (#1): **✅ DONE.** `/api/events/<kind>` now applies Node's query filters (`method`/`url_pattern`/`since_seconds`/`level`/`search`/`session_id`; `status` left a no-op to match Node), validates kind → 404 for unknown; `timeline` is a cross-type insertion-ordered merge with `event_types` filter; `POST /api/events` ingest returns the `{accepted,dropped,rejected,sessionId}` receipt (200/429), rejects invalid `eventType`s, 400s on empty payload. (No HTTP response reshaping needed — already matched, per Phase A.) `http-filters` + `http-ingest-and-routes` now green vs Rust (8 tests). Node unaffected (33/33).
- **Phase C — MCP tool semantics + honest catalog** (#2, #8): **gate DONE; broader sweep PENDING.** `get_network_requests` now honors its filter args (`method`/`status`/`since_seconds`/`url_pattern`/`limit`) and reshapes output to match `network.ts` (duration/ttfb as `"<n>ms"` strings, ISO timestamp via chrono, `graphqlOperation ?? null`, derived failed/slow/N+1 issues, `metadata.timeRange`) — `mcp-tool-shapes` green vs Rust. **STILL OPEN (#2):** the other ~57 agent-ported tools (event-read families, etc.) follow the same pattern but are **not conformance-verified** — they may have similar arg/shape gaps. **STILL OPEN (#8):** deferred stubs return `data: null` + a "deferred" summary but no machine-readable marker, and still count toward the catalog. **Recommend a tool-shape conformance sweep** (more `*-shapes` specs across families, like Phase A) before launch — don't trust the narrow gate.
- **Phase D — durability** (#4, #3, #5): torn-tail truncate; WAL rotation/truncation + bounded retention; propagate write errors.
- **Phase E — auth + metadata + sidecar** (#6, #7, #9): constant-time compare + `AUTH_FAILED`; persist sessions + separate name/projectId; sidecar argv + URL allowlist.

## Status reset

The architecture decisions (ADR-0008 embed-in-process, the `RUNTIMESCOPE_COLLECTOR_CMD` seam, the recon sidecar) survived the audit. What needs work is **implementation fidelity** and **test rigor** — fixable, not a redesign. The earlier "~60-65% to launch" estimate was optimistic; M2/M3 need a parity-correctness pass and the gate needs rebuilding before launch work resumes.

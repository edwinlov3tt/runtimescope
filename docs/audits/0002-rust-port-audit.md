# Audit 0002 — Rust collector port (external adversarial review)

**Status:** Open — remediation Phases A–E (below) not yet started.
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

- **Phase A — harden the conformance gate.** Add specs (vs. Node) for every `/api/events/*` filter, `timeline` merge, `POST /api/events` ingest, unknown-route 404, field-level response fidelity, and MCP output shapes for the top tools + `AUTH_FAILED` vs `AUTH_TIMEOUT`. These go **red against Rust** — that's the point; the gate becomes honest. Closes the root cause.
- **Phase B — HTTP parity** (#1): explicit filtered routes, timeline merge, POST ingest, reshaping, 404.
- **Phase C — MCP tool semantics + honest catalog** (#2, #8): port real arg/shape for high-traffic store-read tools; gate on "answers correctly," mark deferred tools explicitly.
- **Phase D — durability** (#4, #3, #5): torn-tail truncate; WAL rotation/truncation + bounded retention; propagate write errors.
- **Phase E — auth + metadata + sidecar** (#6, #7, #9): constant-time compare + `AUTH_FAILED`; persist sessions + separate name/projectId; sidecar argv + URL allowlist.

## Status reset

The architecture decisions (ADR-0008 embed-in-process, the `RUNTIMESCOPE_COLLECTOR_CMD` seam, the recon sidecar) survived the audit. What needs work is **implementation fidelity** and **test rigor** — fixable, not a redesign. The earlier "~60-65% to launch" estimate was optimistic; M2/M3 need a parity-correctness pass and the gate needs rebuilding before launch work resumes.

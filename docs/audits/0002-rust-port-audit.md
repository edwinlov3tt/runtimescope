# Audit 0002 — Rust collector port (external adversarial review)

**Status:** **CLOSED — conformance gate GREEN at 51/51 vs Node AND Rust.** All nine findings remediated: A (gate), B (HTTP), C (MCP semantics), D (durability), E (auth/sidecar), #2 (tool-shape sweep), #7 (session metadata), #8 (deferred markers), #9 (SSRF). The gate grew 17→33→35→51 tests; Rust went from a false 17/17 → honest 21/33 → 51/51 across the remediation phases.
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
- **Phase C — MCP tool semantics + honest catalog** (#2, #8): **✅ DONE.** First `get_network_requests` was made to honor its filter args and reshape output to match `network.ts` (`mcp-tool-shapes` green). Then the **tool-shape sweep** broadened the gate with 4 `*-shapes` specs (+16 tests) across the event-read, api-discovery, data/history, and recon-read families (workflow fan-out, authored green-vs-Node first). Closing the resulting Rust reds:
  - **Shared timestamp reshaping** — lifted `iso_ms`/`now_ms` into `tools/mod.rs`; every tool now surfaces ISO-8601 strings where the store holds raw epoch ms (the dominant divergence).
  - **event-read** — ISO timestamps across state/timeline/errors/custom/breadcrumbs; `get_performance_metrics` browser/server/allEvents grouping + derived issues; breadcrumb per-entry `data` payloads + `level` filter + categoryCounts/anchor; `get_event_flow` `avgCompletionTimeMs`, per-step `avgTimeFromPrev`, correlated errors.
  - **api-discovery** — catalog ISO firstSeen/lastSeen, `graphql:null`, real `responseFields`, callCount-desc sort; service-map auth object + `detectedPlatform` name; docs header/headings + latency/error-rate lines; changes `normalizedPath`.
  - **data/history** — `capture_har` full HAR 1.2 (headers→`[{name,value}]`, queryString from URL, `statusText`, ISO `startedDateTime`, content/timings); `runtime_qa_check` now resolves the session, computes per-session metrics (`totalEvents` counts the synthetic `session` connect event → 8, `errorCount`/`queryCount`/`componentCount`/`webVitals`) **and persists a snapshot**; `get_session_history` reads that snapshot back; `get_historical_events` resolves appName→scope key; `list_projects` keys by appName + `eventCount`.
  - **collector-core** — the WS/POST handshake now records a queryable `session` connect event (Node `server.ts` parity, idempotent on `session-<id>`); a `snapshots` table + `save_snapshot`/`session_history`/`event_count` store ops back the QA→history chain.
  - **#8 deferred markers** — the 17 catalog stubs (database ×5, process/infra ×7, session-snapshot ×3, `clear_events`, `get_style_diff`) now carry a machine-readable `metadata.deferred: true` so the catalog count stops masking them. (These are Rust-only — Node implements them — so the marker is asserted Rust-side, not via Node conformance.)

  Gate: **51/51 vs Node AND Rust.**
- **Phase D — durability ✅ DONE** (#4, #3, #5). #4: `Wal::open` heals a torn tail (truncates the active file to its last complete, parseable, newline-terminated line) so events appended after a tear survive a later recovery — unit test `append_after_torn_tail_recovers_everything`. #3: the JSONL WAL is `truncate()`d after each batch's SQLite commit (and after startup recovery), so it stays O(in-flight) instead of O(history) — boot no longer replays the whole history; unit test `truncate_clears_the_active_wal`. #5: `insert_event` and `add_batch` now return `Result` and the WS/POST/scan callers log durability failures instead of returning a false ack. Durability conformance still green vs Rust (crash + restart recovers); 4 WAL unit tests; clippy clean.
- **#9 sidecar SSRF — strengthened.** The guard now parses the host as a real IP (incl. **decimal `2130706433`/hex `0x7f000001`**, IPv6, IPv4-mapped) and rejects loopback/private/link-local/unspecified/multicast/CGNAT/ULA via `std::net` predicates (closes the alternate-encoding bypass the security review flagged). **Advisory for DNS names** — a public name resolving to a private IP, and DNS rebinding, still require post-resolution enforcement **in the sidecar** (it performs the actual `page.goto`); documented as a follow-up.
- **Phase E — auth + sidecar + metadata (#7) DONE.** #6: token compare is now **constant-time** (`subtle::ct_eq`), and the WS auth gate emits distinct `AUTH_FAILED` (bad/missing token) vs `AUTH_TIMEOUT` (no handshake) error frames **before** the 4001 close — `auth-frames` green vs Rust (closes the reconnect storm). #9: `RUNTIMESCOPE_RECON_SIDECAR` accepts a JSON argv array (paths with spaces); `scan_website` has an SSRF guard (http/https only; rejects localhost/127./10./192.168./172.16-31./169.254./`.local`/`.internal`/`file://`) — verified. **#7 ✅:** `SessionInfo` carries `app_name` + `project_id` distinctly (a `project_key()` helper keeps the old derived key for filtering/grouping); `/api/sessions` returns the Node shape (no spurious `projectName`); sessions persist to a SQLite `sessions` table and rehydrate `is_connected:false` on restart. Gated by `session-metadata.conformance.test.ts` (green vs Node AND Rust; suite now 35/35).

## Second adversarial review (Codex, 2026-05-29) — 5 findings, all fixed

The #2/#8 closure was re-audited by the same differential-probe method. The 51-test gate was real regression coverage but still too thin on the data/history family: it exercised a **single happy-path session** (no render/web-vital events), a **single app**, and ASCII-only query strings — so the new `runtime_qa_check`/history code passed while diverging on the cases the spec never hit. Five findings, all now remediated and (where gateable) locked by `data-history-parity.conformance.test.ts` (5 tests, green vs Node AND Rust → suite **56/56**):

| # | Sev | Fix |
|---|---|---|
| 1 | High | `runtime_qa_check` metrics were not Node-parity: summed a fixed 7-type whitelist, read render components from top-level fields, and Web Vitals from `name`. Rewrote as a faithful port of `SessionManager.computeMetrics` — metrics over **all** session events (so `totalEvents` includes navigation/ui/custom), `componentCount` from each render event's `profiles[]`, `webVitals` keyed by `metricName` for rating-bearing perf only. (This is the most dangerous one — wrong metrics were being *persisted* into snapshots and read back by history.) |
| 2 | High | `get_historical_events`/`list_projects` scoped by the projectId key → apps sharing a projectId merged. Now keyed by **appName** (`events_for_app`/`event_count_for_app` resolve via the session→appName map); unknown `project_id` returns `data: null` + issue (Node parity) instead of empty success. *Note:* Node's own shared-projectId persistence is **asymmetric** (app-alpha sees only its session, app-beta sees both) — not a clean contract — so the gate locks the `list_projects` keying + the `data:null` case, not history isolation; the leak fix itself is verified by construction. |
| 3 | Med | `capture_har` `url_decode` byte-cast each `%XX` → corrupted multi-byte UTF-8 (`%E2%9C%93` → mojibake). Now decodes into a byte buffer + `from_utf8_lossy`, matching `URLSearchParams`. |
| 4 | Med | `get_session_history.createdAt` surfaced the snapshot creation time; Node surfaces the session connect time (`disconnectedAt ?? connectedAt`). Now sourced from the session registry's `connected_at`; metrics still from the snapshot. |
| 5 | Low | Completed the #8 deferred markers — the 8 `setup_workspaces`-family stubs (`get_project_config`, `create_workspace`, `list_workspaces`, `create_workspace_api_key`, `move_project_to_workspace`, `setup_project`, `start_collector`, `stop_collector`) now also carry `metadata.deferred: true`. (Marker remains inert/advisory — there is no consumer asserting it yet; a tool-catalog assertion is a follow-up.) |

Lesson reinforced (already in CLAUDE.md): a happy-path fixture is not a parity test. The fix added the render-profile, web-vital, multi-app, UTF-8, and connect-time cases the original spec lacked.

## Third adversarial review (Codex, 2026-05-30) — verified against `4ae487e`, 4 findings, all fixed

A third pass (this time confirmed on HEAD `4ae487e` / 56 tests — an earlier run had reviewed a stale checkout and re-reported the five already-closed findings) found four new ones, now fixed → suite **57/57 vs Node AND Rust**:

| # | Sev | Fix |
|---|---|---|
| 1 | High | `POST /api/events` dropped events **missing an `eventId`** — `INSERT OR IGNORE` no-ops on an empty id, so the ingest returned `accepted: N` while storing 0 (silent telemetry loss for the Workers/Python SDKs). Now backfills `eventId` (`http-<ts>-<seq>`, monotonic counter for in-ms uniqueness), `sessionId`, and `timestamp` before `add_batch`, matching Node `http-server.ts`. Gated by a new `http-ingest-and-routes` case (POST without eventId → 2 events readable). |
| 2 | Med | `runtime_qa_check` omitted Node's `metadata.webVitals` **summary string** (`"LCP: 2400.0 (good)"`, `, `-joined, else `null`). Added. Gated in `data-history-parity`. |
| 3 | Med (doc) | The shared-projectId history isolation is a deliberate Rust correction over Node's asymmetric behavior, so it can't be Node-conformance-gated. Now **explicitly locked Rust-side** by `store.rs` unit test `events_for_app_isolates_apps_sharing_a_project_id`. |
| 4 | Low | `get_session_history` exposed a Rust-only `project_id` arg; Node's schema is `{project, limit}`. Removed it for schema parity. |

## Status reset

The architecture decisions (ADR-0008 embed-in-process, the `RUNTIMESCOPE_COLLECTOR_CMD` seam, the recon sidecar) survived the audit. What needed work was **implementation fidelity** and **test rigor** — fixable, not a redesign. As of 2026-05-29 all nine findings (plus the five second-review findings) are remediated and the gate is rebuilt to **56/56 vs both** reference (Node) and candidate (Rust); the parity claim now rests on differential shape/filter/behavior tests, not counts. Launch work (M4 remainder → M7 cutover) can resume against this gate.

**Carried forward (not audit blockers, tracked separately):**
- `compare_sessions` still needs the `compareSessions` diff engine (endpoint/component/web-vital/query deltas) — deferred, marked. The snapshot store added here unblocks it.
- The `setup_workspaces` family (`setup_project`, `create_workspace`, `start/stop_collector`, …) is deferred by design (config/PM/lifecycle subsystems, M5/M6) and is outside the audit's named catalog; those stubs are not yet `deferred`-marked.
- Sidecar DNS-rebinding enforcement (post-resolution) remains the sidecar's responsibility (#9 advisory).

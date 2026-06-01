# Handoff — Rust dev-server core (M5.5 Slice G, steps 2–4)

> **For the implementing instance.** Self-contained. Read this + the audit
> ([`../research/0004-node-dev-server-audit.md`](../research/0004-node-dev-server-audit.md))
> and you have everything. A reviewer instance will check your work against this doc.

## Mission

Port the 3 dev-server routes to the Rust collector, **closing the Node bugs** (not porting
them). The `scripts` route (step 1) is already done and shipped. You own steps 2–4:

- `GET    /api/pm/projects/{id}/dev-server`
- `POST   /api/pm/projects/{id}/dev-server`
- `DELETE /api/pm/projects/{id}/dev-server`

This is the **"no gaps" slice** — the user explicitly flagged the Node version as buggy and
wants the lifecycle *proven*, not shape-checked. Read the audit first; it has the full bug list.

## Non-negotiable decisions (already made by the user — do not relitigate)

1. **Stop = group-kill.** Spawn the dev process in its **own process group** (`setsid` /
   `CommandExt::process_group(0)`), track the **pgid**, and stop via `kill(-pgid, SIGTERM)` then
   escalate to `SIGKILL`. This is an **intentional divergence** from Node (which orphans the
   real server by killing only the shell pid). It is **Rust-test-gated, NOT conformance-gated** —
   do NOT write a conformance test that asserts Node's "killed:true but still listening" bug.
2. **No shell.** `std::process::Command` with an explicit **argv** — never `shell:true`,
   never shell-split a body string (Node's `shell:true` + body `command` is a command-injection
   hole). For `npm run <script>`, resolve to argv yourself (`npm`, `["run", script]`) — or read
   the script's command from package.json and run that argv. Validate `script`/`command` inputs.
3. **Real listen detection.** Do NOT trust log-scraping for the port. After spawn, poll the
   **child process tree's** actual listening sockets and report **all** bound ports. Flip status
   to `running` only once something is actually listening (with a timeout → stay `starting`,
   or `crashed` if it exited). Log-regex may stay as a secondary hint only.
4. **Persist + re-attach.** Persist managed processes (pid, **pgid**, projectId, command,
   startedAt, ports) so a collector restart can re-attach (liveness-check the pgid) instead of
   orphaning — and so `GET` tells the truth after a restart (Node's in-memory map lies).
5. **SSH/forward = detect-and-warn (v1).** Detect devcontainer/remote (`.devcontainer/`,
   `$SSH_CONNECTION`, `$CODESPACES`, `$REMOTE_CONTAINERS`); when detected, mark the reported
   ports **container-local / not-host-mapped** (a boolean + note in the response). Do NOT resolve
   forward tables (`docker port` / `ssh -L` / `forwardPorts`) — that's a flagged v2 follow-up.
6. **Port tie-back = active auto-attach.** Beyond persisting + surfacing the detected port(s),
   actively hint the SDK/scanner to attach (surface the inject-snippet / trigger a scan against
   the detected port). **Design the hint so a wrong/duplicate/stale detection is a safe no-op,
   not a misfire.** This is the feature's reason to exist (Node never connected the two).

## The deterministic contract to MATCH Node exactly (response shapes)

These are the parts the dashboard depends on and that a conformance test pins. Match Node
(`packages/collector/src/pm/pm-routes.ts:743-925`) byte-for-byte on shape/status:

- **GET**, no managed process → `200 { "data": { "status": "stopped" } }`.
- **GET**, managed + alive → `200 { "data": { status, pid, command, startedAt, exitCode, logs } }`
  (`logs` = last 100 lines). *You may ADD fields (ports[], isContainerLocal) — additive only;
  don't rename/remove the Node ones the dashboard reads.*
- **POST**, unknown project → `404 { "error": "Project not found" }`.
- **POST**, project has no `path` → `400 { "error": "Project has no filesystem path" }`.
- **POST**, already running → `409 { "error": "Dev server already running", "data": { pid, status } }`.
- **POST**, success → `200 { "data": { pid, command, cwd, status: "starting" } }`.
- **DELETE**, unknown project → `404 { "error": "Project not found" }`.
- **DELETE**, nothing running → `404 { "error": "No running dev server found for this project" }`.
- **DELETE**, success → `200 { "data": { killed: true, pid, signal } }`; if the process was
  already gone (ESRCH-equivalent) → `200 { "data": { killed: true, pid, signal, note: "Process already exited" } }`.
  Body may carry `{ "signal": "SIGKILL" }` (default `SIGTERM`).

> ⚠️ **Audit-discipline reminder (this project has been bitten twice — see
> `../specs/rust-collector-patterns.md`):** "green" must mean the contract holds. The
> `SessionStats` port shipped with a wrong field name because the only gated path was a 404.
> Assert the *success-path shapes*, not just the error paths. Where the harness can't reach a
> path, cover it with a Rust integration test (below) — do not leave a success path unverified.

## Conformance vs Rust-integration split

The conformance harness (`tests/conformance/`) gives each test a **fresh temp `$HOME`** with an
empty pm.db and **no discovered projects**, so over HTTP every route hits the **no-project**
branch. Therefore:

- **Conformance (`tests/conformance/specs/pm-dev-server.conformance.test.ts`, green vs BOTH):**
  the deterministic no-project cases — `GET` → `{data:{status:"stopped"}}` (no project = no
  managed proc), `POST` unknown project → 404, `DELETE` unknown project → 404. Author
  **green-vs-Node first** (no `RUNTIMESCOPE_*_CMD`), then confirm vs Rust. (The 400-no-path /
  409-already-running / success paths need a real project the harness can't seed — cover them
  in the integration test, and add the no-path/409 cases to conformance only if you wire a way
  to seed a project; otherwise unit/integration-test them.)
- **Rust integration test (`crates/collector-core`, the "no gaps" proof):** spawn a **real**
  trivial listener in a temp dir (e.g. `python3 -m http.server 0` is non-deterministic-port;
  prefer a tiny fixed-port script, or a `node -e` one-liner that `listen`s and prints nothing),
  then prove the full lifecycle:
  1. start it through your spawn path (own process group),
  2. **detect its real bound port** via the socket poll (not logs),
  3. **group-kill** it,
  4. **assert the port is actually freed** (re-bind succeeds / connect fails) and **no orphan**
     survives (the grandchild is gone, not just the shell).
  This step 4 is the whole point — it's what "fix the orphan bug" means. Gate it.
  Also unit-test: devcontainer detection (set the env vars in a temp), and that the auto-attach
  hint is a no-op on a bogus/duplicate port.

## Where things live (conventions)

- **Routes + handlers:** `crates/collector-core/src/server.rs`. Register in the `Router` in
  `serve()` (alongside the existing `/api/pm/projects/{id}/git/*` + `/scripts` routes). Use the
  existing helpers: `http_authorized`, `not_found_json`, `bad_request`, `unauthorized`,
  `q_*` query helpers. **Run all blocking work (spawn, kill, socket poll, fs) under
  `tokio::task::spawn_blocking`** — see the git handlers (`pm_git_*` / `run_git`) as the exact
  exemplar for process exec + spawn_blocking + a real-process integration test (`slice_f_git_tests`).
- **Managed-process state:** this is **shared mutable runtime state** (unlike git, which is
  stateless). Hold it in `AppState` (e.g. `Arc<Mutex<HashMap<String, ManagedProc>>>`), added to
  the `AppState` struct + threaded through `serve()`. Keep it separate from the event store.
- **Persistence:** extend `pm.db` (`crates/collector-core/src/pm_store.rs`) with a
  `pm_dev_servers` table (id/projectId/pid/pgid/command/startedAt/ports-json/status) OR a small
  JSON file under `data_dir()`. Follow the existing `PmStore` method + `map_*` row patterns;
  remember **FK is ON** now (if you reference pm_projects, insert order/validity matters — or
  don't FK it). Re-attach on `open`/startup (liveness-check pgids).
- **Socket detection (no new heavy deps):** shell out to `lsof -nP -p <pid1,pid2,...> -iTCP -sTCP:LISTEN`
  on macOS/Linux (parse the `:PORT` column), or read `/proc/<pid>/net/tcp` on Linux. Walk the
  process tree (children of the pgid) — a single dev command often spawns the real server as a
  grandchild. Best-effort + timeout; macet on both OSes (CI is macos-14).
- **Types duplication / camelCase:** responses are JSON via `json!`/serde `rename_all="camelCase"`
  like the other pm structs.
- **Build/verify (run ALL of these before handing back):**
  - `cargo build` + `cargo clippy --workspace` (must be clean, `-D warnings` in CI).
  - `cargo test -p collector-core` (your unit + integration tests pass).
  - `npm run conformance` **twice** — once with no env (vs Node), once with
    `RUNTIMESCOPE_COLLECTOR_CMD=$PWD/target/debug/collector-server RUNTIMESCOPE_MCP_CMD=$PWD/target/debug/mcp-server`
    (vs Rust). Both must be fully green.
  - **Flake note:** under the now-30+-file parallel suite, `event-read-shapes` /
    `data-history-shapes` occasionally drop ONE vs-Node test due to process contention. If you
    see exactly that, re-run the spec in isolation (`npx vitest run --config
    tests/conformance/vitest.config.ts <name>`) to confirm it's the known flake, not your change.

## Hard constraints

- **DO NOT touch `packages/tray/src-tauri/src/lib.rs`** — that's the user's uncommitted work.
- Commit messages end with the trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Work on a branch; **do not** modify the Node `packages/collector` source (it's the reference).
- Update `docs/roadmap/rust-collector-milestones.md` (Slice G) + `docs/CURRENT_STATE.md` (gate
  count) + note any new intended divergence in `docs/specs/rust-collector-patterns.md`.

## Key design decisions YOU make (document them in your PR + the patterns doc)

1. **Dashboard live updates.** The Rust collector's WS is **SDK-only** — there is **no
   dashboard broadcast channel** (Node's `broadcastDevServer` pushes `dev_server_status` /
   `dev_server_log` to dashboard WS clients; Rust has no equivalent). **Recommended:** make
   `GET /dev-server` the honest source of truth (status + ports + logs) so the dashboard can
   poll, and defer a WS push to a follow-up. If you add a broadcast channel, that's a bigger
   change to the WS layer — flag it, don't smuggle it in. Either way the broadcast is NOT
   conformance-gateable; the GET shape is.
2. **Persistence medium** (pm.db table vs JSON file) — pick one, justify briefly.
3. **Socket-poll cadence/timeout** + how you enumerate the process tree.
4. **Auto-attach mechanism** — exactly how the detected port is surfaced/hinted to the
   SDK/scanner, and how you guarantee a stale/duplicate detection is a no-op.

## Acceptance criteria (the reviewer will check these)

- [ ] 3 routes implemented; **deterministic shapes match Node** (the contract above), gated by
      `pm-dev-server.conformance.test.ts` green vs **both**.
- [ ] **Lifecycle integration test passes**: real spawn → real-port detection → group-kill →
      **port freed + no orphan**. (This is the gate that proves the Node bug is fixed.)
- [ ] No `shell:true` anywhere; argv only; inputs validated.
- [ ] Persistence + re-attach: a restart doesn't orphan and `GET` stays honest (test it).
- [ ] Devcontainer detect-and-warn (ports marked container-local) — tested.
- [ ] Active auto-attach wired + no-op-on-bad-detection — tested.
- [ ] `cargo clippy --workspace` clean; `cargo test -p collector-core` green; full conformance
      green vs both; docs updated; commit trailer present; tray untouched.
- [ ] PR summary lists the 4 design decisions you made + shows the integration-test output
      proving the port is freed after stop.

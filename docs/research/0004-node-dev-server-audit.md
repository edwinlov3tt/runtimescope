# Research 0004 — Node dev-server audit (before the Rust port)

> Requested before building the Rust `/api/pm/projects/{id}/dev-server` routes (M5.5 Slice G).
> Goal: catalog what the Node implementation actually does, where it's broken, and
> what the Rust version must do differently — rather than port the bugs. Source:
> `packages/collector/src/pm/pm-routes.ts:743-925` + `platform.ts:158-197`.

## What it does today (architecture)

- **State:** a single in-process `Map<projectId, ManagedProcess>` (`managedProcesses`).
  One dev server per project (a 2nd `POST` → `409`). `ManagedProcess` = `{ pid, command,
  projectId, startedAt, status, child, logs[≤500], exitCode }`.
- **Start (`POST`):** `spawn(finalCommand, { cwd: project.path, shell: true, stdio:
  ['ignore','pipe','pipe'] })` where `finalCommand = command ?? (script ? \`npm run ${script}\` : 'npm run dev')`.
  Status `starting` → `running` on the **first stdout/stderr line OR a 500ms timer**.
- **Port "detection":** a regex `/(?:localhost|127.0.0.1|0.0.0.0):(\d{4,5})/` scanned over
  log lines; the first match is `detectedPort`, broadcast over WS.
- **Logs/status push:** broadcast to the dashboard via WS (`dev_server_status` /
  `dev_server_log`); the dashboard consumes them in `App.tsx`/`ws-client.ts`.
- **Get (`GET`):** returns the map entry (liveness-checked via `process.kill(pid,0)`), last
  100 log lines. After a collector restart the map is empty → reports `stopped`.
- **Stop (`DELETE`):** `managed.child.kill(signal)` + `process.kill(pid, signal)` (default
  `SIGTERM`, `SIGKILL` if asked). If the map has no entry, falls back to
  `findPidsInDirectory(project.path)` and kills `pids[0]`.
- **Exit handling:** on `exit`/`error`, status → `stopped`/`crashed`, entry deleted after 5s.

## The user's questions, answered

### Does it actually start/stop processes?
- **Start: yes** (it spawns), **but via `shell: true` with a body-supplied `command`** →
  **command injection** (`{"command":"npm run dev; rm -rf ~"}` runs in a shell). The audit
  doc's standing rule is "no `shell:true`, never shell-split into argv."
- **Stop: effectively NO for the common case.** With `shell: true` the tracked `pid` is the
  **shell** (`/bin/sh -c "npm run dev"`). `npm run dev` then forks `npm` → `node`/`vite`/etc.
  Killing the shell pid (or `child.kill`) does **not** kill those grandchildren — there is
  **no `detached`/`setsid` process group and no `killpg`/`process.kill(-pgid)` anywhere**.
  Net effect: "stop" returns `{killed:true}` while the actual dev server keeps holding its
  port. This is the #1 functional bug.
- **Stop fallback is fragile:** `findPidsInDirectory` shells out to `lsof -t +D "${dir}"`
  (slow full-tree walk; `dir` is interpolated into a shell string) or scans `/proc/*/cwd`
  with a **prefix match** (`cwd.startsWith(dir)` → `/foo` matches `/foobar`), then kills the
  arbitrary **first** pid. Windows returns `[]` (no stop at all).

### Does it detect what services are started + tie back to a project?
- **Service/port detection is log-scraping, single-port, best-effort.** It only catches a
  port printed as `host:NNNN` on a log line. It **misses**: "Listening on port 3000",
  Next.js's `url: http://localhost:3000`, https, IPv6 `[::1]`, unix sockets, and any server
  that logs nothing. It captures **one** port — dev servers that open an app port **and** an
  HMR/websocket port (Vite) or an admin port are under-reported.
- **No framework/service-type detection** (vite vs next vs express vs a Rails server).
- **`running` ≠ actually listening.** Status flips on the first byte of output (even a
  deprecation warning) or a 500ms timer — not on a real socket-listen check. A server that
  prints a banner then fails to bind still shows `running` briefly.
- **No tie-back to monitoring.** `detectedPort` is only broadcast to the dashboard UI. It is
  **not persisted**, not written to the project's runtime data, and **not connected to
  RuntimeScope's network/SDK capture** — i.e. starting a dev server does nothing to wire that
  port into what the collector observes. This is the biggest *product* gap: the dev-server
  feature and the monitoring feature don't talk to each other.
- **No persistence / restart-survival.** `managedProcesses` is in-memory. A collector restart
  orphans every running dev server and loses all tracking; `GET` then lies (`stopped`).

### Do we need to track SSH / forwarded ports?
- **Today: not tracked at all — total gap.** There is zero awareness of remote execution,
  devcontainers, or port forwarding. When the dev server runs behind a forward (devcontainer,
  Docker `-p`, `ssh -L`, Codespaces), the scraped `localhost:3000` may not be the
  externally-reachable port, and the bound port the child holds may live in another namespace.
  - **Recommendation: yes, but scoped.** v1 should at least (a) detect that `project.path`
    is a devcontainer/remote workspace (`.devcontainer/`, `$REMOTE_CONTAINERS`, `$SSH_CONNECTION`,
    `$CODESPACES`) and **surface that the detected port is container-local, not host-mapped**,
    and (b) when we own the spawn, read the child tree's actual listening sockets (see below)
    rather than trusting logs. Full `ssh -L`/`docker port` forward-table resolution is a v2
    concern worth a flag, not a blocker — but the design must not *assume* localhost == host.

## Concrete bug/gap list

| # | Sev | Issue |
|---|-----|-------|
| 1 | **critical** | `shell:true` + body `command` → command injection. |
| 2 | **critical** | Stop orphans the real server (kills the shell, not the process group). |
| 3 | high | No persistence → restart orphans + `GET` falsely reports `stopped`. |
| 4 | high | Port detection is log-scrape only: misses many formats, captures one port, no real listen check. |
| 5 | high | `detectedPort` never tied back to monitoring/network capture or persisted. |
| 6 | med | `running` status is first-byte/500ms, not an actual socket-listen signal. |
| 7 | med | Stop fallback: `lsof +D` shell-interpolates `dir`; `/proc` `startsWith` prefix bug; kills arbitrary `pids[0]`; Windows no-op. |
| 8 | med | No SSH/forwarded-port / devcontainer awareness (localhost assumption). |
| 9 | low | No `restart` endpoint. No max-runtime / resource guard. No multi-port reporting. |
| 10 | low | Logs lost on restart; only last 100 returned; no since-cursor. |

## Recommended Rust design (close the gaps — don't port the bugs)

1. **Spawn safely + killably.** `std::process::Command` with **argv, no shell**. Put the child
   in its **own process group** (`setsid` / `process_group(0)` via `CommandExt`) so we can
   `kill(-pgid, SIGTERM→SIGKILL)` the whole tree on stop. This single change fixes bugs #1 and #2.
   (For `npm run X`, resolve to the package.json script's argv ourselves rather than handing a
   string to a shell.)
2. **Real listen detection, not log-scrape.** After spawn, poll the child **process tree's**
   listening sockets (`lsof -nP -p <pids> -iTCP -sTCP:LISTEN`, or `/proc/<pid>/net/tcp` on
   Linux) to learn the **actual bound port(s)** — report all of them, and only flip to
   `running` once something is listening (with a timeout → `starting`/`crashed`). Keep the
   log regex as a hint, not the source of truth.
3. **Persist managed processes** (pid + pgid + projectId + command + startedAt + ports) so a
   collector restart can re-attach (liveness-check the pgid) instead of orphaning, and `GET`
   tells the truth after restart.
4. **Tie the detected port back to the project** — persist it on the project's runtime data and
   surface it so the SDK-install / network-capture path can use it (the whole point of running
   a dev server inside RuntimeScope). This is the feature's reason to exist.
5. **Devcontainer/remote awareness** (bug #8): detect `.devcontainer`/`$SSH_CONNECTION`/
   `$CODESPACES` and mark detected ports container-local; leave host-forward resolution behind
   a follow-up flag.
6. **Conformance-gateable surface:** the deterministic cases (404 no-project, 400 no-path, 409
   already-running, stop-when-stopped) gate green-vs-Node; the **lifecycle** (spawn a trivial
   listener, detect its real port, group-kill it, confirm the port is freed) is a Rust
   integration test against a real spawned process — *not* an empty-state shape check, since
   "no gaps" means proving start/stop/detect actually work.

## Open questions for the dedicated pass

- **Stop semantics vs Node parity:** the correct group-kill **diverges** from Node's
  orphaning behavior. Confirm we treat this as an intended improvement (Rust-test-gated), since
  a conformance test that asserted Node's "killed:true but still running" would be asserting a bug.
- **SSH/forward scope for v1:** detect-and-warn only, or actually resolve forward tables
  (`docker port`, parse `ssh -L`)? The latter is real work.
- **Port→monitoring wiring:** how far do we go — just persist+surface the port, or actively
  hint the SDK/scanner to attach to it?

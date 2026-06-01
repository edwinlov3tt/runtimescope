//! Dev-server process lifecycle (M5.5 Slice G, steps 2-4) — the "no gaps" slice.
//!
//! This closes the Node bugs catalogued in `docs/research/0004-node-dev-server-audit.md`
//! rather than porting them. The pure, OS-facing primitives live here (spawn,
//! group-kill, listening-socket detection, input/argv resolution, container
//! detection, auto-attach hint); the HTTP handlers + the in-memory managed-proc
//! map + the persistence/re-attach wiring live in `server.rs`.
//!
//! Non-negotiable decisions (user, 2026-06-01 — see the handoff):
//!  - **argv, NO shell** (Node's `shell:true` + body `command` is a command-injection hole).
//!  - **own process group** (`process_group(0)`) so stop can group-kill the whole tree.
//!  - **stop = `kill(-pgid, SIGTERM)` → escalate `SIGKILL`** (intended divergence from Node,
//!    which orphans the real server by killing only the shell pid). Rust-test-gated.
//!  - **real listen detection** via the child *tree*'s sockets (`lsof -a -g <pgid>`), not
//!    log-scraping.

use serde_json::{json, Value};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Logs retained per managed process (Node keeps ≤500, returns the last 100).
pub const MAX_LOG_LINES: usize = 500;

/// How long after spawn we keep polling sockets at the fast cadence before
/// giving up on a `running` flip (the process then stays `starting`).
pub const DETECT_TIMEOUT: Duration = Duration::from_secs(5);
/// Fast socket-poll cadence during the detect window.
pub const DETECT_INTERVAL: Duration = Duration::from_millis(100);

/// What the user asked to start: an explicit `command` string, a package.json
/// `script` name, or (neither) the default `npm run dev`. Mirrors Node's body.
#[derive(Debug, Default)]
pub struct DevServerRequest {
    pub command: Option<String>,
    pub script: Option<String>,
}

/// The resolved, validated launch: the **argv** we actually exec (no shell) plus
/// the **display command** string we report back (matches Node's `finalCommand`).
#[derive(Debug, PartialEq, Eq)]
pub struct ResolvedLaunch {
    pub argv: Vec<String>,
    pub display: String,
}

/// Reject anything that would only matter to a shell — we never invoke a shell,
/// so a metacharacter in `command`/`script` can only be an injection attempt.
fn has_shell_meta(s: &str) -> bool {
    s.chars().any(|c| matches!(c, ';' | '|' | '&' | '$' | '`' | '(' | ')' | '<' | '>' | '\n' | '\r' | '*' | '?' | '{' | '}' | '\\' | '"' | '\''))
}

/// Resolve the request to an argv we can exec directly (no shell), validating
/// inputs. `command` is split on whitespace into argv (NOT handed to a shell);
/// `script` becomes `npm run <script>`; neither → `npm run dev`.
///
/// Returns `Err(message)` for an empty/meta-laden command or a bad script name
/// (the handler maps this to 400). This is the fix for audit bug #1.
pub fn resolve_launch(req: &DevServerRequest) -> Result<ResolvedLaunch, String> {
    if let Some(cmd) = req.command.as_ref().map(|c| c.trim()).filter(|c| !c.is_empty()) {
        if has_shell_meta(cmd) {
            return Err("Invalid command: shell metacharacters are not allowed".into());
        }
        let argv: Vec<String> = cmd.split_whitespace().map(String::from).collect();
        if argv.is_empty() {
            return Err("Invalid command".into());
        }
        return Ok(ResolvedLaunch { display: cmd.to_string(), argv });
    }
    if let Some(script) = req.script.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        // npm script names: a conservative safe charset (letters/digits/:_-./).
        if !script.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-' | '.' | '/')) {
            return Err("Invalid script name".into());
        }
        return Ok(ResolvedLaunch {
            display: format!("npm run {script}"),
            argv: vec!["npm".into(), "run".into(), script.into()],
        });
    }
    Ok(ResolvedLaunch {
        display: "npm run dev".into(),
        argv: vec!["npm".into(), "run".into(), "dev".into()],
    })
}

/// A spawned dev process: its pid, its **own** process-group id (== pid, since we
/// `setpgid(0,0)`), and the `Child` (owned by the caller's monitor for reaping).
pub struct Spawned {
    pub pid: u32,
    pub pgid: i32,
    pub child: Child,
}

/// Spawn `argv` in `cwd` with **no shell**, in its **own process group** so the
/// whole tree (incl. grandchildren) can be group-killed on stop. stdout/stderr
/// are piped so the monitor can capture logs; stdin is null. (Fixes bugs #1, #2.)
#[cfg(unix)]
pub fn spawn_dev_process(argv: &[String], cwd: &str) -> std::io::Result<Spawned> {
    use std::os::unix::process::CommandExt;
    if argv.is_empty() {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "empty argv"));
    }
    let child = Command::new(&argv[0])
        .args(&argv[1..])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0) // setpgid(0,0): new group, pgid == child pid
        .spawn()?;
    let pid = child.id();
    Ok(Spawned { pid, pgid: pid as i32, child })
}

#[cfg(not(unix))]
pub fn spawn_dev_process(_argv: &[String], _cwd: &str) -> std::io::Result<Spawned> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "dev-server management requires a Unix process group",
    ))
}

/// True if **any** process in the group is still alive (`kill(-pgid, 0)` == 0).
/// `Err(ESRCH)` → the whole tree is gone. Used by `GET` liveness + stop-confirm.
#[cfg(unix)]
pub fn group_alive(pgid: i32) -> bool {
    pgid > 1 && unsafe { libc::kill(-pgid, 0) } == 0
}

#[cfg(not(unix))]
pub fn group_alive(_pgid: i32) -> bool {
    false
}

/// Outcome of the first signal of a stop, so the handler can tell "killed" from
/// "was already gone" (Node's ESRCH → `note: "Process already exited"`).
#[derive(Debug, PartialEq, Eq)]
pub enum StopOutcome {
    /// The signal was delivered to a live group.
    Signalled,
    /// The group was already gone (ESRCH) before we signalled.
    AlreadyExited,
    /// Some other kill error (permission, etc.).
    Error(String),
}

/// Group-kill the whole tree: send `signal` to `-pgid`, then (for SIGTERM)
/// escalate to SIGKILL if anything survives the grace window. This is the
/// intended divergence from Node's orphaning stop — it kills the real server,
/// not just the shell. (Fixes bug #2.)
#[cfg(unix)]
pub fn stop_group(pgid: i32, signal: i32) -> StopOutcome {
    if pgid <= 1 {
        return StopOutcome::Error("refusing to signal pgid <= 1".into());
    }
    let rc = unsafe { libc::kill(-pgid, signal) };
    if rc != 0 {
        let err = std::io::Error::last_os_error();
        return match err.raw_os_error() {
            Some(libc::ESRCH) => StopOutcome::AlreadyExited,
            _ => StopOutcome::Error(err.to_string()),
        };
    }
    // Escalate: give a SIGTERM a short grace window, then SIGKILL the survivors.
    if signal == libc::SIGTERM {
        let deadline = Instant::now() + Duration::from_millis(1500);
        while Instant::now() < deadline {
            if !group_alive(pgid) {
                return StopOutcome::Signalled;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        if group_alive(pgid) {
            unsafe { libc::kill(-pgid, libc::SIGKILL) };
        }
    }
    StopOutcome::Signalled
}

#[cfg(not(unix))]
pub fn stop_group(_pgid: i32, _signal: i32) -> StopOutcome {
    StopOutcome::Error("unsupported on non-Unix".into())
}

/// Signal name → number, defaulting to SIGTERM. Only SIGTERM/SIGKILL are
/// honoured (matching Node's body handling: `signal === 'SIGKILL'` else default).
#[cfg(unix)]
pub fn signal_from_name(name: &str) -> (i32, &'static str) {
    if name == "SIGKILL" {
        (libc::SIGKILL, "SIGKILL")
    } else {
        (libc::SIGTERM, "SIGTERM")
    }
}

#[cfg(not(unix))]
pub fn signal_from_name(name: &str) -> (i32, &'static str) {
    if name == "SIGKILL" { (9, "SIGKILL") } else { (15, "SIGTERM") }
}

/// Poll the child **tree**'s real listening TCP sockets via
/// `lsof -nP -a -g <pgid> -iTCP -sTCP:LISTEN`. The `-a` ANDs the group filter
/// with the LISTEN filter, so every row belongs to our group. Returns **all**
/// bound ports, sorted+deduped. Best-effort: a missing/failed `lsof` → empty.
/// (Fixes bug #4 — real sockets, all ports, not a single log-scraped guess.)
pub fn poll_listening_ports(pgid: i32) -> Vec<u16> {
    let out = Command::new("lsof")
        .args(["-nP", "-a", "-g", &pgid.to_string(), "-iTCP", "-sTCP:LISTEN"])
        .output();
    match out {
        Ok(o) => parse_lsof_listen_ports(&String::from_utf8_lossy(&o.stdout)),
        Err(_) => Vec::new(),
    }
}

/// Parse listening ports out of `lsof` output: each `(LISTEN)` row's NAME column
/// is `host:port` (`127.0.0.1:3000`, `*:8080`, `[::1]:5173`). Sorted + deduped.
pub fn parse_lsof_listen_ports(text: &str) -> Vec<u16> {
    let mut ports: Vec<u16> = Vec::new();
    for line in text.lines() {
        if !line.contains("(LISTEN)") {
            continue;
        }
        for tok in line.split_whitespace() {
            if let Some(idx) = tok.rfind(':') {
                if let Ok(p) = tok[idx + 1..].parse::<u16>() {
                    if p != 0 && !ports.contains(&p) {
                        ports.push(p);
                    }
                }
            }
        }
    }
    ports.sort_unstable();
    ports.dedup();
    ports
}

/// Block until the tree binds ≥1 port (returns them) or the process exits / the
/// timeout elapses (returns whatever's bound — possibly empty). `is_alive` lets
/// the caller short-circuit when the direct child has already exited.
pub fn wait_for_ports(pgid: i32, timeout: Duration, mut is_alive: impl FnMut() -> bool) -> Vec<u16> {
    let deadline = Instant::now() + timeout;
    loop {
        let ports = poll_listening_ports(pgid);
        if !ports.is_empty() {
            return ports;
        }
        if !is_alive() || Instant::now() >= deadline {
            return ports;
        }
        std::thread::sleep(DETECT_INTERVAL);
    }
}

/// Detect that `project_path` is a devcontainer / remote / Codespaces workspace,
/// in which case the ports we detect are **container-local, not host-mapped**
/// (audit bug #8, v1 = detect-and-warn; forward-table resolution is a v2 follow-up).
pub fn detect_container_local(project_path: &str) -> bool {
    std::path::Path::new(project_path).join(".devcontainer").exists()
        || std::env::var_os("SSH_CONNECTION").is_some()
        || std::env::var_os("CODESPACES").is_some()
        || std::env::var_os("REMOTE_CONTAINERS").is_some()
}

/// Build the **auto-attach hint** that ties a detected port back to monitoring —
/// the feature's reason to exist (Node never connected the two; audit bug #5).
///
/// Safety contract (the hint must be a **safe no-op** on a wrong/duplicate/stale
/// detection, never a misfire):
///  - empty ports → `null` (nothing to attach; no-op).
///  - ports are deduped, so a duplicate detection collapses to one idempotent hint.
///  - when `container_local`, `hostReachable` is false and every target's `scan`
///    flag is false — a host-side scanner must not try to reach a container port.
///  - the hint is **declarative data** (a URL + an inject snippet), not an action;
///    a scan is gated on `scan:true` AND a live socket, so a stale port that
///    nothing listens on yields a connection-refused no-op rather than a misfire.
pub fn build_auto_attach(ports: &[u16], container_local: bool, project_id: &str) -> Value {
    let mut uniq: Vec<u16> = ports.to_vec();
    uniq.sort_unstable();
    uniq.dedup();
    uniq.retain(|p| *p != 0);
    if uniq.is_empty() {
        return Value::Null; // no-op
    }
    let host_reachable = !container_local;
    let primary = uniq[0];
    let targets: Vec<Value> = uniq
        .iter()
        .map(|p| {
            json!({
                "port": p,
                "url": format!("http://localhost:{p}"),
                // a scanner attaches only when the port is host-reachable.
                "scan": host_reachable,
            })
        })
        .collect();
    json!({
        "projectId": project_id,
        "port": primary,
        "ports": uniq,
        "hostReachable": host_reachable,
        "targets": targets,
        // Universal browser-SDK inject snippet keyed to the detected port. Safe to
        // surface repeatedly; injecting it twice is idempotent on the SDK side.
        "snippet": format!(
            "<script>window.__RUNTIMESCOPE_PROJECT__='{project_id}';</script>\
             <script src=\"https://unpkg.com/@runtimescope/sdk/dist/index.global.js\"></script>\
             <script>RuntimeScope.init({{projectId:'{project_id}'}});</script>"
        ),
        "note": if host_reachable {
            "Detected dev-server port(s); attach the SDK/scanner to monitor this app."
        } else {
            "Ports are container-local (devcontainer/remote); not host-mapped. Host scan suppressed."
        },
    })
}

#[cfg(all(test, unix))]
mod lifecycle_tests {
    //! The "no gaps" proof (handoff acceptance gate): spawn a REAL listener whose
    //! socket is held by a **grandchild**, detect its real port via the socket
    //! poll, group-kill the tree, then assert the port is freed AND the whole
    //! group is gone (the grandchild is reaped — not orphaned like Node).
    use super::*;
    use std::net::TcpListener;

    /// A node parent that forks a grandchild which binds 127.0.0.1:0 and stays
    /// alive. The grandchild — not the direct child — holds the socket, so a
    /// kill of only the direct pid (Node's bug) would orphan it; group-kill won't.
    /// Prints nothing port-related (so detection cannot cheat via logs).
    const PARENT_SRC: &str = "\
        const { spawn } = require('child_process');\
        const code = \"const net=require('net');const s=net.createServer(()=>{});\
            s.listen(0,'127.0.0.1');setInterval(()=>{},1e9);\";\
        spawn(process.execPath, ['-e', code], { stdio: 'inherit' });\
        setInterval(() => {}, 1e9);";

    fn node_available() -> bool {
        Command::new("node").arg("-v").output().map(|o| o.status.success()).unwrap_or(false)
    }

    #[test]
    fn spawn_detect_group_kill_frees_port_and_leaves_no_orphan() {
        if !node_available() {
            eprintln!("skip: node not on PATH");
            return;
        }
        let argv = vec!["node".to_string(), "-e".to_string(), PARENT_SRC.to_string()];
        let mut spawned = spawn_dev_process(&argv, "/tmp").expect("spawn");
        let pgid = spawned.pgid;

        // 1+2. Detect the REAL bound port via the socket poll (grandchild's port).
        let pid = spawned.pid;
        let ports = wait_for_ports(pgid, Duration::from_secs(8), || {
            // alive if the direct child hasn't exited
            unsafe { libc::kill(pid as i32, 0) == 0 }
        });
        assert!(!ports.is_empty(), "should detect the grandchild's real listening port");
        let port = ports[0];
        assert!(group_alive(pgid), "group should be alive before stop");
        eprintln!("[lifecycle] spawned pgid={pgid}; detected real listening port(s) {ports:?} via socket poll; group alive=true");

        // 3. Group-kill the whole tree (SIGTERM → escalate SIGKILL).
        let outcome = stop_group(pgid, signal_from_name("SIGTERM").0);
        assert_eq!(outcome, StopOutcome::Signalled);

        // Reap the direct child so it isn't left a zombie (the monitor does this
        // in production; here the test owns the Child).
        let _ = spawned.child.wait();

        // 4a. No orphan: the whole group is gone (grandchild reaped, not just the
        // shell) — poll briefly since init reaps the grandchild asynchronously.
        let gone_by = Instant::now() + Duration::from_secs(5);
        while group_alive(pgid) && Instant::now() < gone_by {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!group_alive(pgid), "no orphan: the grandchild must be gone after group-kill");

        // 4b. The port is actually freed: we can re-bind it.
        let mut rebound = false;
        let rebind_by = Instant::now() + Duration::from_secs(5);
        while Instant::now() < rebind_by {
            if TcpListener::bind(("127.0.0.1", port)).is_ok() {
                rebound = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(rebound, "port {port} must be free after group-kill (was the server orphaned?)");
        eprintln!("[lifecycle] after group-kill: group alive=false (no orphan grandchild); port {port} re-bound successfully (freed)");
    }

    #[test]
    fn already_exited_group_reports_already_exited() {
        if !node_available() {
            eprintln!("skip: node not on PATH");
            return;
        }
        let argv = vec!["node".to_string(), "-e".to_string(), "process.exit(0)".to_string()];
        let mut spawned = spawn_dev_process(&argv, "/tmp").expect("spawn");
        let pgid = spawned.pgid;
        let _ = spawned.child.wait(); // reap; group now empty
        // Give the (already-exited) tree a moment to fully drain.
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(stop_group(pgid, signal_from_name("SIGTERM").0), StopOutcome::AlreadyExited);
    }
}

#[cfg(test)]
mod unit_tests {
    use super::*;

    #[test]
    fn resolve_launch_defaults_to_npm_run_dev() {
        let r = resolve_launch(&DevServerRequest::default()).unwrap();
        assert_eq!(r.argv, vec!["npm", "run", "dev"]);
        assert_eq!(r.display, "npm run dev");
    }

    #[test]
    fn resolve_launch_script_becomes_npm_run_script() {
        let r = resolve_launch(&DevServerRequest { script: Some("start:web".into()), ..Default::default() }).unwrap();
        assert_eq!(r.argv, vec!["npm", "run", "start:web"]);
        assert_eq!(r.display, "npm run start:web");
    }

    #[test]
    fn resolve_launch_command_is_argv_not_shell() {
        let r = resolve_launch(&DevServerRequest { command: Some("pnpm dev --port 4000".into()), ..Default::default() }).unwrap();
        assert_eq!(r.argv, vec!["pnpm", "dev", "--port", "4000"]);
        assert_eq!(r.display, "pnpm dev --port 4000");
    }

    #[test]
    fn resolve_launch_rejects_injection() {
        // The exact Node command-injection payload from the audit must be refused.
        assert!(resolve_launch(&DevServerRequest { command: Some("npm run dev; rm -rf ~".into()), ..Default::default() }).is_err());
        assert!(resolve_launch(&DevServerRequest { command: Some("vite && curl evil".into()), ..Default::default() }).is_err());
        assert!(resolve_launch(&DevServerRequest { command: Some("$(touch pwned)".into()), ..Default::default() }).is_err());
        assert!(resolve_launch(&DevServerRequest { script: Some("dev; rm -rf ~".into()), ..Default::default() }).is_err());
    }

    #[test]
    fn parse_lsof_handles_ipv4_ipv6_wildcard_and_multiport() {
        let text = "\
COMMAND  PID  PGID USER FD TYPE DEVICE SIZE/OFF NODE NAME
node    100  100  me   12u IPv4 0xabc  0t0 TCP 127.0.0.1:3000 (LISTEN)
node    101  100  me   13u IPv6 0xdef  0t0 TCP [::1]:5173 (LISTEN)
node    102  100  me   14u IPv4 0x123  0t0 TCP *:8080 (LISTEN)
node    100  100  me   20u IPv4 0x999  0t0 TCP 127.0.0.1:3000->127.0.0.1:9 (ESTABLISHED)
";
        assert_eq!(parse_lsof_listen_ports(text), vec![3000, 5173, 8080]);
    }

    #[test]
    fn build_auto_attach_is_noop_on_empty() {
        assert_eq!(build_auto_attach(&[], false, "proj-1"), Value::Null);
    }

    #[test]
    fn build_auto_attach_dedupes_duplicate_detection() {
        let h = build_auto_attach(&[3000, 3000, 3000], false, "proj-1");
        assert_eq!(h["ports"], json!([3000]));
        assert_eq!(h["port"], 3000);
        assert_eq!(h["hostReachable"], true);
        assert_eq!(h["targets"][0]["scan"], true);
    }

    #[test]
    fn build_auto_attach_suppresses_scan_when_container_local() {
        let h = build_auto_attach(&[3000, 5173], true, "proj-1");
        assert_eq!(h["hostReachable"], false);
        // every target's scan flag is false → a host scanner is a no-op.
        for t in h["targets"].as_array().unwrap() {
            assert_eq!(t["scan"], false);
        }
    }

    #[test]
    fn detect_container_local_true_with_devcontainer_dir() {
        let dir = std::env::temp_dir().join(format!("rs-devc-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".devcontainer")).unwrap();
        assert!(detect_container_local(dir.to_str().unwrap()));
        let plain = std::env::temp_dir().join(format!("rs-plain-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&plain);
        std::fs::create_dir_all(&plain).unwrap();
        // (No SSH/Codespaces env in the test runner.)
        if std::env::var_os("SSH_CONNECTION").is_none()
            && std::env::var_os("CODESPACES").is_none()
            && std::env::var_os("REMOTE_CONTAINERS").is_none()
        {
            assert!(!detect_container_local(plain.to_str().unwrap()));
        }
    }
}

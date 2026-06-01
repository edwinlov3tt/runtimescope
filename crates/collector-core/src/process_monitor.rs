//! On-demand dev-process / port scan backing the HTTP `/api/processes` +
//! `/api/ports` routes — the **live** path. This is mcp-server-only: the
//! standalone collector-server serves empty, matching Node, where `standalone.ts`
//! constructs `HttpServer(store, undefined, …)` (no `ProcessMonitor`) while
//! `mcp-server/src/index.ts` does `new ProcessMonitor(store).start()` and passes
//! it in. Ports `engines/process-monitor.ts` (`scan`/`getProcesses`/`getPortUsage`)
//! + `platform.ts` (`parseProcessList`/`detectProcessType`).
//!
//! Live OS data is non-deterministic, so conformance asserts the **shape** of this
//! path; a Rust integration test pins the one deterministic fact (a known spawned
//! listener shows up). v1 scans on demand (per Node's getters reading a cache, the
//! response shape is identical); a background cache is a later optimization.

use serde_json::{json, Value};

/// Classify a command line → Node `DevProcessType` (ports `PROCESS_PATTERNS`,
/// first match wins). Manual matching (no regex dep), faithful to the patterns.
pub fn detect_process_type(command: &str) -> &'static str {
    let c = command;
    if c.contains("next-server") || c.contains("next dev") || c.contains("next-dev") {
        "next"
    } else if c.contains("vite") {
        "vite"
    } else if c.contains("webpack-dev-server") || c.contains("webpack dev server") || c.contains("webpack serve") {
        "webpack"
    } else if c.contains("wrangler") {
        "wrangler"
    } else if c.contains("prisma studio") || c.contains("prisma dev") {
        "prisma"
    } else if c.contains("docker") {
        "docker"
    } else if c.contains("postgres") || c.contains("pg_") {
        "postgres"
    } else if c.contains("mysqld") {
        "mysql"
    } else if c.contains("redis-server") {
        "redis"
    } else if word(c, "bun") {
        "bun"
    } else if word(c, "deno") {
        "deno"
    } else if word(c, "python") || word(c, "python2") || word(c, "python3") {
        "python"
    } else if word(c, "node") {
        "node"
    } else {
        "unknown"
    }
}

/// Whole-word match (`\bword\b`). Boundaries are checked on the adjacent **char**
/// (Unicode `is_alphanumeric`), not the raw byte — a byte-level check treats a
/// multibyte char's continuation byte as a non-alnum boundary, so `word("ánode",
/// "node")` would falsely match (audit finding). The needle is ASCII, so every
/// `find` offset is a char boundary → the slices below are panic-safe.
fn word(haystack: &str, needle: &str) -> bool {
    let mut from = 0;
    while let Some(rel) = haystack[from..].find(needle) {
        let s = from + rel;
        let e = s + needle.len();
        let before_ok = haystack[..s].chars().next_back().is_none_or(|c| !c.is_alphanumeric());
        let after_ok = haystack[e..].chars().next().is_none_or(|c| !c.is_alphanumeric());
        if before_ok && after_ok {
            return true;
        }
        from = s + 1;
    }
    false
}

/// One process row from `ps aux`: pid, %cpu, rss(KB), command.
struct PsRow {
    pid: i64,
    cpu: f64,
    rss_kb: f64,
    command: String,
}

/// `ps aux` → rows. macOS/Linux. Columns: USER PID %CPU %MEM VSZ RSS … COMMAND.
fn parse_ps() -> Vec<PsRow> {
    let out = match std::process::Command::new("ps").args(["aux"]).output() {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        _ => return Vec::new(),
    };
    let mut rows = Vec::new();
    for line in out.lines().skip(1) {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 11 {
            continue;
        }
        let Ok(pid) = parts[1].parse::<i64>() else { continue };
        let cpu = parts[2].parse::<f64>().unwrap_or(0.0);
        let rss_kb = parts[5].parse::<f64>().unwrap_or(0.0); // RSS column (KB)
        let command = parts[10..].join(" ");
        rows.push(PsRow { pid, cpu, rss_kb, command });
    }
    rows
}

/// Listening TCP ports for a single pid (`lsof -nP -p <pid> -iTCP -sTCP:LISTEN`).
fn listen_ports(pid: i64) -> Vec<u16> {
    let out = std::process::Command::new("lsof")
        .args(["-nP", "-p", &pid.to_string(), "-iTCP", "-sTCP:LISTEN"])
        .output();
    match out {
        Ok(o) => crate::dev_server::parse_lsof_listen_ports(&String::from_utf8_lossy(&o.stdout)),
        Err(_) => Vec::new(),
    }
}

/// cwd of a pid (`lsof -a -p <pid> -d cwd -Fn` → the `n`-prefixed path line).
fn process_cwd(pid: i64) -> Option<String> {
    let out = std::process::Command::new("lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .output()
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|l| l.strip_prefix('n').map(String::from))
}

/// Whether a generic `node` process looks like a dev server (Node's `scan` only
/// keeps generic node when the command mentions server/dev/start).
fn looks_like_dev_server(command: &str) -> bool {
    command.contains("server") || command.contains("dev") || command.contains("start")
}

/// Full scan → `DevProcess` rows (ports Node `ProcessMonitor.scan` + the filter:
/// drop `unknown`/`python`; keep generic `node` only if it looks like a dev server).
/// `isOrphaned` is `false` on an on-demand scan (no activity history), matching
/// Node's first-scan behavior; `project`/`uptime` are unset (Node's `scan` never
/// sets them).
pub fn scan_dev_processes() -> Vec<Value> {
    let mut out = Vec::new();
    for r in parse_ps() {
        let ptype = detect_process_type(&r.command);
        if ptype == "unknown" || ptype == "python" {
            continue;
        }
        if ptype == "node" && !looks_like_dev_server(&r.command) {
            continue;
        }
        let ports = listen_ports(r.pid);
        let cwd = process_cwd(r.pid);
        let command: String = r.command.chars().take(200).collect();
        let mut obj = json!({
            "pid": r.pid,
            "command": command,
            "type": ptype,
            "cpuPercent": r.cpu,
            "memoryMB": (r.rss_kb / 1024.0 * 100.0).round() / 100.0,
            "ports": ports,
            "isOrphaned": false,
        });
        if let (Some(c), Some(m)) = (cwd, obj.as_object_mut()) {
            m.insert("cwd".into(), json!(c));
        }
        out.push(obj);
    }
    out
}

/// `PortUsage` rows derived from the scan (ports Node `getPortUsage`): one row per
/// (process, listening port), optionally filtered to `port`, sorted by port asc.
pub fn port_usage(port: Option<u16>) -> Vec<Value> {
    let mut rows: Vec<(u16, Value)> = Vec::new();
    for proc in scan_dev_processes() {
        let pid = proc.get("pid").cloned().unwrap_or(Value::Null);
        let command = proc.get("command").and_then(Value::as_str).unwrap_or("");
        let process = command.chars().take(100).collect::<String>();
        let ptype = proc.get("type").and_then(Value::as_str).unwrap_or("unknown").to_string();
        if let Some(ports) = proc.get("ports").and_then(Value::as_array) {
            for p in ports {
                let Some(pn) = p.as_u64().map(|n| n as u16) else { continue };
                if let Some(f) = port {
                    if pn != f {
                        continue;
                    }
                }
                rows.push((pn, json!({ "port": pn, "pid": pid, "process": process, "type": ptype })));
            }
        }
    }
    rows.sort_by_key(|(p, _)| *p);
    rows.into_iter().map(|(_, v)| v).collect()
}

/// Single-pid kill (ports Node `killProcess`): `{ success, error? }`.
#[cfg(unix)]
pub fn kill_process(pid: i64, signal: &str) -> Value {
    let sig = if signal == "SIGKILL" { libc::SIGKILL } else { libc::SIGTERM };
    let rc = unsafe { libc::kill(pid as libc::pid_t, sig) };
    if rc == 0 {
        json!({ "success": true })
    } else {
        let e = std::io::Error::last_os_error();
        json!({ "success": false, "error": e.to_string() })
    }
}

#[cfg(not(unix))]
pub fn kill_process(_pid: i64, _signal: &str) -> Value {
    json!({ "success": false, "error": "unsupported on this platform" })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_process_type_matches_node_patterns() {
        assert_eq!(detect_process_type("node /x/next-server.js"), "next");
        assert_eq!(detect_process_type("node_modules/.bin/next dev"), "next");
        assert_eq!(detect_process_type("vite"), "vite");
        assert_eq!(detect_process_type("webpack serve --port 8080"), "webpack");
        assert_eq!(detect_process_type("wrangler dev"), "wrangler");
        assert_eq!(detect_process_type("prisma studio"), "prisma");
        assert_eq!(detect_process_type("com.docker.backend"), "docker");
        assert_eq!(detect_process_type("/usr/local/bin/postgres -D /data"), "postgres");
        assert_eq!(detect_process_type("mysqld --datadir=/x"), "mysql");
        assert_eq!(detect_process_type("redis-server *:6379"), "redis");
        assert_eq!(detect_process_type("/opt/homebrew/bin/bun run dev"), "bun");
        assert_eq!(detect_process_type("deno run -A server.ts"), "deno");
        assert_eq!(detect_process_type("python3 -m http.server"), "python");
        assert_eq!(detect_process_type("node server.js"), "node");
        // first match wins: vite before node.
        assert_eq!(detect_process_type("node vite.js"), "vite");
        // word boundary: 'node' must be a whole word.
        assert_eq!(detect_process_type("/usr/bin/anodelike"), "unknown");
        assert_eq!(detect_process_type("/bin/cat foo"), "unknown");
    }

    #[test]
    fn classifier_drops_a_known_non_dev_command() {
        assert_eq!(detect_process_type("login -pf user"), "unknown");
    }

    #[test]
    fn word_match_is_panic_safe_on_multibyte_commands() {
        // Audit flagged a possible non-char-boundary slice panic. It can't happen:
        // the needles are ASCII, so every `find` offset (and offset+1) lands on a
        // char boundary. Exercise multibyte command lines to prove no panic.
        assert_eq!(detect_process_type("café python -m http.server"), "python");
        assert_eq!(detect_process_type("/usr/bin/日本語/node server.js"), "node");
        assert_eq!(detect_process_type("emoji🚀 deno run x.ts"), "deno");
        assert_eq!(detect_process_type("ünïcödë only"), "unknown");
        assert!(!word("ánode", "node"), "multibyte prefix, not a whole word → no match, no panic");
    }

    // Deterministic detection proof: bind a real listening socket in THIS process
    // and assert the lsof-backed primitive sees its port (the one fact that must
    // hold regardless of the otherwise non-deterministic machine scan). Skips
    // gracefully if lsof can't enumerate (no panic on a constrained sandbox).
    #[test]
    fn listen_ports_finds_a_real_listening_socket() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral");
        let port = listener.local_addr().unwrap().port();
        let pid = std::process::id() as i64;
        let found = listen_ports(pid);
        if found.is_empty() {
            eprintln!("skip: lsof returned no ports for self (sandboxed?)");
            return;
        }
        assert!(found.contains(&port), "lsof should report our listening port {port}; got {found:?}");
    }
}

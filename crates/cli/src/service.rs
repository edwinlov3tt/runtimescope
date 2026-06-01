//! Background-service manager — ports `packages/cli/src/service.ts` (essential
//! set: install/uninstall/status/restart/stop). Adapted for the Rust port: the
//! service execs the **`collector-server` binary** (sibling of `runtimescope`, or
//! on PATH), not `node <standalone.js>`. argv, NO shell.
//!
//!  - macOS → launchd (`~/Library/LaunchAgents/com.runtimescope.collector.plist`)
//!  - Linux → systemd user unit (`~/.config/systemd/user/runtimescope.service`)
//!
//! Deferred to the distribution fast-follow: `service update` (npm), `doctor`,
//! `mcp` diagnostics.

use std::path::{Path, PathBuf};
use std::process::Command;

const LAUNCHD_LABEL: &str = "com.runtimescope.collector";

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
}
fn launchd_plist() -> PathBuf {
    home().join("Library/LaunchAgents").join(format!("{LAUNCHD_LABEL}.plist"))
}
fn systemd_unit_dir() -> PathBuf {
    home().join(".config/systemd/user")
}
fn systemd_unit() -> PathBuf {
    systemd_unit_dir().join("runtimescope.service")
}
fn logs_dir() -> PathBuf {
    home().join(".runtimescope/logs")
}

fn green(m: &str) { println!("  \x1b[32m✓\x1b[0m {m}"); }
fn warn(m: &str) { println!("  \x1b[33m⚠\x1b[0m {m}"); }
fn info(m: &str) { println!("  \x1b[2m{m}\x1b[0m"); }
fn errln(m: &str) { println!("  \x1b[31m✗\x1b[0m {m}"); }

/// Locate the `collector-server` binary: next to the running `runtimescope`
/// binary first, then on PATH. (Replaces Node's node_modules/standalone.js walk —
/// the Rust collector ships as a sibling binary.)
fn resolve_collector_path() -> Result<PathBuf, String> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let sib = dir.join("collector-server");
            if sib.exists() {
                return Ok(sib);
            }
        }
    }
    if let Ok(out) = Command::new("which").arg("collector-server").output() {
        if out.status.success() {
            let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !p.is_empty() && Path::new(&p).exists() {
                return Ok(PathBuf::from(p));
            }
        }
    }
    Err("Could not locate the `collector-server` binary — looked next to `runtimescope` and on PATH. \
         Install RuntimeScope so both binaries live in the same directory."
        .to_string())
}

fn ensure_logs_dir() {
    let _ = std::fs::create_dir_all(logs_dir());
}

/// The collector's HTTP port — honors `RUNTIMESCOPE_HTTP_PORT` (default 6768), so
/// the readyz poll + dashboard URL match a custom-port collector (collector-server
/// reads the same env). Audit finding: a hardcoded 6768 polled the wrong port.
pub fn http_port() -> u16 {
    std::env::var("RUNTIMESCOPE_HTTP_PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(6768)
}

/// Run a command and **surface a non-zero exit as an error** (audit: a fail-loud
/// op must never report success on failure — "never discard a `Result` on a
/// write/IO path"). Node's `execFileSync` throws on non-zero; this mirrors that.
fn run_checked(label: &str, cmd: &mut Command) -> Result<(), String> {
    match cmd.status() {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => Err(format!("{label} failed (exit {})", s.code().unwrap_or(-1))),
        Err(e) => Err(format!("{label} could not run: {e}")),
    }
}

/// Raw, dependency-free readiness poll: TCP-connect to the HTTP port and parse the
/// HTTP **status line** for a 2xx code (not a fragile substring). Mirrors Node's
/// `res.ok` `/readyz` wait.
fn wait_for_collector_ready(timeout: std::time::Duration) -> bool {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    let port = http_port();
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if let Ok(mut s) = TcpStream::connect(("127.0.0.1", port)) {
            let _ = s.set_read_timeout(Some(std::time::Duration::from_millis(500)));
            if s.write_all(b"GET /readyz HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n").is_ok() {
                let mut buf = [0u8; 128];
                if let Ok(n) = s.read(&mut buf) {
                    // Parse "HTTP/1.x <code> ..." and accept 2xx.
                    if let Some(code) = String::from_utf8_lossy(&buf[..n])
                        .lines()
                        .next()
                        .and_then(|l| l.split_whitespace().nth(1))
                        .and_then(|c| c.parse::<u16>().ok())
                    {
                        if (200..=299).contains(&code) {
                            return true;
                        }
                    }
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    false
}

// ---------- launchd (macOS) ----------

/// The launchd plist. ProgramArguments is the single `collector-server` binary
/// (no node). KeepAlive restarts on crash but not clean exit; 256 MB RSS ceiling.
pub fn build_launchd_plist(collector: &str) -> String {
    let h = home();
    let logs = logs_dir();
    // Escape XML element content — a path with & < > (e.g. HOME=/Users/a&b) would
    // otherwise corrupt the plist (Node has the same unescaped-interpolation bug).
    let collector = xml_escape(collector);
    let h = xml_escape(&h.to_string_lossy());
    let out = xml_escape(&logs.join("collector.out.log").to_string_lossy());
    let err = xml_escape(&logs.join("collector.err.log").to_string_lossy());
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LAUNCHD_LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>{collector}</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
    <key>Crashed</key>
    <true/>
  </dict>

  <key>StandardOutPath</key>
  <string>{out}</string>

  <key>StandardErrorPath</key>
  <string>{err}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    <key>HOME</key>
    <string>{h}</string>
  </dict>

  <key>ProcessType</key>
  <string>Background</string>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>HardResourceLimits</key>
  <dict>
    <key>ResidentSetSize</key>
    <integer>268435456</integer>
  </dict>
</dict>
</plist>
"#
    )
}

/// Escape XML element content (`&`, `<`, `>`) so a path with those characters
/// doesn't corrupt the plist. Order matters — `&` first.
fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn install_launchd() -> Result<(), String> {
    let collector = resolve_collector_path()?;
    let collector = collector.to_string_lossy().to_string();
    ensure_logs_dir();
    let plist = launchd_plist();
    if let Some(dir) = plist.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Unload any existing instance for a clean reinstall.
    let _ = Command::new("launchctl").args(["unload", "-w"]).arg(&plist).output();
    std::fs::write(&plist, build_launchd_plist(&collector)).map_err(|e| e.to_string())?;
    green(&format!("Wrote {}", plist.to_string_lossy()));
    run_checked("launchctl load", Command::new("launchctl").args(["load", "-w"]).arg(&plist))?;
    info(&format!("Collector: {collector}"));
    info(&format!("Logs:      {}", logs_dir().to_string_lossy()));
    report_ready();
    Ok(())
}

fn uninstall_launchd() {
    let plist = launchd_plist();
    if !plist.exists() {
        info("Service is not installed.");
        return;
    }
    let _ = Command::new("launchctl").args(["unload", "-w"]).arg(&plist).output();
    let _ = std::fs::remove_file(&plist);
    green("Service uninstalled");
}

fn status_launchd() {
    let plist = launchd_plist();
    if !plist.exists() {
        info("Service not installed. Run: runtimescope service install");
        return;
    }
    match Command::new("launchctl").args(["list", LAUNCHD_LABEL]).output() {
        Ok(o) if o.status.success() => {
            let out = String::from_utf8_lossy(&o.stdout);
            if let Some(pid) = extract_plist_int(&out, "PID") {
                green(&format!("Service running — PID {pid}"));
            } else {
                warn("Service installed but not currently running");
            }
            if let Some(code) = extract_plist_int(&out, "LastExitStatus") {
                info(&format!("Last exit status: {code}"));
            }
            info(&format!("Plist: {}", plist.to_string_lossy()));
            info(&format!("Logs:  {}", logs_dir().to_string_lossy()));
        }
        _ => warn("Service installed but launchctl could not query it"),
    }
}

fn restart_launchd() -> Result<(), String> {
    let plist = launchd_plist();
    if !plist.exists() {
        return Err("Service not installed. Run: runtimescope service install".to_string());
    }
    run_checked("launchctl unload", Command::new("launchctl").arg("unload").arg(&plist))?;
    run_checked("launchctl load", Command::new("launchctl").arg("load").arg(&plist))?;
    green("Service restarted");
    Ok(())
}

fn stop_launchd() {
    let plist = launchd_plist();
    if !plist.exists() {
        errln("Service not installed. Run: runtimescope service install");
        return;
    }
    match Command::new("launchctl").arg("unload").arg(&plist).output() {
        Ok(o) if o.status.success() => {
            green("Service stopped (plist preserved — run `service restart` to start again)")
        }
        _ => info("Service was not running."),
    }
}

/// Parse a launchd property-list integer line: `"KEY" = 12345;`.
fn extract_plist_int(out: &str, key: &str) -> Option<i64> {
    let needle = format!("\"{key}\"");
    let line = out.lines().find(|l| l.contains(&needle))?;
    let after = line.split('=').nth(1)?;
    let digits: String = after.chars().filter(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

// ---------- systemd (Linux user service) ----------

/// The systemd user unit. ExecStart is the `collector-server` binary (no node).
pub fn build_systemd_unit(collector: &str) -> String {
    format!(
        r#"[Unit]
Description=RuntimeScope Collector
Documentation=https://github.com/edwinlov3tt/runtimescope
After=network.target

[Service]
Type=simple
ExecStart="{collector}"
Restart=on-failure
RestartSec=5
TimeoutStopSec=10

# Resource ceiling
MemoryMax=256M
CPUQuota=50%

# Logs to journal — tail with: journalctl --user -u runtimescope -f
StandardOutput=journal
StandardError=journal
SyslogIdentifier=runtimescope

[Install]
WantedBy=default.target
"#
    )
}

fn install_systemd() -> Result<(), String> {
    let collector = resolve_collector_path()?;
    let collector = collector.to_string_lossy().to_string();
    ensure_logs_dir();
    let _ = std::fs::create_dir_all(systemd_unit_dir());
    std::fs::write(systemd_unit(), build_systemd_unit(&collector)).map_err(|e| e.to_string())?;
    green(&format!("Wrote {}", systemd_unit().to_string_lossy()));
    run_checked("systemctl daemon-reload", Command::new("systemctl").args(["--user", "daemon-reload"]))?;
    run_checked(
        "systemctl enable --now",
        Command::new("systemctl").args(["--user", "enable", "--now", "runtimescope.service"]),
    )?;
    info(&format!("Collector: {collector}"));
    report_ready();
    info("Optional always-on (keep running when logged out): sudo loginctl enable-linger $USER");
    Ok(())
}

fn uninstall_systemd() {
    if !systemd_unit().exists() {
        info("Service is not installed.");
        return;
    }
    let _ = Command::new("systemctl").args(["--user", "disable", "--now", "runtimescope.service"]).output();
    let _ = std::fs::remove_file(systemd_unit());
    let _ = Command::new("systemctl").args(["--user", "daemon-reload"]).status();
    green("Service uninstalled");
}

fn status_systemd() {
    if !systemd_unit().exists() {
        info("Service not installed. Run: runtimescope service install");
        return;
    }
    match Command::new("systemctl").args(["--user", "is-active", "runtimescope.service"]).output() {
        Ok(o) => {
            let state = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if state == "active" {
                green("Service is active");
            } else {
                warn(&format!("Service state: {state}"));
            }
        }
        Err(_) => warn("Service not active"),
    }
    info(&format!("Unit file: {}", systemd_unit().to_string_lossy()));
    info("Logs: journalctl --user -u runtimescope -f");
}

fn restart_systemd() -> Result<(), String> {
    if !systemd_unit().exists() {
        return Err("Service not installed. Run: runtimescope service install".to_string());
    }
    run_checked(
        "systemctl restart",
        Command::new("systemctl").args(["--user", "restart", "runtimescope.service"]),
    )?;
    green("Service restarted");
    Ok(())
}

fn stop_systemd() {
    if !systemd_unit().exists() {
        errln("Service not installed. Run: runtimescope service install");
        return;
    }
    match Command::new("systemctl").args(["--user", "stop", "runtimescope.service"]).status() {
        Ok(s) if s.success() => green("Service stopped (unit preserved — run `service restart` to start again)"),
        _ => info("Service was not running."),
    }
}

// ---------- platform dispatch ----------

fn report_ready() {
    println!();
    info("Waiting for collector to come up…");
    if wait_for_collector_ready(std::time::Duration::from_secs(60)) {
        green(&format!("Collector is healthy and serving on http://127.0.0.1:{}", http_port()));
    } else {
        errln("Collector did not respond on /readyz within 60s.");
        info("Common causes: another process holding 6767/6768, or a crash on startup.");
    }
}

#[derive(PartialEq)]
enum Os {
    Mac,
    Linux,
    Other,
}
fn os() -> Os {
    match std::env::consts::OS {
        "macos" => Os::Mac,
        "linux" => Os::Linux,
        _ => Os::Other,
    }
}

/// `runtimescope service <subcmd>`. Essential set; unknown/`update` point at the
/// fast-follow.
pub fn run(subcmd: Option<&str>) -> i32 {
    if os() == Os::Other {
        errln(&format!("Platform '{}' is not supported (macOS launchd / Linux systemd only).", std::env::consts::OS));
        return 1;
    }
    let mac = os() == Os::Mac;
    let result: Result<(), String> = match subcmd {
        Some("install") => {
            if mac { install_launchd() } else { install_systemd() }
        }
        Some("uninstall") => {
            if mac { uninstall_launchd() } else { uninstall_systemd() }
            Ok(())
        }
        Some("status") => {
            if mac { status_launchd() } else { status_systemd() }
            Ok(())
        }
        Some("restart") | Some("start") => {
            if mac { restart_launchd() } else { restart_systemd() }
        }
        Some("stop") => {
            if mac { stop_launchd() } else { stop_systemd() }
            Ok(())
        }
        Some("update") => {
            warn("`service update` (npm self-update) is a post-v0.11.0 fast-follow.");
            info("For now, reinstall the binaries and run `runtimescope service install` to regenerate the unit.");
            Ok(())
        }
        Some("help") | Some("--help") | Some("-h") | None => {
            print_service_help();
            Ok(())
        }
        Some(other) => {
            errln(&format!("Unknown subcommand: {other}"));
            print_service_help();
            return 1;
        }
    };
    if let Err(e) = result {
        errln(&e);
        return 1;
    }
    0
}

fn print_service_help() {
    println!("  runtimescope service <subcommand>");
    println!();
    println!("    install     Install + start the background service (launchd/systemd)");
    println!("    stop        Stop the service (config preserved)");
    println!("    start       Alias for restart");
    println!("    restart     Restart the service");
    println!("    status      Show service state + PID");
    println!("    uninstall   Stop + remove the service config");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launchd_plist_execs_the_collector_binary_not_node() {
        let p = build_launchd_plist("/opt/rs/bin/collector-server");
        // Single ProgramArguments entry = the collector-server binary (NO node).
        assert!(p.contains("<string>/opt/rs/bin/collector-server</string>"));
        assert!(!p.contains("node"), "Rust service must not exec node");
        // Faithful launchd keys.
        assert!(p.contains("<key>Label</key>"));
        assert!(p.contains("com.runtimescope.collector"));
        assert!(p.contains("<key>RunAtLoad</key>"));
        assert!(p.contains("<key>KeepAlive</key>") && p.contains("<key>Crashed</key>"));
        assert!(p.contains("268435456"), "256MB RSS ceiling preserved");
        assert!(p.starts_with("<?xml"));
    }

    #[test]
    fn systemd_unit_execs_the_collector_binary_not_node() {
        let u = build_systemd_unit("/opt/rs/bin/collector-server");
        // ExecStart is QUOTED so a path with spaces isn't whitespace-split by systemd
        // (audit finding — an improvement over Node's unquoted template).
        assert!(u.contains("ExecStart=\"/opt/rs/bin/collector-server\""));
        assert!(!u.contains("node"), "Rust unit must not exec node");
        assert!(u.contains("Restart=on-failure"));
        assert!(u.contains("MemoryMax=256M"));
        assert!(u.contains("WantedBy=default.target"));
        // A path with spaces stays a single quoted argument.
        let spaced = build_systemd_unit("/opt/my dir/collector-server");
        assert!(spaced.contains("ExecStart=\"/opt/my dir/collector-server\""));
    }

    #[test]
    fn http_port_honors_env_override() {
        // Default when unset; the override path is exercised by the readyz poll +
        // dashboard URL. (Env is process-global; assert the default branch here.)
        std::env::remove_var("RUNTIMESCOPE_HTTP_PORT");
        assert_eq!(http_port(), 6768);
        std::env::set_var("RUNTIMESCOPE_HTTP_PORT", "7777");
        assert_eq!(http_port(), 7777);
        std::env::remove_var("RUNTIMESCOPE_HTTP_PORT");
    }

    #[test]
    fn extract_plist_int_parses_launchctl_fragments() {
        let out = "{\n\t\"PID\" = 12345;\n\t\"LastExitStatus\" = 0;\n}";
        assert_eq!(extract_plist_int(out, "PID"), Some(12345));
        assert_eq!(extract_plist_int(out, "LastExitStatus"), Some(0));
        assert_eq!(extract_plist_int(out, "Nope"), None);
    }
}

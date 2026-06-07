//! `runtimescope` CLI — Milestone 6 essential set: `service` lifecycle
//! (install/uninstall/status/restart/stop), `dashboard` (open the browser),
//! `version`, `help`. The Node CLI's doctor/mcp diagnostics + npm self-update are
//! a documented post-v0.11.0 fast-follow.

mod service;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let code = match args.get(1).map(String::as_str) {
        Some("--version") | Some("-v") | Some("version") => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            0
        }
        Some("service") => service::run(args.get(2).map(String::as_str)),
        Some("dashboard") => dashboard(&args[2..]),
        Some("mcp") => mcp_serve(&args[2..]),
        Some("help") | Some("--help") | Some("-h") | None => {
            print_help();
            0
        }
        Some(other) => {
            eprintln!("Unknown command: {other}");
            print_help();
            1
        }
    };
    std::process::exit(code);
}

/// `runtimescope mcp [--http]` — run the MCP server (embedded/attached collector,
/// ADR-0008). Default transport is **stdio** (the entrypoint Claude Code / the
/// plugin point at; stdout stays clean so the JSON-RPC stream isn't corrupted).
/// `--http` (or `RUNTIMESCOPE_MCP_TRANSPORT=http`) serves Streamable HTTP for
/// REMOTE access to a deployed app (ADR-0011) — bearer-gated, behind the tunnel.
fn mcp_serve(args: &[String]) -> i32 {
    let http = args.iter().any(|a| a == "--http")
        || std::env::var("RUNTIMESCOPE_MCP_TRANSPORT").as_deref() == Ok("http");
    let rt = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("[RuntimeScope] could not start the async runtime: {e}");
            return 1;
        }
    };
    let result = if http {
        rt.block_on(runtimescope_mcp::run_http())
    } else {
        rt.block_on(runtimescope_mcp::run())
    };
    match result {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("[RuntimeScope] mcp server exited with error: {e}");
            1
        }
    }
}

/// `runtimescope dashboard [--network]` — open the dashboard in the browser
/// (ports `dashboard-cmd.ts`'s essential path). `--network` prints the LAN URL +
/// the re-install hint instead of opening localhost.
fn dashboard(args: &[String]) -> i32 {
    let network = args.iter().any(|a| a == "--network");
    let port = service::http_port(); // honors RUNTIMESCOPE_HTTP_PORT
    if network {
        let host = local_ip().unwrap_or_else(|| "<your-LAN-IP>".to_string());
        println!("  LAN access needs the collector bound to 0.0.0.0:");
        println!("    RUNTIMESCOPE_HOST=0.0.0.0 runtimescope service install");
        println!("  Then open:  http://{host}:{port}/dashboard");
        return 0;
    }
    // One command spins it all up: make sure a collector is serving (start the
    // background service if none is), then open the embedded dashboard.
    if !service::ensure_running() {
        eprintln!("  Could not start the collector. Try `runtimescope service install` and check the logs.");
        return 1;
    }
    let url = format!("http://127.0.0.1:{port}/dashboard");
    println!("  Opening {url}");
    open_browser(&url)
}

fn open_browser(url: &str) -> i32 {
    // macOS `open`, Linux `xdg-open`. No shell; argv.
    let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    match std::process::Command::new(opener).arg(url).status() {
        Ok(s) if s.success() => 0,
        _ => {
            eprintln!("  Could not launch a browser. Open this URL manually: {url}");
            0 // non-fatal — the URL is printed
        }
    }
}

/// Best-effort LAN IP via the UDP-connect trick (no packets sent; just resolves
/// the local interface the kernel would route from). Dependency-free.
fn local_ip() -> Option<String> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    sock.local_addr().ok().map(|a| a.ip().to_string())
}

fn print_help() {
    println!("runtimescope {} — runtime monitoring for Claude Code", env!("CARGO_PKG_VERSION"));
    println!();
    println!("USAGE:");
    println!("  runtimescope <command>");
    println!();
    println!("COMMANDS:");
    println!("  service <sub>   Manage the background collector service");
    println!("                  (install | stop | start | restart | status | uninstall)");
    println!("  dashboard       Start the collector if needed + open the dashboard (--network for the LAN URL)");
    println!("  mcp             Run the MCP server over stdio (for Claude Code: claude mcp add runtimescope -- runtimescope mcp)");
    println!("  mcp --http      Run the MCP server over Streamable HTTP for remote access (ADR-0011; needs RUNTIMESCOPE_AUTH_TOKEN)");
    println!("  version         Print the version");
    println!("  help            Show this help");
}

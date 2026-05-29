//! `runtimescope` CLI — stub for Milestone 1.
//!
//! The real CLI (service install/stop/status, curl-install self-update, sdk
//! install) is ported in Milestone 6. This stub exists so the workspace builds
//! and `--version` works.

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("--version") | Some("-v") => println!("{}", env!("CARGO_PKG_VERSION")),
        _ => {
            eprintln!("runtimescope {} (Rust port — Milestone 1 stub)", env!("CARGO_PKG_VERSION"));
            eprintln!("Service lifecycle + install commands arrive in Milestone 6.");
        }
    }
}

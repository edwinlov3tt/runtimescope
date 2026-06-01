//! Guarantee the embedded-dashboard folder exists before compilation.
//!
//! `server.rs` embeds `../../packages/dashboard/dist/` via `rust-embed`
//! (`debug-embed` → at compile time, every profile). That folder is a build
//! artifact (gitignored), so a fresh checkout or a lean CI job that hasn't run
//! `npm run build -w packages/dashboard` yet would fail to compile with
//! "folder does not exist". Creating it here (empty if absent) lets pure-Rust
//! `cargo build`/`test`/`clippy` work anywhere.
//!
//! When the real SPA is present (release + conformance jobs build it BEFORE
//! cargo), this `create_dir_all` is a no-op and the real dashboard is embedded.
//! With an empty folder, `DashboardAssets::get` returns `None` and `/dashboard`
//! 404s until the SPA is built — the dashboard-embed conformance test is the
//! gate that the *real* dashboard shipped.
fn main() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set for build scripts");
    let dist = std::path::Path::new(&manifest).join("../../packages/dashboard/dist");
    let _ = std::fs::create_dir_all(&dist);
    // Re-embed when the dashboard build output changes.
    println!("cargo:rerun-if-changed=../../packages/dashboard/dist");
}

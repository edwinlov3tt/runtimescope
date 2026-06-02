//! Vendor the dashboard SPA into the crate so `rust-embed` can bake it into the
//! binary — and so the crate stays self-contained when published to crates.io.
//!
//! `server.rs` embeds `dashboard/` (crate-internal, `#[folder = "dashboard/"]`).
//! That directory is a build artifact (gitignored); we populate it here:
//!
//!   - **Repo build** (the upstream SPA `../../packages/dashboard/dist` exists):
//!     mirror it into `dashboard/` so dev/CI/release builds embed the real UI,
//!     AND `cargo publish` ships it (the crate's `include` lists `dashboard/`).
//!   - **Published-crate build** (no upstream — building from a crates.io tarball):
//!     `dashboard/` was packaged into the crate; use it as-is.
//!   - **Fresh checkout, SPA not built yet**: create an empty `dashboard/` so a
//!     pure-Rust `cargo build` still compiles (`/dashboard` 404s until the SPA is
//!     built; the dashboard-embed conformance test gates that the real UI shipped).

use std::path::Path;

fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let path = entry.path();
        let dest = dst.join(entry.file_name());
        if path.is_dir() {
            copy_dir(&path, &dest)?;
        } else {
            std::fs::copy(&path, &dest)?;
        }
    }
    Ok(())
}

fn main() {
    let manifest = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR is set for build scripts");
    let manifest = Path::new(&manifest);
    let embed = manifest.join("dashboard");
    let upstream = manifest.join("../../packages/dashboard/dist");

    if upstream.exists() {
        // Repo build: refresh the vendored copy from the freshly-built SPA.
        let _ = std::fs::remove_dir_all(&embed);
        if let Err(e) = copy_dir(&upstream, &embed) {
            println!("cargo:warning=could not vendor dashboard into the crate: {e}");
            let _ = std::fs::create_dir_all(&embed);
        }
    } else {
        // Published crate / fresh checkout: keep the packaged copy, or an empty
        // dir so compilation always succeeds.
        let _ = std::fs::create_dir_all(&embed);
    }
    // Re-vendor + re-embed when the upstream SPA changes.
    println!("cargo:rerun-if-changed=../../packages/dashboard/dist");
}

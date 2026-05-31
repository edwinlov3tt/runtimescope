//! pm/ project discovery — path mapping + the "is this a real project?" filter
//! (M5, ADR-0009). Foundation for porting `packages/collector/src/pm/project-discovery.ts`.
//!
//! ## Intentional improvement over Node (the over-discovery fix)
//!
//! Node's `processClaudeProject` registers EVERY `~/.claude/projects/<key>`
//! directory as a project — including keys whose path no longer resolves (it
//! falls back to `slugifyPath(key)` as the id/name) and directories that aren't
//! projects at all (your home dir, `/tmp`, a scratch dir you ran `claude` in
//! once). "Not every directory that ever had a Claude conversation is a project."
//!
//! [`is_real_project`] gates Claude-discovered directories: a dir counts only if
//! it EXISTS and either carries a recognizable project-root marker (VCS / build
//! manifest) or is an explicit RuntimeScope project (`.runtimescope/`), and is
//! not a home/system root. RuntimeScope projects discovered from
//! `~/.runtimescope/projects` are always real (explicit opt-in) and bypass this.
//!
//! This DIVERGES from Node (which would include the noise), so it is gated by the
//! Rust unit tests below, not the Node-vs-Rust conformance suite.

use std::path::{Path, PathBuf};

/// Project-root markers — the presence of any one means "this is a real project
/// directory," not just a folder someone ran Claude in.
pub const PROJECT_MARKERS: &[&str] = &[
    ".git",
    ".runtimescope", // explicit RuntimeScope project (dir holding config.json)
    "package.json",
    "Cargo.toml",
    "pyproject.toml",
    "requirements.txt",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "Gemfile",
    "composer.json",
    "pubspec.yaml",
    "deno.json",
    "deno.jsonc",
    "Makefile",
];

/// Home dir + filesystem/ephemeral/system roots that should never be treated as
/// a project even if a marker happens to live there (e.g. dotfiles git in `~`).
fn is_denied_root(path: &Path) -> bool {
    if let Some(home) = std::env::var_os("HOME") {
        if path == Path::new(&home) {
            return true;
        }
    }
    matches!(
        path.to_str(),
        Some("/") | Some("/tmp") | Some("/private/tmp") | Some("/var") | Some("/usr")
            | Some("/etc") | Some("/opt") | Some("/Users") | Some("/home")
    )
}

/// The over-discovery fix: is `path` a real project directory (vs a folder that
/// merely hosted a Claude conversation)? Requires an existing directory carrying
/// a project marker, excluding home/system roots. (Improvement over Node — see
/// the module docs.)
pub fn is_real_project(path: &Path) -> bool {
    if !path.is_dir() || is_denied_root(path) {
        return false;
    }
    PROJECT_MARKERS.iter().any(|m| path.join(m).exists())
}

/// Stable project id from a filesystem path (ports Node `slugifyPath`): last two
/// path segments joined with `--`, lowercased, non-`[a-z0-9_-]` → `-`, runs of 3+
/// dashes collapsed to `--`, ends trimmed.
pub fn slugify_path(fs_path: &str) -> String {
    let parts: Vec<&str> = fs_path.trim_end_matches('/').split('/').filter(|p| !p.is_empty()).collect();
    let segments: &[&str] = if parts.len() >= 2 { &parts[parts.len() - 2..] } else { &parts };
    let joined = segments.join("--").to_lowercase();
    // non-[a-z0-9_-] → '-'
    let mapped: String = joined
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '-' })
        .collect();
    // collapse runs of 3+ '-' into '--' (runs of 1-2 are preserved)
    let collapsed = collapse_dashes(&mapped);
    collapsed.trim_matches('-').to_string()
}

/// Replace each run of 3+ `-` with exactly `--` (matches JS `/-{3,}/g → '--'`).
fn collapse_dashes(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut run = 0usize;
    for c in s.chars() {
        if c == '-' {
            run += 1;
        } else {
            out.push_str(&dash_run(run));
            run = 0;
            out.push(c);
        }
    }
    out.push_str(&dash_run(run));
    out
}
fn dash_run(run: usize) -> String {
    if run >= 3 { "--".to_string() } else { "-".repeat(run) }
}

/// Decode a Claude project key (`-Users-me-proj`) back to a filesystem path
/// (ports Node `decodeClaudeKey`). Tries the naive `-`→`/` replacement first,
/// then a greedy segment resolver that keeps hyphens inside real directory names.
/// Returns `None` (→ the project is SKIPPED, the improvement) when nothing resolves.
pub fn decode_claude_key(key: &str) -> Option<String> {
    // Node does key.slice(1) unconditionally (the leading '-' is the root '/').
    let body = key.get(1..).unwrap_or("");
    let naive = format!("/{}", body.replace('-', "/"));
    if Path::new(&naive).exists() {
        return Some(naive);
    }
    let parts: Vec<&str> = body.split('-').collect();
    resolve_path_segments(&parts)
}

/// Greedy resolver: reconstruct an existing path from `-`-split segments, joining
/// adjacent segments with `-` (longest-first) to handle directory names that
/// themselves contain hyphens. Ports Node `resolvePathSegments`.
pub fn resolve_path_segments(parts: &[&str]) -> Option<String> {
    fn try_resolve(prefix: &Path, remaining: &[&str]) -> Option<String> {
        if remaining.is_empty() {
            return if prefix.exists() { prefix.to_str().map(String::from) } else { None };
        }
        for count in (1..=remaining.len()).rev() {
            let segment = remaining[..count].join("-");
            let candidate = prefix.join(&segment);
            if count == remaining.len() {
                if candidate.exists() {
                    return candidate.to_str().map(String::from);
                }
            } else if candidate.exists() {
                if let Some(r) = try_resolve(&candidate, &remaining[count..]) {
                    return Some(r);
                }
            }
        }
        None
    }
    if parts.is_empty() {
        return None;
    }
    try_resolve(Path::new("/"), parts)
}

/// `YYYY-MM-DD` period from epoch ms (ports Node `toPeriod`, which uses LOCAL time).
pub fn to_period(timestamp_ms: i64) -> String {
    use chrono::{Local, TimeZone};
    match Local.timestamp_millis_opt(timestamp_ms).single() {
        Some(dt) => dt.format("%Y-%m-%d").to_string(),
        None => "1970-01-01".to_string(),
    }
}

/// Resolve `key` to a path and decide whether it's a real project worth
/// registering (the combined Claude-discovery gate). Returns the resolved path
/// when it should be registered, else `None` (skip).
pub fn resolve_real_project(key: &str) -> Option<PathBuf> {
    let path = decode_claude_key(key)?;
    let p = PathBuf::from(path);
    if is_real_project(&p) {
        Some(p)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "pmdisc-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn slugify_path_cases() {
        assert_eq!(slugify_path("/Users/edwinlovettiii/runtimescope"), "edwinlovettiii--runtimescope");
        assert_eq!(slugify_path("/Users/me/My Project"), "me--my-project");
        assert_eq!(slugify_path("/single"), "single");
        assert_eq!(slugify_path("/a/b/c/"), "b--c"); // trailing slash + last-2
        // non-alnum → '-', then runs of 3+ '-' collapse to '--'
        assert_eq!(slugify_path("/x/a@@@b"), "x--a--b");
        assert_eq!(slugify_path("/x/a   b"), "x--a--b");
    }

    #[test]
    fn collapse_dashes_rule() {
        assert_eq!(collapse_dashes("a-b"), "a-b"); // 1 preserved
        assert_eq!(collapse_dashes("a--b"), "a--b"); // 2 preserved
        assert_eq!(collapse_dashes("a---b"), "a--b"); // 3 → 2
        assert_eq!(collapse_dashes("a-----b"), "a--b"); // 5 → 2
    }

    #[test]
    fn is_real_project_requires_marker() {
        let bare = tmp(); // a dir with no markers — NOT a project (the fix)
        assert!(!is_real_project(&bare));

        let with_pkg = tmp();
        fs::write(with_pkg.join("package.json"), "{}").unwrap();
        assert!(is_real_project(&with_pkg));

        let with_git = tmp();
        fs::create_dir(with_git.join(".git")).unwrap();
        assert!(is_real_project(&with_git));

        let with_cargo = tmp();
        fs::write(with_cargo.join("Cargo.toml"), "").unwrap();
        assert!(is_real_project(&with_cargo));

        let with_rs = tmp();
        fs::create_dir(with_rs.join(".runtimescope")).unwrap();
        assert!(is_real_project(&with_rs));

        // nonexistent path
        assert!(!is_real_project(&tmp().join("nope")));
    }

    #[test]
    fn is_real_project_excludes_home_and_roots() {
        assert!(!is_real_project(Path::new("/")));
        assert!(!is_real_project(Path::new("/tmp")));
        if let Some(home) = std::env::var_os("HOME") {
            // Even if HOME has a marker (dotfiles git), it's denied as a project root.
            let home = PathBuf::from(home);
            if home.is_dir() {
                assert!(!is_real_project(&home));
            }
        }
    }

    #[test]
    fn decode_claude_key_resolves_hyphenated_dirs() {
        // Build a real tree with a hyphen in a segment, then encode it as a Claude
        // key (path '/' → '-') and confirm the greedy resolver reconstructs it.
        let base = tmp(); // e.g. /var/folders/.../pmdisc-123-456
        let proj = base.join("my-cool-proj");
        fs::create_dir_all(&proj).unwrap();
        let full = proj.to_str().unwrap();
        let key = format!("-{}", full.trim_start_matches('/').replace('/', "-"));
        // naive decode (all '-'→'/') would NOT exist (my/cool/proj split); the
        // greedy resolver must rejoin "my-cool-proj".
        let decoded = decode_claude_key(&key);
        assert_eq!(decoded.as_deref(), Some(full));
    }

    #[test]
    fn decode_claude_key_unresolvable_is_none() {
        // A key that maps to no real path → None → the project is skipped.
        assert_eq!(decode_claude_key("-no-such-path-anywhere-xyz-12345"), None);
    }

    #[test]
    fn resolve_real_project_combines_decode_and_filter() {
        // Resolvable + has a marker → Some.
        let base = tmp();
        let proj = base.join("realproj");
        fs::create_dir_all(&proj).unwrap();
        fs::write(proj.join("package.json"), "{}").unwrap();
        let key = format!("-{}", proj.to_str().unwrap().trim_start_matches('/').replace('/', "-"));
        assert_eq!(resolve_real_project(&key).as_deref(), Some(proj.as_path()));

        // Resolvable but NO marker → None (the over-discovery fix).
        let scratch = tmp();
        let skey = format!("-{}", scratch.to_str().unwrap().trim_start_matches('/').replace('/', "-"));
        assert_eq!(resolve_real_project(&skey), None);
    }
}

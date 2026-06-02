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

use crate::pm_session_parser::parse_session_jsonl;
use crate::pm_store::{PmProject, PmSession, PmStore};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

/// Outcome of a discovery pass (ports Node `DiscoveryResult`).
#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryResult {
    pub projects_discovered: i64,
    pub projects_updated: i64,
    pub sessions_discovered: i64,
    pub sessions_updated: i64,
    pub errors: Vec<String>,
}

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

/// basename of a filesystem path.
fn basename(path: &str) -> String {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or(path).to_string()
}

/// Does `path` have the RuntimeScope SDK installed? package.json deps/devDeps,
/// else a `node_modules/@runtimescope` directory. (Ports the common-case of Node
/// `detectSdkInstalled`; the monorepo-workspace scan is a follow-up.)
pub fn detect_sdk_installed(path: &Path) -> bool {
    if let Ok(content) = std::fs::read_to_string(path.join("package.json")) {
        if let Ok(pkg) = serde_json::from_str::<Value>(&content) {
            for field in ["dependencies", "devDependencies"] {
                if let Some(deps) = pkg.get(field).and_then(Value::as_object) {
                    if deps.contains_key("@runtimescope/sdk") || deps.contains_key("@runtimescope/server-sdk") {
                        return true;
                    }
                }
            }
        }
    }
    path.join("node_modules").join("@runtimescope").exists()
}

/// Discover Claude Code projects from `<claude_base>/projects/` and index their
/// sessions into `pm`. Ports `discoverClaudeProjects` + `processClaudeProject` +
/// `indexSessionsForClaudeProject`, WITH the over-discovery fix: only directories
/// that [`is_real_project`] (resolve + carry a marker) are registered. (RuntimeScope
/// project discovery — which needs the ProjectManager port — is a separate pass.)
pub fn discover_claude_projects(claude_base: &Path, pm: &PmStore) -> DiscoveryResult {
    let mut res = DiscoveryResult::default();
    let projects_dir = claude_base.join("projects");
    let Ok(entries) = std::fs::read_dir(&projects_dir) else {
        return res; // ~/.claude/projects doesn't exist — nothing to discover
    };
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let key = entry.file_name().to_string_lossy().to_string();
        process_claude_project(&key, claude_base, pm, &mut res);
    }
    res
}

/// Re-index a single project's sessions on demand — ports Node
/// `ProjectDiscovery.indexProjectSessions(projectId)` (the `sessions/{id}/refresh`
/// backend). A no-op when the project is unknown or has no `claudeProjectKey`
/// (nothing to index), mirroring Node.
pub fn reindex_project_sessions(pm: &PmStore, project_id: &str, claude_base: &Path) {
    let Some(project) = pm.get_project(project_id) else { return };
    let Some(key) = project.claude_project_key else { return };
    let mut res = DiscoveryResult::default();
    index_sessions(project_id, &key, claude_base, pm, &mut res);
}

fn process_claude_project(key: &str, claude_base: &Path, pm: &PmStore, res: &mut DiscoveryResult) {
    // The over-discovery fix: skip anything that isn't a resolvable real project.
    let Some(path) = resolve_real_project(key) else { return };
    let path_str = path.to_string_lossy().to_string();
    if pm.is_deleted_path(&path_str) || pm.is_deleted_path(key) {
        return;
    }
    let id = slugify_path(&path_str);
    let now = now_ms();
    let existing = pm.get_project(&id);
    let sdk = detect_sdk_installed(&path) || existing.as_ref().map(|e| e.sdk_installed).unwrap_or(false);
    let project = PmProject {
        id: id.clone(),
        workspace_id: None, // upsert assigns the default workspace
        name: basename(&path_str),
        path: Some(path_str),
        claude_project_key: Some(key.to_string()),
        runtimescope_project: None,
        phase: "application_development".to_string(),
        project_status: "active".to_string(),
        sdk_installed: sdk,
        runtime_apps: None,
        created_at: existing.as_ref().map(|e| e.created_at).unwrap_or(now),
        updated_at: now,
        // Preserve a user-set category across re-discovery (discovery never sets it).
        category: existing.as_ref().and_then(|e| e.category.clone()),
    };
    pm.upsert_project(&project);
    if existing.is_some() {
        res.projects_updated += 1;
    } else {
        res.projects_discovered += 1;
    }
    index_sessions(&id, key, claude_base, pm, res);
}

fn index_sessions(project_id: &str, key: &str, claude_base: &Path, pm: &PmStore, res: &mut DiscoveryResult) {
    let dir = claude_base.join("projects").join(key);
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    for entry in entries.flatten() {
        let fname = entry.file_name().to_string_lossy().to_string();
        if !fname.ends_with(".jsonl") || !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let session_id = fname.trim_end_matches(".jsonl").to_string();
        let jsonl_path = dir.join(&fname);
        // If the file vanished between read_dir and stat, skip it — do NOT fall
        // back to size 0, which would re-parse an absent file and clobber the
        // stored session's metrics with zeros (audit finding).
        let size = match std::fs::metadata(&jsonl_path) {
            Ok(m) => m.len() as i64,
            Err(_) => continue,
        };
        let prev = pm.session_jsonl_size(&session_id);
        if prev == Some(size) {
            continue; // unchanged — skip (incremental)
        }
        let session = build_session(&session_id, project_id, &jsonl_path, size);
        pm.upsert_session(&session);
        // Node's indexSessions calls upsertCapexStub right after upsertSession.
        pm.upsert_capex_stub(&session);
        if prev.is_some() {
            res.sessions_updated += 1;
        } else {
            res.sessions_discovered += 1;
        }
    }
}

/// Full-parse a session JSONL into a `PmSession`. (We always full-parse — Node's
/// `sessions-index.json` fast-path zeroes token/cost, which is worse data; this
/// is a deliberate accuracy improvement.) `started_at` falls back to file mtime.
fn build_session(session_id: &str, project_id: &str, jsonl_path: &Path, size: i64) -> PmSession {
    let now = now_ms();
    let file_mtime = std::fs::metadata(jsonl_path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(now);
    let p = parse_session_jsonl(jsonl_path);
    PmSession {
        id: session_id.to_string(),
        project_id: project_id.to_string(),
        jsonl_path: jsonl_path.to_string_lossy().to_string(),
        jsonl_size: size,
        first_prompt: p.first_prompt,
        summary: p.summary,
        slug: p.slug,
        model: p.model,
        version: p.version,
        git_branch: p.git_branch,
        permission_mode: p.permission_mode,
        message_count: p.message_count,
        user_message_count: p.user_message_count,
        assistant_message_count: p.assistant_message_count,
        total_input_tokens: p.total_input_tokens,
        total_output_tokens: p.total_output_tokens,
        total_cache_creation_tokens: p.total_cache_creation_tokens,
        total_cache_read_tokens: p.total_cache_read_tokens,
        cost_microdollars: p.cost_microdollars,
        started_at: p.started_at.unwrap_or(file_mtime),
        ended_at: p.ended_at,
        active_minutes: p.active_minutes,
        compaction_count: p.compaction_count,
        pre_compaction_tokens: p.pre_compaction_tokens,
        created_at: now,
        updated_at: now,
    }
}

/// Remove clearly-junk projects left in `pm.db` by pre-filter discovery (the Node
/// collector registered EVERY `~/.claude/projects` key, raw-name + un-decoded).
/// The current filter prevents new ones; this self-heals existing data on each
/// discover. Conservative — only removes the unambiguous junk so real projects
/// (clean basename + a non-root path) are never touched:
///   - a raw-key name (starts with `-` — decode never produced a basename),
///   - a missing/empty path (a real discovery always stores the decoded path),
///   - a home/system root path (`is_denied_root`).
pub fn prune_junk_projects(pm: &PmStore) -> usize {
    let mut removed = 0;
    for p in pm.list_projects() {
        let junk = p.name.starts_with('-')
            || p.path.as_deref().map(str::trim).unwrap_or("").is_empty()
            || p.path.as_deref().is_some_and(|s| is_denied_root(Path::new(s)));
        if junk {
            pm.delete_project(&p.id);
            removed += 1;
        }
    }
    removed
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

    fn claude_key_for(path: &Path) -> String {
        format!("-{}", path.to_str().unwrap().trim_start_matches('/').replace('/', "-"))
    }

    #[test]
    fn discover_claude_projects_filters_and_indexes_sessions() {
        let base = tmp();
        let pm = PmStore::open(&base.join("pm.db")).unwrap();
        let claude = base.join("claude");

        // A REAL project (has package.json marker) with one session transcript.
        let real_src = base.join("my-cool-app"); // hyphen → exercises greedy decode
        fs::create_dir_all(&real_src).unwrap();
        fs::write(real_src.join("package.json"), "{}").unwrap();
        let real_key = claude_key_for(&real_src);
        let real_proj_dir = claude.join("projects").join(&real_key);
        fs::create_dir_all(&real_proj_dir).unwrap();
        fs::write(
            real_proj_dir.join("sess-1.jsonl"),
            concat!(
                "{\"type\":\"user\",\"message\":{\"content\":\"hello\"},\"timestamp\":\"2026-01-01T00:00:00.000Z\"}\n",
                "{\"type\":\"assistant\",\"timestamp\":\"2026-01-01T00:01:00.000Z\",\"message\":{\"model\":\"claude-sonnet-4-5\",\"usage\":{\"input_tokens\":1000,\"output_tokens\":500}}}"
            ),
        ).unwrap();

        // A SCRATCH dir (no marker) — Node would register it; the fix skips it.
        let scratch_src = base.join("scratch");
        fs::create_dir_all(&scratch_src).unwrap();
        let scratch_key = claude_key_for(&scratch_src);
        let scratch_proj_dir = claude.join("projects").join(&scratch_key);
        fs::create_dir_all(&scratch_proj_dir).unwrap();
        fs::write(scratch_proj_dir.join("sess-x.jsonl"), "{\"type\":\"user\",\"message\":{\"content\":\"hi\"},\"timestamp\":\"2026-01-01T00:00:00.000Z\"}").unwrap();

        let res = discover_claude_projects(&claude, &pm);

        // Only the real project (scratch skipped → the over-discovery fix).
        assert_eq!(res.projects_discovered, 1, "scratch dir must NOT be discovered");
        assert_eq!(res.sessions_discovered, 1);
        let projects = pm.list_projects();
        assert_eq!(projects.len(), 1);
        let p = &projects[0];
        assert_eq!(p.name, "my-cool-app");
        assert_eq!(p.path.as_deref(), Some(real_src.to_str().unwrap()));
        assert!(p.workspace_id.is_some(), "assigned to the default workspace");
        // it counts under the Personal workspace
        let personal = &pm.list_workspaces()[0];
        assert_eq!(personal.name, "Personal");

        // The session was parsed + indexed with real metrics.
        let sz = pm.session_jsonl_size("sess-1");
        assert!(sz.is_some());

        // Re-running is idempotent: unchanged session is skipped, project updated.
        let res2 = discover_claude_projects(&claude, &pm);
        assert_eq!(res2.projects_discovered, 0);
        assert_eq!(res2.projects_updated, 1);
        assert_eq!(res2.sessions_discovered, 0);
        assert_eq!(res2.sessions_updated, 0); // size unchanged → skipped
        assert_eq!(pm.list_projects().len(), 1);
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

    // Self-heal: pre-filter junk (raw-key name / null path / home root) is pruned,
    // while a real project (clean basename + a non-root path) is kept.
    #[test]
    fn prune_junk_projects_removes_stale_keeps_real() {
        let base = tmp();
        let pm = PmStore::open(&base.join("pm.db")).unwrap();
        let mk = |id: &str, name: &str, path: Option<&str>| crate::pm_store::PmProject {
            id: id.into(),
            name: name.into(),
            path: path.map(String::from),
            ..Default::default()
        };
        // A real project (clean name + a non-root path) — must survive.
        let real = base.join("real-app");
        std::fs::create_dir_all(&real).unwrap();
        pm.upsert_project(&mk("real", "real-app", real.to_str()));
        // Junk: raw-key name, null path, and the home root.
        pm.upsert_project(&mk("j1", "-Users-edwinlovettiii-Desktop-ad-generator", None));
        pm.upsert_project(&mk("j2", "edwinlovettiii", std::env::var("HOME").ok().as_deref()));
        pm.upsert_project(&mk("j3", "empty-path", Some("")));

        let removed = prune_junk_projects(&pm);
        assert_eq!(removed, 3, "the three junk entries are pruned");
        let names: Vec<String> = pm.list_projects().into_iter().map(|p| p.name).collect();
        assert_eq!(names, vec!["real-app"], "only the real project remains: {names:?}");
    }
}

#[cfg(test)]
mod to_period_tests {
    use super::to_period;

    fn is_ymd(s: &str) -> bool {
        let b = s.as_bytes();
        s.len() == 10
            && b[4] == b'-'
            && b[7] == b'-'
            && s.chars().enumerate().all(|(i, c)| if i == 4 || i == 7 { c == '-' } else { c.is_ascii_digit() })
    }

    // The real contract: an absolute instant always maps to exactly ONE local
    // time, so `.single()` must not return None and we must never fall back to the
    // "1970-01-01" sentinel for a valid recent timestamp. Asserting on a specific
    // calendar date would be timezone-fragile (a UTC-8 machine buckets a 06:30 UTC
    // instant on the prior day), so we assert shape + the no-sentinel invariant.
    #[test]
    fn dst_adjacent_instants_never_hit_the_1970_sentinel() {
        // Two UTC instants straddling the 2026-03-08 US DST gap.
        for ms in [1772951400000i64, 1772955000000i64] {
            let p = to_period(ms);
            assert!(is_ymd(&p), "well-formed YYYY-MM-DD, got {p:?}");
            assert_ne!(p, "1970-01-01", "recent instant {ms} mis-bucketed to the sentinel");
        }
    }

    #[test]
    fn edge_timestamps_stay_well_formed() {
        // Epoch, one day pre-epoch, and year ~2100 must all yield a valid date
        // string (never panic, never an empty/garbage period).
        for ms in [0i64, -86_400_000, 4_102_444_800_000] {
            let p = to_period(ms);
            assert!(is_ymd(&p), "edge ts {ms} -> well-formed date, got {p:?}");
        }
    }
}

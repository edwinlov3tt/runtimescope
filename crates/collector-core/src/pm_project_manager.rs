//! pm/ RuntimeScope-project discovery — the half of `project-discovery.ts`
//! deferred from `pm_discovery.rs` because it needs the `ProjectManager`
//! directory layout. Ports `ProjectDiscovery.discoverRuntimeScopeProjects`
//! (`packages/collector/src/pm/project-discovery.ts` ~lines 290-377) plus the
//! `ProjectManager` helpers it relies on (`listProjects` / `getProjectDir` /
//! `getProjectConfig` / `rootDir`, `packages/collector/src/project-manager.ts`).
//!
//! ## What this does (Node parity)
//!
//! Node scans `~/.runtimescope/projects/<appName>/` — every immediate
//! subdirectory of `<rs_base>/projects` is a RuntimeScope project (explicit
//! opt-in; these always bypass the over-discovery filter in `pm_discovery.rs`).
//! For each `<projectName>` it:
//!   1. Derives a stable id: `projectName.toLowerCase().replace(/[^a-z0-9_-]/g, '-')`.
//!   2. Looks for an EXISTING `PmProject` (possibly created by Claude discovery)
//!      matching by `id` OR `runtimescopeProject == projectName` OR
//!      `name.toLowerCase() == projectName.toLowerCase()`.
//!   3. If found → MERGE: set `runtimescopeProject = projectName`, push
//!      `projectName` into `runtimeApps` (case-insensitive de-dup), keep
//!      `sdkInstalled` sticky-true, bump `updatedAt`. Counts as `projectsUpdated`.
//!   4. If not found → if the source path is on the deletion blocklist, SKIP;
//!      else create a fresh `PmProject` with `phase = application_development`,
//!      `projectStatus = active`, `runtimeApps = [projectName]`,
//!      `runtimescopeProject = projectName`, `path = <projectDir>`. Counts as
//!      `projectsDiscovered`.
//!
//! Node uses the project DATA dir (`getProjectDir`) as the path and runs
//! `detectSdkInstalled` against the existing source path if one is already known
//! (`existing.path`), else the data dir. We mirror that. ADDITIVELY (per this
//! item's spec), when the project dir carries a `.runtimescope/config.json` with
//! a `projectId`, we surface it — but Node's `discoverRuntimeScopeProjects` does
//! not write a runtime projectId onto the `PmProject` row (there's no column for
//! it in the ported `pm_store.rs`), so this is read for parity-of-intent only and
//! does not change the upserted shape.
//!
//! Not easily Node-conformance-gateable (needs a populated
//! `~/.runtimescope/projects`), so it's covered by the Rust unit tests below.

use crate::pm_discovery::{detect_sdk_installed, DiscoveryResult};
use crate::pm_store::{PmProject, PmStore};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

/// Minimal `ProjectManager`-equivalent over the `~/.runtimescope` directory
/// layout. Ports the handful of helpers `discoverRuntimeScopeProjects` needs:
/// `rootDir`, `listProjects`, `getProjectDir`, `getProjectConfig`.
pub struct ProjectManager {
    base_dir: PathBuf,
}

impl ProjectManager {
    /// `base_dir` is the RuntimeScope root (Node: `~/.runtimescope`).
    pub fn new(base_dir: &Path) -> Self {
        ProjectManager { base_dir: base_dir.to_path_buf() }
    }

    /// The RuntimeScope root dir (ports Node `get rootDir`).
    pub fn root_dir(&self) -> &Path {
        &self.base_dir
    }

    /// Data dir for a project (ports Node `getProjectDir`): `<base>/projects/<safe>`
    /// where `<safe>` sanitizes anything outside `[A-Za-z0-9_.-]` to `_` to block
    /// path traversal; empty / `.` / `..` collapse to `_invalid`.
    pub fn get_project_dir(&self, project_name: &str) -> PathBuf {
        let safe: String = project_name
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '.' || c == '-' { c } else { '_' })
            .collect();
        let projects = self.base_dir.join("projects");
        if safe.is_empty() || safe == "." || safe == ".." {
            return projects.join("_invalid");
        }
        projects.join(safe)
    }

    /// Immediate subdirectory names of `<base>/projects` (ports Node
    /// `listProjects`). Empty when the dir is missing.
    pub fn list_projects(&self) -> Vec<String> {
        let dir = self.base_dir.join("projects");
        let Ok(entries) = std::fs::read_dir(&dir) else { return Vec::new() };
        let mut names: Vec<String> = entries
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        names.sort();
        names
    }

    /// Parsed `<projectDir>/config.json` (ports Node `getProjectConfig`), or
    /// `None` when absent / unparsable.
    pub fn get_project_config(&self, project_name: &str) -> Option<Value> {
        let path = self.get_project_dir(project_name).join("config.json");
        let content = std::fs::read_to_string(path).ok()?;
        serde_json::from_str(&content).ok()
    }

    /// The `projectId` recorded in this project's `config.json`, if any
    /// (Node `ProjectConfig.projectId`).
    pub fn get_project_id_for_app(&self, project_name: &str) -> Option<String> {
        self.get_project_config(project_name)?
            .get("projectId")
            .and_then(Value::as_str)
            .map(String::from)
    }
}

/// RuntimeScope-project id from a project (app) name — ports Node
/// `projectName.toLowerCase().replace(/[^a-z0-9_-]/g, '-')`. Note this differs
/// from `pm_discovery::slugify_path` (no last-2-segment / dash-collapse rules).
fn runtimescope_project_id(project_name: &str) -> String {
    project_name
        .to_lowercase()
        .chars()
        // input is already lowercased; keep [a-z0-9_-], everything else → '-'
        .map(|c| if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-' { c } else { '-' })
        .collect()
}

/// Parse the JSON `runtimeApps` column into a `Vec<String>` (the column stores a
/// JSON array, mirroring Node's `runtime_apps` TEXT).
fn parse_runtime_apps(json: &Option<String>) -> Vec<String> {
    json.as_deref()
        .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
        .unwrap_or_default()
}

/// Discover RuntimeScope projects from `<rs_base>/projects/` and upsert them into
/// `pm`. Ports `ProjectDiscovery.discoverRuntimeScopeProjects`.
///
/// `rs_base` is the RuntimeScope root (Node: `~/.runtimescope`). Returns a
/// `DiscoveryResult` (only the project counters + errors are populated — this
/// pass does not index sessions, matching Node).
pub fn discover_runtimescope_projects(rs_base: &Path, pm: &PmStore) -> DiscoveryResult {
    let mut res = DiscoveryResult::default();
    let pman = ProjectManager::new(rs_base);

    for project_name in pman.list_projects() {
        let project_dir = pman.get_project_dir(&project_name);
        let project_dir_str = project_dir.to_string_lossy().to_string();
        let id = runtimescope_project_id(&project_name);
        let name_lower = project_name.to_lowercase();

        // Match an existing row by id OR runtimescopeProject OR case-insensitive name.
        let existing = pm.list_projects().into_iter().find(|p| {
            p.id == id
                || p.runtimescope_project.as_deref() == Some(project_name.as_str())
                || p.name.to_lowercase() == name_lower
        });

        let now = now_ms();
        // Node: SDK detection runs against the existing SOURCE path if known
        // (the project data dir is not source), else the data dir.
        let source_path = existing.as_ref().and_then(|e| e.path.clone()).unwrap_or_else(|| project_dir_str.clone());
        let sdk_installed = detect_sdk_installed(Path::new(&source_path));

        if let Some(existing) = existing {
            let mut apps = parse_runtime_apps(&existing.runtime_apps);
            if !apps.iter().any(|a| a.to_lowercase() == name_lower) {
                apps.push(project_name.clone());
            }
            let updated = PmProject {
                runtimescope_project: Some(project_name.clone()),
                runtime_apps: serde_json::to_string(&apps).ok(),
                sdk_installed: sdk_installed || existing.sdk_installed,
                updated_at: now,
                ..existing
            };
            pm.upsert_project(&updated);
            res.projects_updated += 1;
        } else {
            // Skip if this source path was previously deleted (blocklist).
            if pm.is_deleted_path(&source_path) {
                continue;
            }
            let project = PmProject {
                id,
                workspace_id: None, // upsert assigns the default workspace
                name: project_name.clone(),
                path: Some(project_dir_str),
                claude_project_key: None,
                runtimescope_project: Some(project_name.clone()),
                phase: "application_development".to_string(),
                project_status: "active".to_string(),
                sdk_installed,
                runtime_apps: serde_json::to_string(&vec![project_name.clone()]).ok(),
                created_at: now,
                updated_at: now,
            };
            pm.upsert_project(&project);
            res.projects_discovered += 1;
        }
    }

    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "pmpm-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn make_project(rs_base: &Path, name: &str, config: Option<&str>) -> PathBuf {
        let dir = rs_base.join("projects").join(name);
        fs::create_dir_all(&dir).unwrap();
        if let Some(cfg) = config {
            // ProjectManager.getProjectConfig reads <projectDir>/config.json
            // (Node project-manager.ts getProjectConfig).
            fs::write(dir.join("config.json"), cfg).unwrap();
        }
        dir
    }

    #[test]
    fn id_derivation_matches_node() {
        // toLowerCase + [^a-z0-9_-] → '-' (NO segment/dash-collapse rules).
        assert_eq!(runtimescope_project_id("My App"), "my-app");
        assert_eq!(runtimescope_project_id("Acme/Web"), "acme-web");
        assert_eq!(runtimescope_project_id("keep_under-score"), "keep_under-score");
        assert_eq!(runtimescope_project_id("a@@b"), "a--b"); // no collapse, unlike slugify_path
        assert_eq!(runtimescope_project_id("CAPS123"), "caps123");
    }

    #[test]
    fn discovers_runtimescope_project_with_config() {
        let base = tmp();
        let rs_base = base.join("rs"); // stand-in for ~/.runtimescope
        let pm = PmStore::open(&base.join("pm.db")).unwrap();

        let dir = make_project(
            &rs_base,
            "my-web",
            Some(r#"{"projectId":"proj_abc123","appName":"my-web"}"#),
        );

        let res = discover_runtimescope_projects(&rs_base, &pm);
        assert_eq!(res.projects_discovered, 1);
        assert_eq!(res.projects_updated, 0);
        assert!(res.errors.is_empty());

        let projects = pm.list_projects();
        assert_eq!(projects.len(), 1);
        let p = &projects[0];
        assert_eq!(p.id, "my-web");
        assert_eq!(p.name, "my-web");
        assert_eq!(p.path.as_deref(), Some(dir.to_str().unwrap()));
        assert_eq!(p.runtimescope_project.as_deref(), Some("my-web"));
        assert_eq!(p.phase, "application_development");
        assert_eq!(p.project_status, "active");
        assert!(p.workspace_id.is_some(), "assigned to the default workspace");
        assert_eq!(parse_runtime_apps(&p.runtime_apps), vec!["my-web".to_string()]);

        // The config's projectId is readable via the ProjectManager helper.
        let pman = ProjectManager::new(&rs_base);
        assert_eq!(pman.get_project_id_for_app("my-web").as_deref(), Some("proj_abc123"));
    }

    #[test]
    fn discovers_project_without_config() {
        let base = tmp();
        let rs_base = base.join("rs");
        let pm = PmStore::open(&base.join("pm.db")).unwrap();
        make_project(&rs_base, "bare-app", None);

        let res = discover_runtimescope_projects(&rs_base, &pm);
        assert_eq!(res.projects_discovered, 1);
        let p = &pm.list_projects()[0];
        assert_eq!(p.id, "bare-app");
        assert_eq!(p.runtimescope_project.as_deref(), Some("bare-app"));
    }

    #[test]
    fn rerun_is_idempotent_and_merges() {
        let base = tmp();
        let rs_base = base.join("rs");
        let pm = PmStore::open(&base.join("pm.db")).unwrap();
        make_project(&rs_base, "web", None);

        let r1 = discover_runtimescope_projects(&rs_base, &pm);
        assert_eq!(r1.projects_discovered, 1);

        // Second pass: the project now EXISTS → merge path, projects_updated.
        let r2 = discover_runtimescope_projects(&rs_base, &pm);
        assert_eq!(r2.projects_discovered, 0);
        assert_eq!(r2.projects_updated, 1);
        assert_eq!(pm.list_projects().len(), 1);
        // runtimeApps still a single entry (case-insensitive de-dup held).
        assert_eq!(parse_runtime_apps(&pm.list_projects()[0].runtime_apps), vec!["web".to_string()]);
    }

    #[test]
    fn merges_into_claude_discovered_project_by_name() {
        // Simulate a project already discovered via Claude (id = slugify_path,
        // name matches the RuntimeScope app name) → discovery must MERGE, not
        // create a duplicate, and stamp runtimescopeProject + runtimeApps.
        let base = tmp();
        let rs_base = base.join("rs");
        let pm = PmStore::open(&base.join("pm.db")).unwrap();
        make_project(&rs_base, "my-web", None);

        let now = now_ms();
        let claude = PmProject {
            id: "users--my-web".to_string(), // different id (slugify_path style)
            workspace_id: None,
            name: "my-web".to_string(), // same name → matches case-insensitively
            path: Some("/Users/me/my-web".to_string()),
            claude_project_key: Some("-Users-me-my-web".to_string()),
            runtimescope_project: None,
            phase: "application_development".to_string(),
            project_status: "active".to_string(),
            sdk_installed: true,
            runtime_apps: None,
            created_at: now,
            updated_at: now,
        };
        pm.upsert_project(&claude);

        let res = discover_runtimescope_projects(&rs_base, &pm);
        assert_eq!(res.projects_discovered, 0, "must MERGE, not create a duplicate");
        assert_eq!(res.projects_updated, 1);

        let projects = pm.list_projects();
        assert_eq!(projects.len(), 1, "no duplicate row");
        let p = &projects[0];
        assert_eq!(p.id, "users--my-web", "kept the existing id");
        assert_eq!(p.runtimescope_project.as_deref(), Some("my-web"));
        assert_eq!(parse_runtime_apps(&p.runtime_apps), vec!["my-web".to_string()]);
        assert!(p.sdk_installed, "sticky-true preserved");
        // SDK detection ran against the EXISTING source path, not the data dir.
        assert_eq!(p.path.as_deref(), Some("/Users/me/my-web"));
    }

    #[test]
    fn list_projects_empty_when_no_projects_dir() {
        let base = tmp();
        let pman = ProjectManager::new(&base.join("nonexistent"));
        assert!(pman.list_projects().is_empty());
    }

    #[test]
    fn get_project_dir_sanitizes_traversal() {
        let base = tmp();
        let pman = ProjectManager::new(&base);
        // Node regex [^a-zA-Z0-9_.-] preserves '.' and '-': '/' → '_'.
        assert_eq!(pman.get_project_dir("../etc"), base.join("projects").join(".._etc"));
        assert_eq!(pman.get_project_dir(".."), base.join("projects").join("_invalid"));
        assert_eq!(pman.get_project_dir("a/b"), base.join("projects").join("a_b"));
        assert_eq!(pman.get_project_dir("ok-name_1.2"), base.join("projects").join("ok-name_1.2"));
    }
}

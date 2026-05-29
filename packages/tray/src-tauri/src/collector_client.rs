//! HTTP client for the local RuntimeScope collector.
//!
//! Two contracts:
//! 1. The tray reads ONLY through HTTP. No filesystem, no SQLite, no
//!    `@runtimescope/collector` imports — see hard rule 1 in the Phase
//!    Tauri-Tray brief and `docs/specs/tray-api-surface.md` for the locked
//!    surface.
//! 2. The same tray binary must keep working when the Rust collector ships
//!    in Phase Rust-Collector (v0.12.0). So this module mirrors the
//!    documented JSON shapes, not the Node implementation's internal types.

use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Default HTTP port for the RuntimeScope collector. Matches the
/// `RUNTIMESCOPE_HTTP_PORT` env var default and the dashboard Vite proxy.
pub const DEFAULT_PORT: u16 = 6768;

#[derive(Debug, thiserror::Error)]
pub enum CollectorError {
    #[error("collector unreachable: {0}")]
    Unreachable(String),
    #[error("collector returned {status}: {body}")]
    Http { status: u16, body: String },
    #[error("auth required (set RUNTIMESCOPE_API_KEY)")]
    AuthRequired,
}

/// Response shape of `GET /api/health`. Subset — we only deserialize what the
/// tray needs. The collector may add fields; serde silently ignores extras.
#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
    pub uptime: u64,
    pub sessions: u64,
    #[serde(default, rename = "authEnabled")]
    pub auth_enabled: bool,
}

/// One entry from `GET /api/sessions`'s `data` array. Note: the canonical
/// field name in the Node collector's `SessionInfo` is `appName`, NOT
/// `projectName` (the §B inventory in the Phase brief used a draft name —
/// `packages/collector/src/http-server.ts` and `types.ts` are the source of
/// truth).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CollectorSession {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "appName")]
    pub app_name: String,
    #[serde(rename = "isConnected")]
    pub is_connected: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SessionsResponse {
    pub data: Vec<CollectorSession>,
}

#[derive(Debug, Clone, Deserialize)]
struct NpmLatestResponse {
    version: String,
}

pub struct CollectorClient {
    http: reqwest::Client,
    base: String,
}

impl CollectorClient {
    pub fn new(port: u16) -> Self {
        let http = reqwest::Client::builder()
            // 1.5s caps any individual blocking call. The tray polls every 5s,
            // so a slow request can't ever pile up into the next interval.
            .timeout(Duration::from_millis(1500))
            // Local HTTP — never use a configured proxy. macOS Network
            // settings sometimes route 127.0.0.1 through a corporate proxy
            // that mangles or blocks the local request.
            .no_proxy()
            .build()
            .expect("reqwest client construction is infallible with these options");
        Self {
            http,
            base: format!("http://127.0.0.1:{port}"),
        }
    }

    pub async fn health(&self) -> Result<HealthResponse, CollectorError> {
        let url = format!("{}/api/health", self.base);
        let res = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| CollectorError::Unreachable(e.to_string()))?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            return Err(CollectorError::Http {
                status: status.as_u16(),
                body,
            });
        }
        res.json::<HealthResponse>()
            .await
            .map_err(|e| CollectorError::Unreachable(e.to_string()))
    }

    pub async fn sessions(&self) -> Result<Vec<CollectorSession>, CollectorError> {
        let url = format!("{}/api/sessions", self.base);
        let res = self
            .http
            .get(&url)
            .send()
            .await
            .map_err(|e| CollectorError::Unreachable(e.to_string()))?;
        if res.status().as_u16() == 401 {
            return Err(CollectorError::AuthRequired);
        }
        if !res.status().is_success() {
            let status = res.status().as_u16();
            let body = res.text().await.unwrap_or_default();
            return Err(CollectorError::Http { status, body });
        }
        let parsed: SessionsResponse = res
            .json()
            .await
            .map_err(|e| CollectorError::Unreachable(e.to_string()))?;
        Ok(parsed.data)
    }
}

/// Look up the latest published version of `runtimescope` on npm. Used by the
/// "Update Available" banner.
///
/// TODO(v0.12.0): when Phase Rust-Collector ships, swap this call site for a
/// GitHub Releases manifest lookup (per ADR-0002). The function signature
/// stays the same — the only thing that changes is the endpoint.
pub async fn latest_published_version() -> Result<String, CollectorError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .expect("reqwest client construction is infallible");
    let res = client
        .get("https://registry.npmjs.org/runtimescope/latest")
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| CollectorError::Unreachable(e.to_string()))?;
    if !res.status().is_success() {
        return Err(CollectorError::Http {
            status: res.status().as_u16(),
            body: String::new(),
        });
    }
    let parsed: NpmLatestResponse = res
        .json()
        .await
        .map_err(|e| CollectorError::Unreachable(e.to_string()))?;
    Ok(parsed.version)
}

/// Compare semver-ish "a.b.c" strings. Returns std::cmp::Ordering — Less means
/// `a < b`. Anything non-numeric in a component becomes 0 (so pre-release
/// suffixes like "0.10.12-beta.1" sort against "0.10.12" as equal-ish, which
/// is fine for the tray's "is there a newer release on npm?" check).
pub fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let pa = parse_version(a);
    let pb = parse_version(b);
    pa.cmp(&pb)
}

fn parse_version(v: &str) -> Vec<u32> {
    // Strip pre-release suffix (everything after `-`) so "0.10.12-beta.1"
    // compares equal to "0.10.12" — the tray cares about "is there a newer
    // released version?", not strict semver pre-release ordering.
    let core = v.split('-').next().unwrap_or(v);
    core.split('.')
        .map(|seg| {
            seg.chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse::<u32>()
                .unwrap_or(0)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering;

    #[test]
    fn version_comparison_simple() {
        assert_eq!(compare_versions("0.10.12", "0.10.12"), Ordering::Equal);
        assert_eq!(compare_versions("0.10.11", "0.10.12"), Ordering::Less);
        assert_eq!(compare_versions("0.11.0", "0.10.99"), Ordering::Greater);
    }

    #[test]
    fn version_comparison_handles_prerelease_suffix() {
        // Pre-release suffix is ignored; this is fine for "newer on npm?" checks.
        assert_eq!(
            compare_versions("0.10.12-beta.1", "0.10.12"),
            Ordering::Equal
        );
    }
}

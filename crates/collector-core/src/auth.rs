//! Auth model — `docs/specs/wire-protocol.md` §3 (WS) + §7 (HTTP).
//!
//! Off by default; enabled when EITHER `RUNTIMESCOPE_AUTH_TOKEN` is set OR the
//! global config file (`$HOME/.runtimescope/config.json`) carries an enabled
//! `auth` section — this mirrors Node, whose MCP server constructs the
//! `AuthManager` from `projectManager.getGlobalConfig().auth`
//! (`packages/mcp-server/src/index.ts`), NOT from an env var. HTTP uses
//! `Authorization: Bearer <token>`; the WS handshake carries `authToken`. The
//! public-route set (health/readyz/metrics/snippet/dashboard) is reachable
//! without auth even when enabled; everything else is gated (401).
//!
//! Node parity (`packages/collector/src/auth.ts`): `isEnabled` reflects the
//! configured `enabled` flag; `validate`/`isAuthorized` constant-time-compare
//! the presented key against each configured `apiKeys[].key`. We preserve the
//! existing env-token path (also constant-time) and layer the config keys on
//! top, so a token is accepted if it matches the env token OR any config key.

use std::path::Path;

use serde::Deserialize;

/// A single configured API key. Mirrors Node's `ApiKeyEntry`
/// (`packages/collector/src/auth.ts`); only `key` participates in auth, the
/// other fields (label/project/createdAt) are metadata we don't need here, so
/// we deliberately ignore unknown fields rather than require them.
#[derive(Debug, Clone, Deserialize)]
struct ApiKeyEntry {
    key: String,
}

/// The optional `auth` section of `~/.runtimescope/config.json`. Mirrors Node's
/// `GlobalConfig.auth` (`packages/collector/src/project-manager.ts`).
#[derive(Debug, Clone, Default, Deserialize)]
struct AuthConfig {
    #[serde(default)]
    enabled: bool,
    #[serde(default, rename = "apiKeys")]
    api_keys: Vec<ApiKeyEntry>,
}

/// The slice of the global config we care about. Unknown fields (port, tls,
/// redaction, …) are ignored — serde drops them by default.
#[derive(Debug, Clone, Default, Deserialize)]
struct GlobalConfig {
    #[serde(default)]
    auth: Option<AuthConfig>,
}

#[derive(Clone)]
pub struct AuthManager {
    /// `RUNTIMESCOPE_AUTH_TOKEN`, if set and non-empty.
    env_token: Option<String>,
    /// Keys from `config.json`'s `auth.apiKeys` — only populated when the
    /// config's `auth.enabled` is true (matching Node, which loads keys into
    /// the manager but gates everything on `enabled`).
    config_keys: Vec<String>,
    /// True iff the config's `auth.enabled` flag is set.
    config_enabled: bool,
}

impl AuthManager {
    /// Construct from the environment AND the global config file
    /// (`$HOME/.runtimescope/config.json`). This is the production entrypoint —
    /// `server.rs` calls it — and it now honors the config-file `auth` section
    /// so Rust matches Node's enablement behavior.
    pub fn from_env() -> Self {
        Self::from_env_and_dir(crate::data_dir())
    }

    /// Same as [`from_env`], but reads the config from an explicit data dir.
    /// Used by tests (and any caller that wants to point at an isolated dir).
    pub fn from_env_and_dir(data_dir: impl AsRef<Path>) -> Self {
        let env_token = std::env::var("RUNTIMESCOPE_AUTH_TOKEN").ok().filter(|s| !s.is_empty());
        let config = read_global_config(data_dir.as_ref());
        Self::new(env_token, config)
    }

    fn new(env_token: Option<String>, config: Option<GlobalConfig>) -> Self {
        let auth = config.and_then(|c| c.auth);
        let config_enabled = auth.as_ref().map(|a| a.enabled).unwrap_or(false);
        // Only load keys when config auth is enabled — disabled config keys must
        // never authorize (Node's `validate` short-circuits on `!enabled`).
        let config_keys = if config_enabled {
            auth.map(|a| a.api_keys.into_iter().map(|e| e.key).filter(|k| !k.is_empty()).collect())
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        AuthManager { env_token, config_keys, config_enabled }
    }

    /// Enabled if the config's `auth.enabled` is true OR an env token is set.
    pub fn enabled(&self) -> bool {
        self.config_enabled || self.env_token.is_some()
    }

    /// True if the presented token is acceptable. When auth is off, everything
    /// is authorized; when on, the token must match the env token OR one of the
    /// configured API keys — **in constant time**, so a timing side-channel
    /// can't recover a secret byte-by-byte (audit #6). We compare against every
    /// candidate without early-out on a match, so the work is independent of
    /// which (if any) key matched.
    pub fn authorized(&self, presented: Option<&str>) -> bool {
        use subtle::ConstantTimeEq;

        if !self.enabled() {
            return true;
        }

        let Some(p) = presented else {
            return false;
        };
        let p = p.as_bytes();

        let mut ok = false;
        // ct_eq is constant-time over the byte content for equal-length slices;
        // an unequal length short-circuits (length isn't secret). We OR across
        // all candidates (env token + every config key) without short-circuit.
        if let Some(expected) = &self.env_token {
            ok |= bool::from(p.ct_eq(expected.as_bytes()));
        }
        for expected in &self.config_keys {
            ok |= bool::from(p.ct_eq(expected.as_bytes()));
        }
        ok
    }

    /// Pull the bearer token out of an `Authorization` header value.
    pub fn extract_bearer(header: Option<&str>) -> Option<&str> {
        header
            .and_then(|h| h.strip_prefix("Bearer ").or_else(|| h.strip_prefix("bearer ")))
            .map(str::trim)
    }
}

/// Read + parse `<data_dir>/config.json`. Missing file or parse error yields
/// `None` (auth simply falls back to the env token) — Node's `getGlobalConfig`
/// likewise returns defaults when the file is absent.
fn read_global_config(data_dir: &Path) -> Option<GlobalConfig> {
    let path = data_dir.join("config.json");
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<GlobalConfig>(&raw).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard};

    // Serialize tests that mutate the RUNTIMESCOPE_AUTH_TOKEN env var (process
    // global) so they don't race each other.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvGuard {
        _lock: MutexGuard<'static, ()>,
    }
    impl EnvGuard {
        fn unset() -> Self {
            let lock = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            std::env::remove_var("RUNTIMESCOPE_AUTH_TOKEN");
            EnvGuard { _lock: lock }
        }
        fn set(token: &str) -> Self {
            let lock = ENV_LOCK.lock().unwrap_or_else(|p| p.into_inner());
            std::env::set_var("RUNTIMESCOPE_AUTH_TOKEN", token);
            EnvGuard { _lock: lock }
        }
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            std::env::remove_var("RUNTIMESCOPE_AUTH_TOKEN");
        }
    }

    fn write_config(dir: &Path, json: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("config.json"), json).unwrap();
    }

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("rs-auth-test-{}-{}-{:?}", tag, std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn config_enabled_and_config_key_authorizes() {
        let _env = EnvGuard::unset();
        let dir = tmp_dir("cfg-enabled");
        write_config(
            &dir,
            r#"{
                "defaultPort": 6767,
                "auth": {
                    "enabled": true,
                    "apiKeys": [
                        { "key": "secret-key-aaa", "label": "ci", "createdAt": 1 },
                        { "key": "secret-key-bbb", "label": "dev", "createdAt": 2 }
                    ]
                }
            }"#,
        );

        let mgr = AuthManager::from_env_and_dir(&dir);
        assert!(mgr.enabled(), "config auth.enabled=true must enable auth");
        assert!(mgr.authorized(Some("secret-key-aaa")), "first config key must authorize");
        assert!(mgr.authorized(Some("secret-key-bbb")), "second config key must authorize");
        assert!(!mgr.authorized(Some("wrong-key")), "unknown key must be rejected");
        assert!(!mgr.authorized(None), "missing token must be rejected when enabled");
    }

    #[test]
    fn env_token_still_authorizes() {
        let _env = EnvGuard::set("env-token-xyz");
        // No config file at all.
        let dir = tmp_dir("env-only");

        let mgr = AuthManager::from_env_and_dir(&dir);
        assert!(mgr.enabled(), "env token must enable auth");
        assert!(mgr.authorized(Some("env-token-xyz")), "env token must authorize");
        assert!(!mgr.authorized(Some("env-token-XYZ")), "wrong-case token must be rejected");
        assert!(!mgr.authorized(None), "missing token must be rejected when enabled");
    }

    #[test]
    fn env_token_and_config_key_both_authorize() {
        let _env = EnvGuard::set("env-token-xyz");
        let dir = tmp_dir("env-and-cfg");
        write_config(
            &dir,
            r#"{ "auth": { "enabled": true, "apiKeys": [ { "key": "cfg-key-123", "label": "x", "createdAt": 0 } ] } }"#,
        );

        let mgr = AuthManager::from_env_and_dir(&dir);
        assert!(mgr.enabled());
        assert!(mgr.authorized(Some("env-token-xyz")), "env token authorizes");
        assert!(mgr.authorized(Some("cfg-key-123")), "config key authorizes");
        assert!(!mgr.authorized(Some("nope")));
    }

    #[test]
    fn disabled_config_and_no_env_means_auth_off() {
        let _env = EnvGuard::unset();
        let dir = tmp_dir("cfg-disabled");
        // enabled:false plus keys present — keys must NOT authorize, and auth is
        // off so everything passes (Node: !enabled => isAuthorized returns true).
        write_config(
            &dir,
            r#"{ "auth": { "enabled": false, "apiKeys": [ { "key": "ghost-key", "label": "x", "createdAt": 0 } ] } }"#,
        );

        let mgr = AuthManager::from_env_and_dir(&dir);
        assert!(!mgr.enabled(), "disabled config + no env => auth off");
        // Auth off: every request (even with no/garbage token) is authorized.
        assert!(mgr.authorized(None));
        assert!(mgr.authorized(Some("anything")));
        assert!(mgr.authorized(Some("ghost-key")));
    }

    #[test]
    fn missing_config_file_and_no_env_means_auth_off() {
        let _env = EnvGuard::unset();
        let dir = tmp_dir("no-config");
        // Dir exists but has no config.json.
        let mgr = AuthManager::from_env_and_dir(&dir);
        assert!(!mgr.enabled());
        assert!(mgr.authorized(None));
        assert!(mgr.authorized(Some("whatever")));
    }

    #[test]
    fn extract_bearer_handles_case_and_trim() {
        assert_eq!(AuthManager::extract_bearer(Some("Bearer abc")), Some("abc"));
        assert_eq!(AuthManager::extract_bearer(Some("bearer abc ")), Some("abc"));
        assert_eq!(AuthManager::extract_bearer(Some("Basic abc")), None);
        assert_eq!(AuthManager::extract_bearer(None), None);
    }
}

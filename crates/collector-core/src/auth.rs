//! Auth model — `docs/specs/wire-protocol.md` §3 (WS) + §7 (HTTP).
//!
//! Off by default. Enablement is **per-binary**, matching Node's two distinct
//! wirings (see [`AuthMode`]): the standalone `collector-server` honors
//! `RUNTIMESCOPE_AUTH_TOKEN` (comma-separated, precedence over the config file —
//! `standalone.ts`), while `mcp-server` is config-file-only and ignores the env
//! var (`mcp-server/src/index.ts`). HTTP uses `Authorization: Bearer <token>`;
//! the WS handshake carries `authToken`. The public-route set
//! (health/readyz/metrics/snippet/dashboard) is reachable without auth even when
//! enabled; everything else is gated (401).
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
    /// The acceptable token set: the comma-split env tokens (standalone with an
    /// env token), otherwise the enabled config keys. Empty when auth is off.
    tokens: Vec<String>,
    /// True when auth is on (env token present for standalone, or config
    /// `auth.enabled`).
    enabled: bool,
}

/// Which Node entrypoint's auth-wiring to mirror. Node constructs its
/// `AuthManager` differently per binary, and we reproduce each exactly:
/// - **Standalone** (`packages/collector/src/standalone.ts`): `RUNTIMESCOPE_AUTH_TOKEN`
///   (comma-separated) takes precedence over the config file — if set, it supplies
///   the keys and enables auth, and `config.auth` is ignored.
/// - **Mcp** (`packages/mcp-server/src/index.ts`): config file only; the env var
///   is **not** read.
///
/// `serve()` threads the mode in so `collector-server` and `mcp-server` each match
/// their reference instead of sharing one flattened policy.
#[derive(Clone, Copy, Debug)]
pub enum AuthMode {
    /// `collector-server` ↔ Node standalone (env token wins, else config).
    Standalone,
    /// `mcp-server` ↔ Node MCP (config file only; env var ignored).
    Mcp,
}

impl AuthManager {
    /// Construct for an [`AuthMode`] against the real data dir.
    pub fn for_mode(mode: AuthMode) -> Self {
        match mode {
            AuthMode::Standalone => Self::from_env_and_dir(crate::data_dir()),
            AuthMode::Mcp => Self::from_config_and_dir(crate::data_dir()),
        }
    }

    /// Standalone construction from the real data dir.
    pub fn from_env() -> Self {
        Self::from_env_and_dir(crate::data_dir())
    }

    /// Standalone (collector-server) construction from an explicit data dir.
    /// **Env precedence**: a non-empty `RUNTIMESCOPE_AUTH_TOKEN` (comma-separated)
    /// supplies the acceptable keys and enables auth, and the config-file `auth`
    /// section is then ignored — mirroring Node `standalone.ts`
    /// (`authFromEnv?.apiKeys ?? globalConfig.auth?.apiKeys ?? []`).
    pub fn from_env_and_dir(data_dir: impl AsRef<Path>) -> Self {
        let env_tokens = env_tokens();
        if !env_tokens.is_empty() {
            return AuthManager { tokens: env_tokens, enabled: true };
        }
        Self::from_config(read_global_config(data_dir.as_ref()))
    }

    /// MCP-server construction from an explicit data dir: config file only — the
    /// env var is deliberately ignored (Node `mcp-server/src/index.ts` builds the
    /// `AuthManager` solely from `globalConfig.auth`).
    pub fn from_config_and_dir(data_dir: impl AsRef<Path>) -> Self {
        Self::from_config(read_global_config(data_dir.as_ref()))
    }

    fn from_config(config: Option<GlobalConfig>) -> Self {
        let auth = config.and_then(|c| c.auth);
        let enabled = auth.as_ref().map(|a| a.enabled).unwrap_or(false);
        // Only load keys when config auth is enabled — disabled config keys must
        // never authorize (Node's `validate` short-circuits on `!enabled`).
        let tokens = if enabled {
            auth.map(|a| a.api_keys.into_iter().map(|e| e.key).filter(|k| !k.is_empty()).collect())
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        AuthManager { tokens, enabled }
    }

    /// Enabled when an env token is set (standalone) or the config's `auth.enabled`
    /// is true — per the [`AuthMode`] this manager was built with.
    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// True if the presented token is acceptable. When auth is off, everything
    /// is authorized; when on, the token must match the env token OR one of the
    /// configured API keys — **in constant time**, so a timing side-channel
    /// can't recover a secret byte-by-byte (audit #6). We compare against every
    /// candidate without early-out on a match, so the work is independent of
    /// which (if any) key matched.
    pub fn authorized(&self, presented: Option<&str>) -> bool {
        use subtle::ConstantTimeEq;

        if !self.enabled {
            return true;
        }

        let Some(p) = presented else {
            return false;
        };
        let p = p.as_bytes();

        let mut ok = false;
        // ct_eq is constant-time over the byte content for equal-length slices;
        // an unequal length short-circuits (length isn't secret). We OR across
        // every acceptable token without short-circuit, so timing is independent
        // of which (if any) key matched.
        for expected in &self.tokens {
            ok |= bool::from(p.ct_eq(expected.as_bytes()));
        }
        ok
    }

    /// Constant-time check that `presented` matches a configured **global**
    /// token, regardless of `enabled`. Unlike [`authorized`], this does NOT
    /// return true when auth is off — so a workspace `tk_` token is never
    /// misclassified as a global admin token when no global keys are set
    /// (Node's `validate()` vs `isAuthorized()` distinction; the H5 trap).
    pub fn validate(&self, presented: &str) -> bool {
        use subtle::ConstantTimeEq;
        let p = presented.as_bytes();
        let mut ok = false;
        for expected in &self.tokens {
            ok |= bool::from(p.ct_eq(expected.as_bytes()));
        }
        ok
    }

    /// Pull the bearer token out of an `Authorization` header value. Mirrors
    /// Node's `/^Bearer\s+(\S+)$/i` (`packages/collector/src/auth.ts`):
    /// case-insensitive `Bearer`, one-or-more whitespace, then a single run of
    /// non-whitespace to end-of-string. A token with surrounding or internal
    /// whitespace (e.g. `"Bearer abc "`) does NOT match — Node returns null there.
    pub fn extract_bearer(header: Option<&str>) -> Option<&str> {
        let h = header?;
        // First 6 bytes must be "Bearer" (ASCII → byte 6 is a char boundary).
        if !h.get(..6).is_some_and(|p| p.eq_ignore_ascii_case("Bearer")) {
            return None;
        }
        let rest = &h[6..];
        if !rest.starts_with(char::is_whitespace) {
            return None; // require the `\s+` separator
        }
        let tok = rest.trim_start();
        if tok.is_empty() || tok.contains(char::is_whitespace) {
            return None; // `\S+$` — no internal/trailing whitespace
        }
        Some(tok)
    }
}

/// Parse `RUNTIMESCOPE_AUTH_TOKEN` into the comma-separated token set Node
/// `standalone.ts` builds (`split(',').map(trim).filter(Boolean)`).
fn env_tokens() -> Vec<String> {
    std::env::var("RUNTIMESCOPE_AUTH_TOKEN")
        .unwrap_or_default()
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
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

    // The H5 trap: `validate()` must NOT inherit `authorized()`'s "auth off →
    // everything passes" semantics, or the HTTP gate would misclassify a
    // workspace `tk_` token as the global admin token whenever no global keys
    // are configured. validate() = "matches a real global token", period.
    #[test]
    fn validate_never_passes_when_no_global_token_is_configured() {
        let _env = EnvGuard::unset();
        let mgr = AuthManager::for_mode(AuthMode::Standalone); // no token → disabled
        assert!(!mgr.enabled());
        assert!(mgr.authorized(Some("anything")), "authorized() trusts everything when off");
        assert!(!mgr.validate("anything"), "validate() must NOT trust a token when no global key exists");
        assert!(!mgr.validate("tk_workspacetoken"), "a workspace token is not a global admin token");
    }

    #[test]
    fn validate_matches_only_the_configured_global_token() {
        let _env = EnvGuard::set("env-token-xyz");
        let mgr = AuthManager::from_env();
        assert!(mgr.validate("env-token-xyz"), "the configured global token validates");
        assert!(!mgr.validate("env-token-xy"), "a near-miss does not validate");
        assert!(!mgr.validate("tk_workspace"), "a workspace token does not validate as global");
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
    fn standalone_env_token_takes_precedence_over_config() {
        // Node standalone: `authFromEnv?.apiKeys ?? config…` — when an env token
        // is set, the config `auth` is IGNORED entirely (env precedence), so a
        // config-only key must NOT authorize.
        let _env = EnvGuard::set("env-token-xyz");
        let dir = tmp_dir("env-and-cfg");
        write_config(
            &dir,
            r#"{ "auth": { "enabled": true, "apiKeys": [ { "key": "cfg-key-123", "label": "x", "createdAt": 0 } ] } }"#,
        );

        let mgr = AuthManager::from_env_and_dir(&dir);
        assert!(mgr.enabled());
        assert!(mgr.authorized(Some("env-token-xyz")), "env token authorizes");
        assert!(!mgr.authorized(Some("cfg-key-123")), "config key ignored when env token set (precedence)");
        assert!(!mgr.authorized(Some("nope")));
    }

    #[test]
    fn standalone_env_token_is_comma_split() {
        // Node standalone splits RUNTIMESCOPE_AUTH_TOKEN on ',' (with trim) into
        // multiple acceptable keys.
        let _env = EnvGuard::set(" tok-a , tok-b ,, tok-c ");
        let dir = tmp_dir("env-csv");
        let mgr = AuthManager::from_env_and_dir(&dir);
        assert!(mgr.enabled());
        assert!(mgr.authorized(Some("tok-a")), "first env token authorizes");
        assert!(mgr.authorized(Some("tok-b")), "second env token authorizes");
        assert!(mgr.authorized(Some("tok-c")), "third env token authorizes");
        assert!(!mgr.authorized(Some("tok-d")));
        // The raw comma-joined string is NOT a single valid token.
        assert!(!mgr.authorized(Some("tok-a,tok-b")));
    }

    #[test]
    fn mcp_mode_ignores_env_token_and_uses_config_only() {
        // Node MCP server (index.ts) constructs AuthManager from config ONLY; the
        // env var is never read. So an env token must neither enable nor authorize.
        let _env = EnvGuard::set("env-token-xyz");
        let dir = tmp_dir("mcp-config-only");
        write_config(
            &dir,
            r#"{ "auth": { "enabled": true, "apiKeys": [ { "key": "cfg-key-123", "label": "x", "createdAt": 0 } ] } }"#,
        );
        let mgr = AuthManager::from_config_and_dir(&dir);
        assert!(mgr.enabled(), "config enabled → auth on");
        assert!(mgr.authorized(Some("cfg-key-123")), "config key authorizes in MCP mode");
        assert!(!mgr.authorized(Some("env-token-xyz")), "env token must NOT authorize in MCP mode");

        // And with no config + an env token, MCP auth stays OFF (env ignored).
        let dir2 = tmp_dir("mcp-no-config");
        let mgr2 = AuthManager::from_config_and_dir(&dir2);
        assert!(!mgr2.enabled(), "MCP mode ignores the env token → auth off");
        assert!(mgr2.authorized(Some("env-token-xyz")), "auth off → everything passes");
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
    fn extract_bearer_matches_node_regex() {
        // /^Bearer\s+(\S+)$/i
        assert_eq!(AuthManager::extract_bearer(Some("Bearer abc")), Some("abc"));
        assert_eq!(AuthManager::extract_bearer(Some("BEARER abc")), Some("abc"), "case-insensitive scheme");
        assert_eq!(AuthManager::extract_bearer(Some("Bearer   abc")), Some("abc"), "\\s+ collapses multiple spaces");
        // Surrounding/internal whitespace in the token → no match (Node returns null).
        assert_eq!(AuthManager::extract_bearer(Some("Bearer abc ")), None, "trailing space → no match");
        assert_eq!(AuthManager::extract_bearer(Some("Bearer a b")), None, "internal space → no match");
        assert_eq!(AuthManager::extract_bearer(Some("Bearer")), None, "no separator → no match");
        assert_eq!(AuthManager::extract_bearer(Some("Bearer ")), None, "empty token → no match");
        assert_eq!(AuthManager::extract_bearer(Some("Basic abc")), None);
        assert_eq!(AuthManager::extract_bearer(None), None);
    }
}

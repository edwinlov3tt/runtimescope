//! Auth model — `docs/specs/wire-protocol.md` §3 (WS) + §7 (HTTP).
//!
//! Off by default; enabled when `RUNTIMESCOPE_AUTH_TOKEN` is set. HTTP uses
//! `Authorization: Bearer <token>`; the WS handshake carries `authToken`. The
//! public-route set (health/readyz/metrics/snippet/dashboard) is reachable
//! without auth even when enabled; everything else is gated (401).

#[derive(Clone)]
pub struct AuthManager {
    token: Option<String>,
}

impl AuthManager {
    pub fn from_env() -> Self {
        let token = std::env::var("RUNTIMESCOPE_AUTH_TOKEN").ok().filter(|s| !s.is_empty());
        AuthManager { token }
    }

    pub fn enabled(&self) -> bool {
        self.token.is_some()
    }

    /// True if the presented token is acceptable. When auth is off, everything
    /// is authorized; when on, the token must match exactly.
    pub fn authorized(&self, presented: Option<&str>) -> bool {
        match &self.token {
            None => true,
            Some(expected) => presented == Some(expected.as_str()),
        }
    }

    /// Pull the bearer token out of an `Authorization` header value.
    pub fn extract_bearer(header: Option<&str>) -> Option<&str> {
        header
            .and_then(|h| h.strip_prefix("Bearer ").or_else(|| h.strip_prefix("bearer ")))
            .map(str::trim)
    }
}

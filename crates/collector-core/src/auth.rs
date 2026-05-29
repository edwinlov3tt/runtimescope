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
    /// is authorized; when on, the token must match — **in constant time**, so a
    /// timing side-channel can't recover the token byte-by-byte (audit #6).
    pub fn authorized(&self, presented: Option<&str>) -> bool {
        use subtle::ConstantTimeEq;
        match &self.token {
            None => true,
            Some(expected) => {
                // ct_eq is constant-time over the byte content for equal-length
                // slices; an unequal length short-circuits (length isn't secret).
                presented
                    .map(|p| bool::from(p.as_bytes().ct_eq(expected.as_bytes())))
                    .unwrap_or(false)
            }
        }
    }

    /// Pull the bearer token out of an `Authorization` header value.
    pub fn extract_bearer(header: Option<&str>) -> Option<&str> {
        header
            .and_then(|h| h.strip_prefix("Bearer ").or_else(|| h.strip_prefix("bearer ")))
            .map(str::trim)
    }
}

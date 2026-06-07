//! Uptime / status (ADR-0012 slice 5) — pure classification + status rollups, and
//! the SSRF guard for the active probe. The store + endpoints + the background
//! probe task live in analytics_store.rs / server.rs; this module is the pure,
//! testable core. See docs/specs/analytics-uptime-slice5.md.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};

const DAY_MS: i64 = 86_400_000;

/// State codes shared with the dashboard strip: up / degraded / down.
pub const UP: u8 = 0;
pub const DEGRADED: u8 = 1;
pub const DOWN: u8 = 2;

/// Classify a probe result: unreachable/non-2xx ⇒ down; 2xx but slow ⇒ degraded;
/// else up.
pub fn classify(ok_2xx: bool, resp_ms: u64, slow_ms: u64) -> u8 {
    if !ok_2xx {
        DOWN
    } else if resp_ms > slow_ms {
        DEGRADED
    } else {
        UP
    }
}

/// Per-app status from its checks `(checked_at, state, resp_ms?)`: 90-day uptime %,
/// a 60-day daily strip (worst state per day; index 59 = today; -1 = no data), and
/// the latest check. `uptimePct` is null when there are no checks in the window.
pub fn app_status(checks: &[(i64, u8, Option<i64>)], now: i64) -> Value {
    let since90 = now - 90 * DAY_MS;
    let mut total = 0usize;
    let mut up = 0usize;
    let mut strip_worst: HashMap<usize, u8> = HashMap::new();
    let mut last: Option<&(i64, u8, Option<i64>)> = None;

    for c in checks {
        let (at, state, _) = c;
        if *at > now {
            continue; // ignore future-dated checks
        }
        if *at >= since90 {
            total += 1;
            if *state == UP {
                up += 1;
            }
        }
        let days_ago = (now - at) / DAY_MS;
        if (0..60).contains(&days_ago) {
            let idx = 59 - days_ago as usize;
            let e = strip_worst.entry(idx).or_insert(UP);
            *e = (*e).max(*state); // worst state that day (down > degraded > up)
        }
        if last.is_none_or(|l| at > &l.0) {
            last = Some(c);
        }
    }

    let strip: Vec<Value> = (0..60)
        .map(|i| strip_worst.get(&i).map(|s| json!(s)).unwrap_or(json!(-1)))
        .collect();
    let uptime_pct = if total > 0 {
        json!(((up as f64 / total as f64) * 100.0 * 100.0).round() / 100.0)
    } else {
        Value::Null
    };
    json!({
        "uptimePct": uptime_pct,
        "strip": strip,
        "lastState": last.map(|l| json!(l.1)).unwrap_or(Value::Null),
        "lastRespMs": last.and_then(|l| l.2).map(|m| json!(m)).unwrap_or(Value::Null),
        "lastCheck": last.map(|l| json!(l.0)).unwrap_or(Value::Null),
    })
}

/// Block private / loopback / link-local (incl. the 169.254.169.254 cloud
/// metadata IP) / unspecified / documentation / ULA addresses — the SSRF blocklist.
pub fn is_blocked_ip(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local() // 169.254/16 — includes the metadata IP
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.octets()[0] == 0 // 0.0.0.0/8
                || (v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 64) // 100.64/10 CGNAT
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || (v6.segments()[0] & 0xfe00) == 0xfc00 // fc00::/7 unique-local
                || (v6.segments()[0] & 0xffc0) == 0xfe80 // fe80::/10 link-local
                || (v6.segments()[0] == 0x0064 && v6.segments()[1] == 0xff9b) // NAT64 64:ff9b::/96
                // ::ffff:a.b.c.d (mapped) AND ::a.b.c.d (deprecated compatible) —
                // re-check the embedded v4 (to_ipv4 covers both forms).
                || v6.to_ipv4().is_some_and(|m| is_blocked_ip(&IpAddr::V4(m)))
        }
    }
}

/// Validate a probe target: http(s) only, and (unless `allow_private`) its host
/// must not resolve to a blocked IP — the active-probe SSRF guard. Returns the
/// parsed URL and, when not `allow_private`, the **validated socket address** the
/// caller MUST pin the connection to (via `reqwest`'s `.resolve()`), so the HTTP
/// client cannot perform a second, attacker-controlled DNS lookup (DNS rebinding).
/// `None` addr ⇒ `allow_private` (operator opted in; no pin needed).
pub async fn guard_probe_url(raw: &str, allow_private: bool) -> Result<(reqwest::Url, Option<SocketAddr>), String> {
    let url = reqwest::Url::parse(raw).map_err(|e| format!("invalid URL: {e}"))?;
    match url.scheme() {
        "http" | "https" => {}
        s => return Err(format!("scheme '{s}' not allowed (http/https only)")),
    }
    if allow_private {
        return Ok((url, None));
    }
    let host = url.host_str().ok_or_else(|| "URL has no host".to_string())?;
    let port = url.port_or_known_default().unwrap_or(80);
    let addrs: Vec<SocketAddr> =
        tokio::net::lookup_host((host, port)).await.map_err(|e| format!("DNS resolve failed: {e}"))?.collect();
    if addrs.is_empty() {
        return Err("host did not resolve".to_string());
    }
    for addr in &addrs {
        if is_blocked_ip(&addr.ip()) {
            return Err(format!("blocked target (private/loopback/link-local IP {})", addr.ip()));
        }
    }
    // Every resolved address passed — pin to the first so the HTTP client connects
    // to a validated IP rather than re-resolving to an attacker-flipped one.
    Ok((url, Some(addrs[0])))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_up_degraded_down() {
        assert_eq!(classify(true, 120, 400), UP);
        assert_eq!(classify(true, 512, 400), DEGRADED);
        assert_eq!(classify(false, 0, 400), DOWN);
    }

    #[test]
    fn app_status_uptime_strip_and_latest() {
        let now = 1_000 * DAY_MS;
        // today up(120ms), today down, 1d-ago degraded, 95d-ago up (outside 90d window)
        let checks = vec![
            (now, UP, Some(120)),
            (now - 1000, DOWN, None),
            (now - DAY_MS, DEGRADED, Some(450)),
            (now - 95 * DAY_MS, UP, Some(50)),
        ];
        let s = app_status(&checks, now);
        // 90d window has 3 checks, 1 up → 33.33%
        assert_eq!(s["uptimePct"], json!(33.33));
        // latest is the `now` up check
        assert_eq!(s["lastState"], json!(UP));
        assert_eq!(s["lastRespMs"], json!(120));
        let strip = s["strip"].as_array().unwrap();
        assert_eq!(strip.len(), 60);
        assert_eq!(strip[59], json!(DOWN), "today's worst state is down");
        assert_eq!(strip[58], json!(DEGRADED), "yesterday degraded");
        assert_eq!(strip[0], json!(-1), "no data 59 days ago");
        // no checks → null uptime
        assert_eq!(app_status(&[], now)["uptimePct"], Value::Null);
    }

    #[test]
    fn ssrf_blocklist_covers_private_loopback_metadata() {
        let b = |s: &str| is_blocked_ip(&s.parse::<IpAddr>().unwrap());
        assert!(b("127.0.0.1"));
        assert!(b("10.1.2.3"));
        assert!(b("172.16.0.1"));
        assert!(b("192.168.1.1"));
        assert!(b("169.254.169.254"), "cloud metadata IP");
        assert!(b("0.0.0.0"));
        assert!(b("100.100.0.1"), "CGNAT");
        assert!(b("::1"));
        assert!(b("fe80::1"));
        assert!(b("fc00::1"));
        assert!(b("64:ff9b::a00:1"), "NAT64 embedding a private IPv4");
        assert!(b("::ffff:10.0.0.1"), "IPv4-mapped private");
        assert!(b("::127.0.0.1"), "deprecated IPv4-compatible loopback");
        // public addresses pass
        assert!(!b("93.184.216.34")); // example.com
        assert!(!b("8.8.8.8"));
        assert!(!b("2606:2800:220:1:248:1893:25c8:1946"));
    }

    #[tokio::test]
    async fn guard_blocks_scheme_and_private_ips_allows_public() {
        // scheme allowlist
        assert!(guard_probe_url("file:///etc/passwd", false).await.is_err());
        assert!(guard_probe_url("gopher://x", false).await.is_err());
        // IP-literal hosts resolve offline → exercises the blocklist
        assert!(guard_probe_url("http://127.0.0.1/health", false).await.is_err());
        assert!(guard_probe_url("http://169.254.169.254/latest/meta-data", false).await.is_err());
        assert!(guard_probe_url("http://10.0.0.5", false).await.is_err());
        // allow_private opt-in lets a loopback target through (still http only)
        assert!(guard_probe_url("http://127.0.0.1/health", true).await.is_ok());
        // public IP literal passes
        assert!(guard_probe_url("https://93.184.216.34/", false).await.is_ok());
    }
}

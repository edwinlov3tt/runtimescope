//! Analytics usage rollups (ADR-0012, slice 2) — pure aggregations over the
//! `custom` event stream (the usage spine, stamped with `anonId` by
//! `RuntimeScope.identify()`).
//!
//! **No ROI / $ here.** value/hours need the baselines×roles join (ROI engine,
//! slice 3 — a strong candidate for the Mosaic cube engine). These functions
//! take the raw event `Value`s so they're unit-testable without a store, and so
//! the same inputs could later feed a Mosaic cube instead of this hand-rolled
//! aggregation.

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

const DAY_MS: i64 = 86_400_000;

/// Cutoff timestamp for a window label (`7d`/`30d`/`90d`), or `None` for `all`.
/// Unknown labels default to 30 days.
pub fn window_cutoff(now: i64, window: &str) -> Option<i64> {
    let days = match window {
        "all" | "" => return None,
        "7d" => 7,
        "90d" => 90,
        "30d" => 30,
        other => other.trim_end_matches('d').parse::<i64>().unwrap_or(30),
    };
    Some(now - days * DAY_MS)
}

fn anon_of(e: &Value) -> Option<&str> {
    e.get("anonId").and_then(Value::as_str).filter(|s| !s.is_empty())
}
fn name_of(e: &Value) -> Option<&str> {
    e.get("name").and_then(Value::as_str).filter(|s| !s.is_empty())
}
fn ts_of(e: &Value) -> i64 {
    e.get("timestamp").and_then(Value::as_i64).unwrap_or(0)
}
fn session_of(e: &Value) -> Option<&str> {
    e.get("sessionId").and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// Distinct identified users active (≥1 anon-stamped event) within `window`.
pub fn active_users(events: &[Value], now: i64, window: &str) -> usize {
    let cutoff = window_cutoff(now, window);
    let mut set = HashSet::new();
    for e in events {
        if cutoff.is_none_or(|c| ts_of(e) >= c) {
            if let Some(a) = anon_of(e) {
                set.insert(a);
            }
        }
    }
    set.len()
}

/// Overview usage KPIs. `invited` = total identified users (the adoption
/// denominator; see the spec's "User populations" section). value/hours are
/// intentionally absent until the ROI engine (slice 3).
pub fn overview(events: &[Value], now: i64, window: &str, invited: usize) -> Value {
    let cutoff = window_cutoff(now, window);
    let mut active: HashSet<&str> = HashSet::new();
    let (mut dau, mut wau, mut mau): (HashSet<&str>, HashSet<&str>, HashSet<&str>) =
        (HashSet::new(), HashSet::new(), HashSet::new());
    let mut total = 0usize;
    for e in events {
        if cutoff.is_some_and(|c| ts_of(e) < c) {
            continue;
        }
        total += 1;
        if let Some(a) = anon_of(e) {
            active.insert(a);
            let age = now - ts_of(e);
            if age <= DAY_MS {
                dau.insert(a);
            }
            if age <= 7 * DAY_MS {
                wau.insert(a);
            }
            if age <= 30 * DAY_MS {
                mau.insert(a);
            }
        }
    }
    let days = cutoff.map(|c| (((now - c) as f64) / DAY_MS as f64).max(1.0)).unwrap_or(30.0);
    let pct = |num: usize, den: usize| if den > 0 { (num as f64 / den as f64 * 100.0).round() } else { 0.0 };
    json!({
        "activeUsers": active.len(),
        "invited": invited,
        "adoptionPct": pct(active.len(), invited),
        "totalEvents": total,
        "eventsPerDay": (total as f64 / days).round(),
        "dau": dau.len(),
        "wau": wau.len(),
        "mau": mau.len(),
        "stickinessPct": pct(wau.len(), mau.len()),
    })
}

/// Per-user usage rollup keyed by `anonId`: events, distinct features/sessions,
/// first/last seen. Merge onto the anonymized user record for the Users view.
pub fn user_rollups(events: &[Value]) -> HashMap<String, Value> {
    struct Agg {
        events: usize,
        features: HashSet<String>,
        sessions: HashSet<String>,
        first: i64,
        last: i64,
    }
    let mut m: HashMap<String, Agg> = HashMap::new();
    for e in events {
        let Some(a) = anon_of(e) else { continue };
        let ts = ts_of(e);
        let agg = m.entry(a.to_string()).or_insert(Agg {
            events: 0,
            features: HashSet::new(),
            sessions: HashSet::new(),
            first: ts,
            last: ts,
        });
        agg.events += 1;
        if let Some(n) = name_of(e) {
            agg.features.insert(n.to_string());
        }
        if let Some(s) = session_of(e) {
            agg.sessions.insert(s.to_string());
        }
        agg.first = agg.first.min(ts);
        agg.last = agg.last.max(ts);
    }
    m.into_iter()
        .map(|(k, v)| {
            (
                k,
                json!({
                    "events": v.events,
                    "features": v.features.len(),
                    "sessions": v.sessions.len(),
                    "firstSeenEvent": v.first,
                    "lastSeenEvent": v.last,
                }),
            )
        })
        .collect()
}

/// Per-feature (custom-event `name`) rollup. `adoptionPct` is over **active
/// users** (NOT invited — see the spec). Sorted by events desc.
pub fn feature_rollups(events: &[Value], active_users: usize) -> Vec<Value> {
    struct F {
        users: HashSet<String>,
        events: usize,
        last: i64,
    }
    let mut m: HashMap<String, F> = HashMap::new();
    for e in events {
        let Some(n) = name_of(e) else { continue };
        let f = m.entry(n.to_string()).or_insert(F { users: HashSet::new(), events: 0, last: 0 });
        f.events += 1;
        if let Some(a) = anon_of(e) {
            f.users.insert(a.to_string());
        }
        f.last = f.last.max(ts_of(e));
    }
    let mut out: Vec<Value> = m
        .into_iter()
        .map(|(name, f)| {
            let users = f.users.len();
            let adoption = if active_users > 0 { (users as f64 / active_users as f64 * 100.0).round() } else { 0.0 };
            json!({
                "feature": name,
                "users": users,
                "events": f.events,
                "adoptionPct": adoption,
                "lastSeen": f.last,
            })
        })
        .collect();
    out.sort_by(|a, b| b["events"].as_u64().unwrap_or(0).cmp(&a["events"].as_u64().unwrap_or(0)));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(anon: &str, name: &str, session: &str, ts: i64) -> Value {
        json!({ "eventType": "custom", "anonId": anon, "name": name, "sessionId": session, "timestamp": ts })
    }

    #[test]
    fn overview_counts_distinct_active_and_adoption() {
        let now = 1_000 * DAY_MS;
        let events = vec![
            ev("A", "geocode", "s1", now - 1000),          // today
            ev("A", "export", "s1", now - 2 * DAY_MS),     // this week
            ev("B", "geocode", "s2", now - 10 * DAY_MS),   // this month
            ev("C", "geocode", "s3", now - 200 * DAY_MS),  // outside 30d window
        ];
        // 30d window: A,B active (C is 200d old); invited=5 → adoption 2/5=40%.
        let ov = overview(&events, now, "30d", 5);
        assert_eq!(ov["activeUsers"], 2);
        assert_eq!(ov["adoptionPct"], 40.0);
        assert_eq!(ov["dau"], 1); // only A in last 24h
        assert_eq!(ov["mau"], 2);
        // all-time: A,B,C active
        assert_eq!(overview(&events, now, "all", 5)["activeUsers"], 3);
    }

    #[test]
    fn user_and_feature_rollups_dedup_correctly() {
        let now = 1_000 * DAY_MS;
        let events = vec![
            ev("A", "geocode", "s1", now - 1000),
            ev("A", "geocode", "s1", now - 2000), // same feature+session
            ev("A", "export", "s2", now - 3000),  // new feature + session
            ev("B", "geocode", "s3", now - 4000),
        ];
        let ur = user_rollups(&events);
        assert_eq!(ur["A"]["events"], 3);
        assert_eq!(ur["A"]["features"], 2); // geocode, export
        assert_eq!(ur["A"]["sessions"], 2); // s1, s2

        let fr = feature_rollups(&events, 2); // 2 active users
        // geocode first (3 events), then export (1)
        assert_eq!(fr[0]["feature"], "geocode");
        assert_eq!(fr[0]["events"], 3);
        assert_eq!(fr[0]["users"], 2); // A, B
        assert_eq!(fr[0]["adoptionPct"], 100.0); // 2/2
        assert_eq!(fr[1]["feature"], "export");
        assert_eq!(fr[1]["adoptionPct"], 50.0); // 1/2
    }
}

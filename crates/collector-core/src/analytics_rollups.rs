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

/// Bucketed time series over `window` (default 90d span if "all"): `buckets`
/// equal slices, each with distinct active users + event count. Drives the Trends
/// chart. Value series (cumulative $) is ROI → slice 3.
pub fn trends(events: &[Value], now: i64, window: &str, buckets: usize) -> Value {
    let buckets = buckets.clamp(1, 365);
    let cutoff = window_cutoff(now, window).unwrap_or(now - 90 * DAY_MS);
    let span = (((now - cutoff) as f64) / buckets as f64).max(1.0);
    let mut user_sets: Vec<HashSet<&str>> = vec![HashSet::new(); buckets];
    let mut ev_counts = vec![0u64; buckets];
    let starts: Vec<i64> = (0..buckets).map(|b| cutoff + (span * b as f64) as i64).collect();
    for e in events {
        let ts = ts_of(e);
        if ts < cutoff || ts > now {
            continue;
        }
        let idx = (((ts - cutoff) as f64 / span) as usize).min(buckets - 1);
        ev_counts[idx] += 1;
        if let Some(a) = anon_of(e) {
            user_sets[idx].insert(a);
        }
    }
    let users: Vec<usize> = user_sets.iter().map(HashSet::len).collect();
    json!({ "bucketStartMs": starts, "users": users, "events": ev_counts })
}

/// Activation funnel: identified (=invited) → activated (≥1 event) → repeat (≥2
/// sessions) → power (active in last 7d). All-time (not windowed); `invited` is
/// the total identified-user count.
pub fn funnel(events: &[Value], now: i64, invited: usize) -> Value {
    let mut sessions: HashMap<&str, HashSet<&str>> = HashMap::new();
    let mut last: HashMap<&str, i64> = HashMap::new();
    for e in events {
        let Some(a) = anon_of(e) else { continue };
        if let Some(s) = session_of(e) {
            sessions.entry(a).or_default().insert(s);
        }
        let l = last.entry(a).or_insert(0);
        *l = (*l).max(ts_of(e));
    }
    json!({
        "identified": invited,
        "activated": sessions.len(),
        "repeat": sessions.values().filter(|s| s.len() >= 2).count(),
        "power": last.values().filter(|&&t| now - t <= 7 * DAY_MS).count(),
    })
}

/// Current-vs-prior comparison grouped by an arbitrary key (the prior window is
/// the equal-length span immediately before the current one). `key_of` returns
/// the group for an event (None ⇒ skip); `key_name` is the emitted field
/// (`role`/`app`). `count_users` keys distinct users on `anonId`. value/$ → slice 3.
pub fn compare_grouped<F: Fn(&Value) -> Option<String>>(
    events: &[Value],
    key_of: F,
    key_name: &str,
    now: i64,
    window: &str,
) -> Vec<Value> {
    let cur_cut = window_cutoff(now, window).unwrap_or(now - 30 * DAY_MS);
    let prev_cut = cur_cut - (now - cur_cut);
    #[derive(Default)]
    struct R {
        cu: HashSet<String>,
        ce: u64,
        pu: HashSet<String>,
        pe: u64,
    }
    let mut m: HashMap<String, R> = HashMap::new();
    for e in events {
        let Some(key) = key_of(e) else { continue };
        let ts = ts_of(e);
        let user = anon_of(e).map(str::to_string);
        let r = m.entry(key).or_default();
        if ts >= cur_cut && ts <= now {
            r.ce += 1;
            if let Some(u) = user {
                r.cu.insert(u);
            }
        } else if ts >= prev_cut && ts < cur_cut {
            r.pe += 1;
            if let Some(u) = user {
                r.pu.insert(u);
            }
        }
    }
    let mut out: Vec<Value> = m
        .into_iter()
        .map(|(key, r)| {
            json!({ key_name: key, "users": r.cu.len(), "events": r.ce, "prevUsers": r.pu.len(), "prevEvents": r.pe })
        })
        .collect();
    out.sort_by(|a, b| b["events"].as_u64().unwrap_or(0).cmp(&a["events"].as_u64().unwrap_or(0)));
    out
}

/// Compare by role — `roles` maps anonId → role (from analytics_users).
pub fn compare_by_role(events: &[Value], roles: &HashMap<String, String>, now: i64, window: &str) -> Vec<Value> {
    compare_grouped(
        events,
        |e| anon_of(e).map(|a| roles.get(a).cloned().unwrap_or_else(|| "unknown".to_string())),
        "role",
        now,
        window,
    )
}

/// Compare by app — `session_app` maps sessionId → appName (from `session`
/// events, since `custom` events don't carry the app directly).
pub fn compare_by_app(events: &[Value], session_app: &HashMap<String, String>, now: i64, window: &str) -> Vec<Value> {
    compare_grouped(
        events,
        |e| session_of(e).map(|s| session_app.get(s).cloned().unwrap_or_else(|| "unknown".to_string())),
        "app",
        now,
        window,
    )
}

/// Stacked per-feature event series over `window`: the top-N features by total
/// events each get a bucketed series; the rest fold into `other`. Drives the
/// "Events by Feature / week" chart.
pub fn feature_trends(events: &[Value], now: i64, window: &str, buckets: usize, top_n: usize) -> Value {
    let buckets = buckets.clamp(1, 365);
    let cutoff = window_cutoff(now, window).unwrap_or(now - 90 * DAY_MS);
    let span = (((now - cutoff) as f64) / buckets as f64).max(1.0);
    let starts: Vec<i64> = (0..buckets).map(|b| cutoff + (span * b as f64) as i64).collect();

    // Total per feature (windowed) → pick the top-N.
    let mut totals: HashMap<&str, u64> = HashMap::new();
    for e in events {
        let ts = ts_of(e);
        if ts < cutoff || ts > now {
            continue;
        }
        if let Some(n) = name_of(e) {
            *totals.entry(n).or_insert(0) += 1;
        }
    }
    let mut ranked: Vec<(&str, u64)> = totals.into_iter().collect();
    ranked.sort_by_key(|x| std::cmp::Reverse(x.1));
    let top: Vec<String> = ranked.iter().take(top_n).map(|(n, _)| n.to_string()).collect();
    let top_set: HashSet<&str> = top.iter().map(String::as_str).collect();

    let mut series: HashMap<String, Vec<u64>> = top.iter().map(|n| (n.clone(), vec![0u64; buckets])).collect();
    let mut other = vec![0u64; buckets];
    for e in events {
        let ts = ts_of(e);
        if ts < cutoff || ts > now {
            continue;
        }
        let Some(n) = name_of(e) else { continue };
        let idx = (((ts - cutoff) as f64 / span) as usize).min(buckets - 1);
        if top_set.contains(n) {
            series.get_mut(n).unwrap()[idx] += 1;
        } else {
            other[idx] += 1;
        }
    }
    let mut out: Vec<Value> = top.iter().map(|n| json!({ "feature": n, "data": series[n] })).collect();
    if other.iter().any(|&c| c > 0) {
        out.push(json!({ "feature": "other", "data": other }));
    }
    json!({ "bucketStartMs": starts, "series": out })
}

/// Weekly cohort retention: each anon's signup week = its first event; `cells[k]`
/// = % of that cohort active k weeks later. Triangular (null for future weeks).
pub fn cohort_retention(events: &[Value], now: i64, weeks: usize) -> Vec<Value> {
    const WEEK_MS: i64 = 7 * DAY_MS;
    let weeks = weeks.clamp(1, 53);
    let start = now - (weeks as i64) * WEEK_MS;
    // first-seen ts per anon (signup) + the set of week-indices each was active.
    let mut first: HashMap<&str, i64> = HashMap::new();
    let mut active_weeks: HashMap<&str, HashSet<i64>> = HashMap::new();
    for e in events {
        let Some(a) = anon_of(e) else { continue };
        let ts = ts_of(e);
        if ts < start || ts > now {
            continue;
        }
        first.entry(a).and_modify(|f| *f = (*f).min(ts)).or_insert(ts);
        let wk = (ts - start) / WEEK_MS;
        active_weeks.entry(a).or_default().insert(wk);
    }
    // group anons by signup week
    let mut cohorts: HashMap<i64, Vec<&str>> = HashMap::new();
    for (a, f) in &first {
        cohorts.entry((*f - start) / WEEK_MS).or_default().push(a);
    }
    let mut rows: Vec<Value> = Vec::new();
    for cohort_wk in 0..weeks as i64 {
        let Some(members) = cohorts.get(&cohort_wk) else { continue };
        let size = members.len();
        let max_offset = (weeks as i64) - cohort_wk;
        let cells: Vec<Value> = (0..weeks as i64 - cohort_wk)
            .map(|off| {
                let target = cohort_wk + off;
                let active = members.iter().filter(|a| active_weeks.get(**a).is_some_and(|w| w.contains(&target))).count();
                json!(((active as f64 / size as f64) * 100.0).round())
            })
            .chain((max_offset..weeks as i64).map(|_| Value::Null))
            .collect();
        rows.push(json!({ "cohortStartMs": start + cohort_wk * WEEK_MS, "size": size, "cells": cells }));
    }
    rows
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

    #[test]
    fn trends_buckets_and_funnel_and_compare() {
        let now = 1_000 * DAY_MS;
        let events = vec![
            ev("A", "geocode", "s1", now - 1 * DAY_MS),
            ev("A", "export", "s2", now - 2 * DAY_MS),  // A: 2 sessions → repeat; active last 7d → power
            ev("B", "geocode", "s3", now - 20 * DAY_MS), // B: 1 session, not last-7d
            ev("C", "geocode", "s4", now - 45 * DAY_MS), // C: in the PRIOR 30d window [now-60d, now-30d)
        ];

        // trends: 30d window, 3 buckets of 10d each. A's 2 events land in the last
        // bucket; B in the first; C is outside 30d.
        let t = trends(&events, now, "30d", 3);
        assert_eq!(t["events"].as_array().unwrap().len(), 3);
        assert_eq!(t["events"][2], 2); // A's two events, most-recent bucket
        assert_eq!(t["users"][2], 1); // distinct A

        // funnel: invited 5, activated 3 (A,B,C), repeat 1 (A has 2 sessions),
        // power 1 (only A active in last 7d).
        let f = funnel(&events, now, 5);
        assert_eq!(f["identified"], 5);
        assert_eq!(f["activated"], 3);
        assert_eq!(f["repeat"], 1);
        assert_eq!(f["power"], 1);

        // compare by role, 30d: A,B = Specialist (current); C = Director (prior).
        let mut roles = HashMap::new();
        roles.insert("A".to_string(), "Specialist".to_string());
        roles.insert("B".to_string(), "Specialist".to_string());
        roles.insert("C".to_string(), "Director".to_string());
        let cmp = compare_by_role(&events, &roles, now, "30d");
        let spec = cmp.iter().find(|r| r["role"] == "Specialist").unwrap();
        assert_eq!(spec["users"], 2); // A,B current
        assert_eq!(spec["events"], 3);
        let dir = cmp.iter().find(|r| r["role"] == "Director").unwrap();
        assert_eq!(dir["users"], 0); // none current
        assert_eq!(dir["prevUsers"], 1); // C in prior window
        assert_eq!(dir["prevEvents"], 1);
    }

    #[test]
    fn feature_trends_top_n_folds_rest_into_other() {
        let now = 1_000 * DAY_MS;
        let events = vec![
            ev("A", "geocode", "s1", now - 1 * DAY_MS),
            ev("A", "geocode", "s1", now - 2 * DAY_MS),
            ev("A", "export", "s1", now - 1 * DAY_MS),
            ev("A", "minor", "s1", now - 1 * DAY_MS), // top_n=2 → folded into "other"
        ];
        let t = feature_trends(&events, now, "30d", 3, 2);
        let series = t["series"].as_array().unwrap();
        let names: Vec<&str> = series.iter().map(|s| s["feature"].as_str().unwrap()).collect();
        assert!(names.contains(&"geocode") && names.contains(&"export") && names.contains(&"other"));
        let geo = series.iter().find(|s| s["feature"] == "geocode").unwrap();
        let sum: u64 = geo["data"].as_array().unwrap().iter().map(|v| v.as_u64().unwrap()).sum();
        assert_eq!(sum, 2);
    }

    #[test]
    fn compare_by_app_groups_via_session_app_map() {
        let now = 1_000 * DAY_MS;
        let events = vec![
            ev("A", "f", "s1", now - 1 * DAY_MS),
            ev("B", "f", "s2", now - 1 * DAY_MS),
            ev("C", "f", "s3", now - 45 * DAY_MS), // prior window
        ];
        let mut sa = HashMap::new();
        sa.insert("s1".to_string(), "web".to_string());
        sa.insert("s2".to_string(), "web".to_string());
        sa.insert("s3".to_string(), "api".to_string());
        let rows = compare_by_app(&events, &sa, now, "30d");
        let web = rows.iter().find(|r| r["app"] == "web").unwrap();
        assert_eq!(web["users"], 2);
        assert_eq!(web["events"], 2);
        let api = rows.iter().find(|r| r["app"] == "api").unwrap();
        assert_eq!(api["users"], 0);
        assert_eq!(api["prevUsers"], 1);
    }

    #[test]
    fn cohort_retention_indexes_by_weeks_since_signup() {
        let now = 1_000 * DAY_MS;
        let d = DAY_MS;
        let events = vec![
            ev("A", "f", "s1", now - 27 * d), // cohort week 0
            ev("A", "f", "s1", now - 6 * d),  // active again ~week 3
            ev("B", "f", "s2", now - 6 * d),  // cohort week 3
        ];
        let rows = cohort_retention(&events, now, 4);
        assert_eq!(rows.len(), 2);
        // oldest cohort (A): active at offset 0 and 3, not 1.
        assert_eq!(rows[0]["size"], 1);
        assert_eq!(rows[0]["cells"][0], 100.0);
        assert_eq!(rows[0]["cells"][1], 0.0);
        assert_eq!(rows[0]["cells"][3], 100.0);
        // newest cohort (B): one real cell, rest null (triangular).
        assert_eq!(rows[1]["cells"][0], 100.0);
        assert!(rows[1]["cells"][1].is_null());
    }
}

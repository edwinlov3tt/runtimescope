//! ROI engine (ADR-0012 slice 3a, the SQL/Rust path) — value & hours saved over
//! the `custom` event stream, joining each event to its feature **baseline**
//! (manual/tool minutes) and the acting user's **role rate**:
//!
//! ```text
//! time_saved(event) = (manual_min − tool_min) × (per_item ? count : 1)   [minutes]
//! hours(event)      = time_saved / 60
//! value(event)      = hours × role.hourly_rate                            [$]
//! ```
//!
//! This is the **batteries-included default** and the **oracle** the Mosaic cube
//! is diff-tested against (ADR-0013, research 0006). Pure over `Vec<Value>` + the
//! three lookup maps so it's unit-testable and matches the spike's `oracle.py`.

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

/// A feature's baseline economics (from `analytics_baselines`).
#[derive(Clone, Copy)]
pub struct BaselineCalc {
    pub manual: f64,
    pub tool: f64,
    pub per_item: bool,
}

/// The join context: feature→baseline, anonId→role, role→rate.
pub struct RoiCtx {
    pub baselines: HashMap<String, BaselineCalc>,
    pub anon_role: HashMap<String, String>,
    pub role_rate: HashMap<String, f64>,
}

fn str_of<'a>(e: &'a Value, k: &str) -> Option<&'a str> {
    e.get(k).and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// `count` for a per-item event: `properties.count` → `properties.items` → 1.
fn qty_of(e: &Value) -> f64 {
    let props = e.get("properties");
    let n = props
        .and_then(|p| p.get("count"))
        .or_else(|| props.and_then(|p| p.get("items")))
        .or_else(|| e.get("count"))
        .and_then(Value::as_f64);
    n.filter(|v| *v > 0.0).unwrap_or(1.0)
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

impl RoiCtx {
    /// (role, value$, hours, time_saved_min) for one event, or None if it has no
    /// feature baseline (⇒ contributes no ROI).
    fn event(&self, e: &Value) -> Option<(String, f64, f64)> {
        let feature = str_of(e, "name")?;
        let b = self.baselines.get(feature)?;
        let qty = if b.per_item { qty_of(e) } else { 1.0 };
        let saved_min = (b.manual - b.tool).max(0.0) * qty;
        let hours = saved_min / 60.0;
        let role = str_of(e, "anonId")
            .and_then(|a| self.anon_role.get(a))
            .cloned()
            .unwrap_or_else(|| "unknown".to_string());
        let rate = self.role_rate.get(&role).copied().unwrap_or(0.0);
        Some((role, hours * rate, hours))
    }

    /// Total value + hours over the events.
    pub fn totals(&self, events: &[Value]) -> Value {
        let (mut value, mut hours) = (0.0, 0.0);
        for e in events {
            if let Some((_, v, h)) = self.event(e) {
                value += v;
                hours += h;
            }
        }
        json!({ "value": round2(value), "hours": round2(hours) })
    }

    /// Per-role: distinct users, value, hours. Sorted by value desc.
    pub fn by_role(&self, events: &[Value]) -> Vec<Value> {
        struct Agg {
            users: HashSet<String>,
            value: f64,
            hours: f64,
        }
        let mut m: HashMap<String, Agg> = HashMap::new();
        for e in events {
            if let Some((role, v, h)) = self.event(e) {
                let a = m.entry(role).or_insert(Agg { users: HashSet::new(), value: 0.0, hours: 0.0 });
                a.value += v;
                a.hours += h;
                if let Some(u) = str_of(e, "anonId") {
                    a.users.insert(u.to_string());
                }
            }
        }
        let mut out: Vec<Value> = m
            .into_iter()
            .map(|(role, a)| json!({ "role": role, "users": a.users.len(), "value": round2(a.value), "hours": round2(a.hours) }))
            .collect();
        out.sort_by(|x, y| y["value"].as_f64().unwrap_or(0.0).total_cmp(&x["value"].as_f64().unwrap_or(0.0)));
        out
    }

    /// feature → (value, hours).
    pub fn by_feature(&self, events: &[Value]) -> HashMap<String, (f64, f64)> {
        let mut m: HashMap<String, (f64, f64)> = HashMap::new();
        for e in events {
            if let (Some(f), Some((_, v, h))) = (str_of(e, "name"), self.event(e)) {
                let a = m.entry(f.to_string()).or_insert((0.0, 0.0));
                a.0 += v;
                a.1 += h;
            }
        }
        m
    }

    /// value$ grouped by an arbitrary key (`key_of(e)` → group, None ⇒ skip).
    /// Takes the key fn by reference so callers can reuse it across windows
    /// (current vs prior) — used by Compare for value/prevValue per role or app.
    pub fn value_by(&self, events: &[Value], key_of: &dyn Fn(&Value) -> Option<String>) -> HashMap<String, f64> {
        let mut m: HashMap<String, f64> = HashMap::new();
        for e in events {
            if let (Some(k), Some((_, v, _))) = (key_of(e), self.event(e)) {
                *m.entry(k).or_insert(0.0) += v;
            }
        }
        m
    }

    /// anonId → (value, hours).
    pub fn by_user(&self, events: &[Value]) -> HashMap<String, (f64, f64)> {
        let mut m: HashMap<String, (f64, f64)> = HashMap::new();
        for e in events {
            if let (Some(a), Some((_, v, h))) = (str_of(e, "anonId"), self.event(e)) {
                let agg = m.entry(a.to_string()).or_insert((0.0, 0.0));
                agg.0 += v;
                agg.1 += h;
            }
        }
        m
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(anon: &str, name: &str, count: f64) -> Value {
        json!({ "eventType": "custom", "anonId": anon, "name": name, "timestamp": 1, "properties": { "count": count } })
    }

    fn ctx() -> RoiCtx {
        // geocode: manual 8 / tool 2.4, per_item. export: manual 15 / tool 5, per-use.
        let mut baselines = HashMap::new();
        baselines.insert("geocode".to_string(), BaselineCalc { manual: 8.0, tool: 2.4, per_item: true });
        baselines.insert("export".to_string(), BaselineCalc { manual: 15.0, tool: 5.0, per_item: false });
        let mut anon_role = HashMap::new();
        anon_role.insert("A".to_string(), "Specialist".to_string()); // $50
        anon_role.insert("C".to_string(), "Director".to_string()); // $85
        let mut role_rate = HashMap::new();
        role_rate.insert("Specialist".to_string(), 50.0);
        role_rate.insert("Director".to_string(), 85.0);
        RoiCtx { baselines, anon_role, role_rate }
    }

    #[test]
    fn roi_matches_the_formula_oracle() {
        let c = ctx();
        // A/geocode/count=10: saved=(8−2.4)×10=56min=0.9333h × $50 = $46.67
        let e = ev("A", "geocode", 10.0);
        let v = c.totals(std::slice::from_ref(&e));
        assert_eq!(v["hours"], round2(56.0 / 60.0));
        assert_eq!(v["value"], 46.67);

        // export is per-use (count ignored): saved=(15−5)=10min=0.1667h × $50 = $8.33
        let e2 = ev("A", "export", 99.0);
        assert_eq!(c.totals(std::slice::from_ref(&e2))["value"], 8.33);

        // unknown feature (no baseline) → no ROI; unknown role → rate 0.
        assert_eq!(c.totals(&[ev("A", "mystery", 5.0)])["value"], 0.0);
        assert_eq!(c.totals(&[ev("Z", "geocode", 10.0)])["value"], 0.0); // Z has no role
    }

    #[test]
    fn roi_groups_by_role_feature_user() {
        let c = ctx();
        let events = vec![
            ev("A", "geocode", 10.0), // $46.67, Specialist
            ev("C", "geocode", 10.0), // (8−2.4)×10/60×85 = $79.33, Director
            ev("A", "export", 1.0),   // $8.33, Specialist
        ];
        let roles = c.by_role(&events);
        let spec = roles.iter().find(|r| r["role"] == "Specialist").unwrap();
        assert_eq!(spec["value"], 46.67 + 8.33);
        assert_eq!(spec["users"], 1);
        let dir = roles.iter().find(|r| r["role"] == "Director").unwrap();
        assert_eq!(dir["value"], 79.33);
        // Director leads → sorted first
        assert_eq!(roles[0]["role"], "Director");

        let feat = c.by_feature(&events);
        assert_eq!(round2(feat["geocode"].0), 46.67 + 79.33);
        let user = c.by_user(&events);
        assert_eq!(round2(user["A"].0), 46.67 + 8.33);
    }
}

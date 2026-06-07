//! Mosaic sidecar client (ADR-0013, slice 3b) — **optional**, runtime-gated by
//! `RUNTIMESCOPE_MOSAIC_URL`. When set, the collector syncs ROI facts to an
//! `mc-daemon` cube and proxies forecast/trace (and later narrative). Absent ⇒
//! the SQL ROI path (slice 3a) is authoritative and those endpoints report
//! `MOSAIC_NOT_CONFIGURED`.
//!
//! Speaks the daemon's `/api/v1` contract (research 0006 §6): bearer-gated
//! `query` / `write` / `trace` / `health`. The daemon runs on **loopback** (the
//! sidecar), so this is http-only (no TLS).
//!
//! ⚠ The fact `coord` order ([user, feature, role, app, time] + measure) matches
//! the spike's cube (`docs/research/0006-mosaic-spike/roi.yaml`). Verify against
//! the deployed cube's dimension order on a real deploy (`TODO(analytics-3b-cube)`).

use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;

/// One cube input cell to write: `coord` is the element per dimension (in the
/// cube's dimension order), `measure` the input measure, `value` its number.
#[derive(Clone, Debug, PartialEq)]
pub struct Cell {
    pub coord: Vec<String>,
    pub measure: String,
    pub value: f64,
}

pub struct MosaicConfig {
    pub url: String,
    pub key: Option<String>,
    pub cube: String,
}

impl MosaicConfig {
    /// Build from env, or None if `RUNTIMESCOPE_MOSAIC_URL` is unset/empty.
    pub fn from_env() -> Option<Self> {
        let url = env::var("RUNTIMESCOPE_MOSAIC_URL").ok().filter(|u| !u.trim().is_empty())?;
        Some(MosaicConfig {
            url: url.trim().trim_end_matches('/').to_string(),
            key: env::var("RUNTIMESCOPE_MOSAIC_KEY").ok().filter(|k| !k.is_empty()),
            cube: env::var("RUNTIMESCOPE_MOSAIC_CUBE").ok().filter(|c| !c.is_empty()).unwrap_or_else(|| "roi".to_string()),
        })
    }
}

#[derive(Clone)]
pub struct MosaicClient {
    http: reqwest::Client,
    base: String,
    key: Option<String>,
    cube: String,
}

impl MosaicClient {
    pub fn new(cfg: MosaicConfig) -> Self {
        MosaicClient { http: reqwest::Client::new(), base: cfg.url, key: cfg.key, cube: cfg.cube }
    }

    pub fn cube(&self) -> &str {
        &self.cube
    }

    fn auth(&self, rb: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        match &self.key {
            Some(k) => rb.bearer_auth(k),
            None => rb,
        }
    }

    async fn post(&self, path: &str, body: Value) -> Result<Value, String> {
        let resp = self
            .auth(self.http.post(format!("{}{}", self.base, path)).json(&body))
            .send()
            .await
            .map_err(|e| format!("mosaic {path}: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("mosaic {path}: HTTP {}", resp.status()));
        }
        resp.json::<Value>().await.map_err(|e| format!("mosaic {path} decode: {e}"))
    }

    /// GET /api/v1/health — is the daemon reachable?
    pub async fn health(&self) -> bool {
        self.auth(self.http.get(format!("{}/api/v1/health", self.base)))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }

    /// Query computed cells: `{cube, where, show}` → daemon response.
    pub async fn query(&self, where_: Value, show: &[&str]) -> Result<Value, String> {
        self.post("/api/v1/query", json!({ "cube": self.cube, "where": where_, "show": show })).await
    }

    /// Trace a cell's dependency chain.
    pub async fn trace(&self, coord: Value) -> Result<Value, String> {
        self.post("/api/v1/trace", json!({ "cube": self.cube, "coord": coord })).await
    }

    /// Sync input cells to the cube. The daemon's `/write` is per-cell (no batch
    /// endpoint yet — research 0006 follow-up), so this loops; on loopback each
    /// call is ~0.3ms. Stops + returns the error on the first failed write.
    pub async fn write_cells(&self, cells: &[Cell]) -> Result<usize, String> {
        for c in cells {
            self.post("/api/v1/write", json!({ "cube": self.cube, "coord": c.coord, "measure": c.measure, "value": c.value }))
                .await?;
        }
        Ok(cells.len())
    }
}

fn s<'a>(e: &'a Value, k: &str) -> Option<&'a str> {
    e.get(k).and_then(Value::as_str).filter(|v| !v.is_empty())
}
fn day_bucket(ts: i64) -> String {
    use chrono::{TimeZone, Utc};
    Utc.timestamp_millis_opt(ts).single().map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_default()
}

/// Build the ROI input cells from the event stream for the Mosaic cube — one
/// leaf per (user, feature, role, app, day) with the input measures the cube's
/// rules read (`events`, `items`, plus the denormalized baseline/rate). Pure +
/// testable; the actual push is `MosaicClient::write_cells`.
pub fn build_facts(
    events: &[Value],
    baselines: &HashMap<String, (f64, f64, bool)>, // feature -> (manual, tool, per_item)
    anon_role: &HashMap<String, String>,
    role_rate: &HashMap<String, f64>,
    session_app: &HashMap<String, String>,
) -> Vec<Cell> {
    // Aggregate raw inputs per leaf coordinate.
    struct Leaf {
        events: f64,
        items: f64,
    }
    let mut leaves: HashMap<Vec<String>, Leaf> = HashMap::new();
    for e in events {
        let Some(feature) = s(e, "name") else { continue };
        let user = s(e, "anonId").unwrap_or("unknown").to_string();
        let role = anon_role.get(&user).cloned().unwrap_or_else(|| "unknown".to_string());
        let app = s(e, "sessionId").and_then(|sid| session_app.get(sid)).cloned().unwrap_or_else(|| "unknown".to_string());
        let day = day_bucket(e.get("timestamp").and_then(Value::as_i64).unwrap_or(0));
        let count = e
            .get("properties")
            .and_then(|p| p.get("count").or_else(|| p.get("items")))
            .and_then(Value::as_f64)
            .filter(|v| *v > 0.0)
            .unwrap_or(1.0);
        let coord = vec![user, feature.to_string(), role, app, day];
        let leaf = leaves.entry(coord).or_insert(Leaf { events: 0.0, items: 0.0 });
        leaf.events += 1.0;
        leaf.items += count;
    }
    let mut cells = Vec::new();
    for (coord, leaf) in leaves {
        let feature = &coord[1];
        let role = &coord[2];
        cells.push(Cell { coord: coord.clone(), measure: "events".into(), value: leaf.events });
        cells.push(Cell { coord: coord.clone(), measure: "items".into(), value: leaf.items });
        // Denormalize baseline + rate onto the leaf (the cube reads them there).
        if let Some(&(manual, tool, per_item)) = baselines.get(feature) {
            cells.push(Cell { coord: coord.clone(), measure: "manual_min".into(), value: manual });
            cells.push(Cell { coord: coord.clone(), measure: "tool_min".into(), value: tool });
            cells.push(Cell { coord: coord.clone(), measure: "per_item".into(), value: if per_item { 1.0 } else { 0.0 } });
        }
        let rate = role_rate.get(role).copied().unwrap_or(0.0);
        cells.push(Cell { coord, measure: "hourly_rate".into(), value: rate });
    }
    cells
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::post, Json, Router};

    fn ev(anon: &str, name: &str, sid: &str, ts: i64, count: f64) -> Value {
        json!({ "eventType": "custom", "anonId": anon, "name": name, "sessionId": sid, "timestamp": ts, "properties": { "count": count } })
    }

    #[test]
    fn build_facts_emits_leaf_inputs_with_denormalized_baseline_and_rate() {
        let events = vec![ev("A", "geocode", "s1", 1_700_000_000_000, 10.0), ev("A", "geocode", "s1", 1_700_000_000_000, 5.0)];
        let mut baselines = HashMap::new();
        baselines.insert("geocode".to_string(), (8.0, 2.4, true));
        let mut anon_role = HashMap::new();
        anon_role.insert("A".to_string(), "Specialist".to_string());
        let mut role_rate = HashMap::new();
        role_rate.insert("Specialist".to_string(), 50.0);
        let mut session_app = HashMap::new();
        session_app.insert("s1".to_string(), "web".to_string());

        let cells = build_facts(&events, &baselines, &anon_role, &role_rate, &session_app);
        let by_measure = |m: &str| cells.iter().find(|c| c.measure == m).cloned();
        // both events fall in one leaf (same user/feature/app/day).
        assert_eq!(by_measure("events").unwrap().value, 2.0);
        assert_eq!(by_measure("items").unwrap().value, 15.0); // 10 + 5
        assert_eq!(by_measure("manual_min").unwrap().value, 8.0);
        assert_eq!(by_measure("hourly_rate").unwrap().value, 50.0);
        // coord = [user, feature, role, app, day]
        let c = by_measure("events").unwrap();
        assert_eq!(&c.coord[..4], &["A".to_string(), "geocode".to_string(), "Specialist".to_string(), "web".to_string()]);
    }

    // Mock daemon: a tiny axum server speaking the /api/v1 contract, so the
    // client's request shaping + auth + roundtrip are verified without Mosaic.
    #[tokio::test]
    async fn client_roundtrips_query_trace_write_against_a_mock_daemon() {
        let app = Router::new()
            .route("/api/v1/query", post(|Json(b): Json<Value>| async move {
                // echo the where + a canned computed cell
                Json(json!({ "cube": b["cube"], "results": [{ "values": { "value": 185.83, "hours": 3.6 } }], "where": b["where"] }))
            }))
            .route("/api/v1/trace", post(|Json(b): Json<Value>| async move {
                Json(json!({ "cube": b["cube"], "node": { "measure": "value", "value": 46.67 } }))
            }))
            .route("/api/v1/write", post(|Json(_b): Json<Value>| async move {
                Json(json!({ "ok": true, "dirty_count": 1 }))
            }));
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let client = MosaicClient::new(MosaicConfig { url: format!("http://{addr}"), key: Some("k".into()), cube: "roi".into() });

        let q = client.query(json!({ "Role": "Specialist" }), &["value", "hours"]).await.unwrap();
        assert_eq!(q["results"][0]["values"]["value"], 185.83);
        assert_eq!(q["cube"], "roi");

        let t = client.trace(json!(["S", "V", "A", "geocode", "Specialist", "web", "2026_01", "value"])).await.unwrap();
        assert_eq!(t["node"]["value"], 46.67);

        let n = client
            .write_cells(&[Cell { coord: vec!["A".into(), "geocode".into()], measure: "events".into(), value: 2.0 }])
            .await
            .unwrap();
        assert_eq!(n, 1);
    }
}

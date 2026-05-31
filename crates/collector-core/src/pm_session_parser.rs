//! pm/ session-transcript parser (M5, ADR-0009).
//!
//! A faithful port of `packages/collector/src/pm/session-parser.ts` — extracts
//! cost / token / active-time / compaction metadata from a Claude Code session
//! JSONL transcript. Node had NO tests here; the behavior below was captured by
//! running the real Node parser over edge-case fixtures (a characterization
//! workflow), and the `tests` module asserts those exact Node-captured outputs.
//!
//! Quirks replicated verbatim (each has a regression test):
//!  - fuzzy pricing match: direct → strip `-DDDDDDDD` date suffix → longest
//!    forward-prefix → reverse-prefix; **`MODEL_PRICING` order breaks ties**, and
//!    an EMPTY model string resolves to sonnet (not unknown→0).
//!  - JS `Math.round` is half-toward-+∞ → `(x + 0.5).floor()`.
//!  - active time: strict `gap < idle` (== threshold excluded), sorted, `/60000`.
//!  - `toolUseResult` suppresses a user message only when TRUTHY (false/0/""/null
//!    count as real).
//!  - `firstHumanSeen` latches on the first real user message BEFORE text is
//!    extracted, so an empty/text-less first prompt leaves `firstPrompt` unset.
//!  - `msg.usage ?? obj.usage` / `msg.model ?? obj.model` precedence; model is
//!    the LAST seen; numeric token fields only (a string token → 0).
//!  - direct `costUSD ?? cost_usd` on any line adds `round(dollars * 1e6)`.

use serde_json::Value;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

/// JS `Math.round`: half toward +∞ (NOT banker's rounding, NOT half-away-from-zero).
fn js_round(x: f64) -> i64 {
    (x + 0.5).floor() as i64
}

#[derive(Clone, Copy, Debug)]
pub struct Pricing {
    pub input: f64,
    pub output: f64,
    pub cache_write: f64,
    pub cache_read: f64,
}

/// Model pricing in microdollars per million tokens. **Order matters** — the
/// fuzzy lookup breaks ties by first-of-max-length in this exact order.
pub const MODEL_PRICING: &[(&str, Pricing)] = &[
    ("claude-opus-4-6", Pricing { input: 15_000_000.0, output: 75_000_000.0, cache_write: 18_750_000.0, cache_read: 1_500_000.0 }),
    ("claude-sonnet-4-6", Pricing { input: 3_000_000.0, output: 15_000_000.0, cache_write: 3_750_000.0, cache_read: 300_000.0 }),
    ("claude-sonnet-4-5", Pricing { input: 3_000_000.0, output: 15_000_000.0, cache_write: 3_750_000.0, cache_read: 300_000.0 }),
    ("claude-haiku-4-5", Pricing { input: 800_000.0, output: 4_000_000.0, cache_write: 1_000_000.0, cache_read: 80_000.0 }),
    ("claude-haiku-3-5", Pricing { input: 800_000.0, output: 4_000_000.0, cache_write: 1_000_000.0, cache_read: 80_000.0 }),
];

/// Strip a trailing `-DDDDDDDD` (exactly 8 digits) date suffix, else return as-is.
fn strip_date_suffix(m: &str) -> &str {
    if m.len() >= 9 {
        let (head, tail) = m.split_at(m.len() - 9);
        if tail.starts_with('-') && tail[1..].bytes().all(|b| b.is_ascii_digit()) {
            return head;
        }
    }
    m
}

/// Fuzzy-match a model string to a pricing entry (ports `lookupPricing`).
pub fn lookup_pricing(model: &str) -> Option<Pricing> {
    if let Some((_, p)) = MODEL_PRICING.iter().find(|(k, _)| *k == model) {
        return Some(*p);
    }
    let stripped = strip_date_suffix(model);
    if let Some((_, p)) = MODEL_PRICING.iter().find(|(k, _)| *k == stripped) {
        return Some(*p);
    }
    // Longest forward-prefix: stripped starts with key.
    let mut best: Option<Pricing> = None;
    let mut best_len = 0usize;
    for (k, p) in MODEL_PRICING {
        if stripped.starts_with(k) && k.len() > best_len {
            best = Some(*p);
            best_len = k.len();
        }
    }
    if best.is_some() {
        return best;
    }
    // Reverse: key starts with stripped (so a bare/empty model picks the longest key).
    best_len = 0;
    for (k, p) in MODEL_PRICING {
        if k.starts_with(stripped) && k.len() > best_len {
            best = Some(*p);
            best_len = k.len();
        }
    }
    best
}

/// Cost in microdollars (ports `calculateCostMicrodollars`). Unknown model → 0.
pub fn calculate_cost_microdollars(model: &str, input: i64, output: i64, cache_creation: i64, cache_read: i64) -> i64 {
    let Some(p) = lookup_pricing(model) else { return 0 };
    let total = input as f64 * p.input
        + output as f64 * p.output
        + cache_creation as f64 * p.cache_write
        + cache_read as f64 * p.cache_read;
    js_round(total / 1_000_000.0)
}

/// Active minutes: sum of consecutive gaps under `idle_threshold_ms`, `/60000`
/// (ports `calculateActiveMinutes`). <2 timestamps → 0; strict `<` boundary.
pub fn calculate_active_minutes(timestamps: &[i64], idle_threshold_ms: i64) -> f64 {
    if timestamps.len() < 2 {
        return 0.0;
    }
    let mut sorted = timestamps.to_vec();
    sorted.sort_unstable();
    let mut active_ms = 0i64;
    for w in sorted.windows(2) {
        let gap = w[1] - w[0];
        if gap < idle_threshold_ms {
            active_ms += gap;
        }
    }
    active_ms as f64 / 60_000.0
}

pub const DEFAULT_IDLE_MS: i64 = 900_000;

/// JS truthiness for the `toolUseResult` / `costUSD` guards.
fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// JS `Date.parse`-style: epoch-ms number passthrough, ISO/RFC3339 string → ms,
/// else 0.
fn parse_timestamp(v: Option<&Value>) -> i64 {
    match v {
        Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)).unwrap_or(0),
        Some(Value::String(s)) => chrono::DateTime::parse_from_rfc3339(s)
            .map(|dt| dt.timestamp_millis())
            .unwrap_or(0),
        _ => 0,
    }
}

/// First `{type:"text"}` block's text, or a plain-string content, else "".
fn extract_text_content(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => {
            for b in blocks {
                if b.get("type").and_then(Value::as_str) == Some("text") {
                    if let Some(t) = b.get("text").and_then(Value::as_str) {
                        return t.to_string();
                    }
                }
            }
            String::new()
        }
        _ => String::new(),
    }
}

/// JS `parseInt(s, 10)`: optional sign + leading digits; `None` if no digits (NaN).
fn parse_int_prefix(s: &str) -> Option<i64> {
    let s = s.trim_start();
    let bytes = s.as_bytes();
    let mut end = 0;
    if bytes.first() == Some(&b'-') || bytes.first() == Some(&b'+') {
        end = 1;
    }
    let digits_start = end;
    while end < bytes.len() && bytes[end].is_ascii_digit() {
        end += 1;
    }
    if end == digits_start {
        return None;
    }
    s[..end].parse::<i64>().ok()
}

/// The deterministic session metrics this parser extracts. (createdAt/updatedAt
/// are wall-clock and computed by the caller path; not part of the contract here.)
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ParsedSession {
    pub message_count: i64,
    pub user_message_count: i64,
    pub assistant_message_count: i64,
    pub total_input_tokens: i64,
    pub total_output_tokens: i64,
    pub total_cache_creation_tokens: i64,
    pub total_cache_read_tokens: i64,
    pub cost_microdollars: i64,
    pub active_minutes: f64,
    pub compaction_count: i64,
    pub model: Option<String>,
    pub first_prompt: Option<String>,
    pub version: Option<String>,
    pub slug: Option<String>,
    pub git_branch: Option<String>,
    pub permission_mode: Option<String>,
    pub summary: Option<String>,
    pub pre_compaction_tokens: Option<i64>,
    pub started_at: Option<i64>,
    pub ended_at: Option<i64>,
    pub message_timestamps: Vec<i64>,
}

/// Stream-parse a Claude Code session JSONL file (ports `parseSessionJsonl`).
/// Malformed/empty/non-object lines are skipped. Returns the deterministic
/// metrics; a missing/unreadable file yields an all-zero session.
pub fn parse_session_jsonl(path: &Path) -> ParsedSession {
    let mut s = ParsedSession::default();
    let mut first_human_seen = false;
    let mut earliest = i64::MAX;
    let mut latest = 0i64;

    let Ok(file) = File::open(path) else { return s };
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(obj) = serde_json::from_str::<Value>(&line) else { continue };
        if !obj.is_object() {
            continue;
        }
        let ty = obj.get("type").and_then(Value::as_str);
        let ts = parse_timestamp(obj.get("timestamp"));
        if ts > 0 {
            s.message_timestamps.push(ts);
            earliest = earliest.min(ts);
            latest = latest.max(ts);
        }

        // First-seen session metadata (string-typed only).
        let set_once = |slot: &mut Option<String>, v: Option<&Value>| {
            if slot.is_none() {
                if let Some(Value::String(x)) = v {
                    *slot = Some(x.clone());
                }
            }
        };
        set_once(&mut s.version, obj.get("version"));
        set_once(&mut s.slug, obj.get("slug"));
        set_once(&mut s.git_branch, obj.get("gitBranch"));
        set_once(&mut s.permission_mode, obj.get("permissionMode"));

        match ty {
            Some("user") => {
                s.message_count += 1;
                // toolUseResult suppresses only when TRUTHY.
                let is_real = obj.get("toolUseResult").is_none_or(|v| !js_truthy(v));
                if is_real {
                    s.user_message_count += 1;
                    if !first_human_seen {
                        first_human_seen = true; // latches before text extraction
                        if let Some(msg) = obj.get("message") {
                            let text = extract_text_content(msg.get("content"));
                            if !text.is_empty() {
                                s.first_prompt = Some(text.chars().take(500).collect());
                            }
                        }
                    }
                }
            }
            Some("assistant") => {
                s.message_count += 1;
                s.assistant_message_count += 1;
                let msg = obj.get("message");
                // model: msg.model ?? obj.model (nested wins; null falls back). LAST seen.
                let model = nested_or_top(msg, &obj, "model")
                    .and_then(|v| v.as_str().map(String::from));
                if let Some(m) = &model {
                    s.model = Some(m.clone());
                }
                // usage: msg.usage ?? obj.usage.
                if let Some(usage) = nested_or_top(msg, &obj, "usage").filter(|v| v.is_object()) {
                    let num = |k: &str| usage.get(k).and_then(Value::as_i64).unwrap_or(0);
                    let input = num("input_tokens");
                    let output = num("output_tokens");
                    let cache_creation = num("cache_creation_input_tokens");
                    let cache_read = num("cache_read_input_tokens");
                    s.total_input_tokens += input;
                    s.total_output_tokens += output;
                    s.total_cache_creation_tokens += cache_creation;
                    s.total_cache_read_tokens += cache_read;
                    if let Some(m) = &model {
                        s.cost_microdollars += calculate_cost_microdollars(m, input, output, cache_creation, cache_read);
                    }
                }
            }
            Some("summary") => {
                s.compaction_count += 1;
                if s.summary.is_none() {
                    if let Some(Value::String(x)) = obj.get("summary") {
                        s.summary = Some(x.clone());
                    }
                }
            }
            Some("system") => {
                s.message_count += 1;
                if obj.get("subtype").and_then(Value::as_str) == Some("compact_boundary") {
                    s.compaction_count += 1;
                    if let Some(meta) = obj.get("compactMetadata") {
                        let pre = match meta.get("preTokens") {
                            Some(Value::String(x)) => parse_int_prefix(x),
                            Some(Value::Number(n)) => n.as_i64(),
                            _ => None,
                        };
                        // Guard `preTokens && !isNaN`: reject 0 and NaN.
                        if let Some(n) = pre {
                            if n != 0 {
                                s.pre_compaction_tokens = Some(n);
                            }
                        }
                    }
                } else {
                    let content = obj.get("content").and_then(Value::as_str).unwrap_or("");
                    if content.to_lowercase().contains("compact") {
                        s.compaction_count += 1;
                    }
                }
            }
            _ => {} // unknown / missing type → not counted (no else branch)
        }

        // Direct cost fields on ANY line: costUSD ?? cost_usd (dollars → microdollars).
        let direct = obj.get("costUSD").or_else(|| obj.get("cost_usd"));
        if let Some(Value::Number(n)) = direct {
            if let Some(dollars) = n.as_f64() {
                s.cost_microdollars += js_round(dollars * 1_000_000.0);
            }
        }
    }

    if earliest < i64::MAX {
        s.started_at = Some(earliest);
    }
    if latest > 0 {
        s.ended_at = Some(latest);
    }
    s.active_minutes = calculate_active_minutes(&s.message_timestamps, DEFAULT_IDLE_MS);
    s
}

/// `nested?.[key] ?? top[key]` — nested (message) wins; JSON null falls back to top.
fn nested_or_top<'a>(nested: Option<&'a Value>, top: &'a Value, key: &str) -> Option<&'a Value> {
    let n = nested.and_then(|m| m.get(key)).filter(|v| !v.is_null());
    n.or_else(|| top.get(key).filter(|v| !v.is_null()))
}

// `now_ms` is used by the caller path (project-discovery, M5 next); referenced
// here to keep the import warning-free until then.
#[allow(dead_code)]
fn _touch_now() -> i64 {
    now_ms()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn parse(jsonl: &str) -> ParsedSession {
        let dir = std::env::temp_dir().join(format!("psp-{}-{}", std::process::id(), now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("fix-{}.jsonl", rand_suffix(jsonl)));
        let mut f = File::create(&path).unwrap();
        f.write_all(jsonl.as_bytes()).unwrap();
        drop(f);
        let r = parse_session_jsonl(&path);
        let _ = std::fs::remove_file(&path);
        r
    }
    // tiny content-derived suffix so concurrent test fixtures don't collide
    fn rand_suffix(s: &str) -> u64 {
        s.bytes().fold(1469598103934665603u64, |h, b| (h ^ b as u64).wrapping_mul(1099511628211))
    }

    // ---- pricing + cost (Node-captured) ----
    #[test]
    fn cost_exact_and_formula() {
        assert_eq!(calculate_cost_microdollars("claude-opus-4-6", 1_000_000, 1_000_000, 1_000_000, 1_000_000), 110_250_000);
        assert_eq!(calculate_cost_microdollars("claude-sonnet-4-6", 1_000_000, 1_000_000, 1_000_000, 1_000_000), 22_050_000);
        assert_eq!(calculate_cost_microdollars("claude-haiku-4-5", 1_000_000, 1_000_000, 1_000_000, 1_000_000), 5_880_000);
        assert_eq!(calculate_cost_microdollars("claude-opus-4-6", 1000, 500, 2000, 10000), 105_000);
        assert_eq!(calculate_cost_microdollars("claude-sonnet-4-6", 1234, 567, 8901, 23456), 52_623);
    }
    #[test]
    fn cost_fuzzy_match() {
        assert_eq!(calculate_cost_microdollars("claude-sonnet-4-5-20250514", 1000, 1000, 1000, 1000), 22_050); // date strip
        assert_eq!(calculate_cost_microdollars("claude-haiku-3-5-2025", 1000, 1000, 1000, 1000), 5_880); // 4 digits NOT stripped → fwd-prefix
        assert_eq!(calculate_cost_microdollars("claude-sonnet-4-6-foo", 1000, 1000, 1000, 1000), 22_050); // fwd longest-prefix
        assert_eq!(calculate_cost_microdollars("claude-opus-4-20250514", 1000, 0, 0, 0), 15_000); // strip → reverse-prefix
        assert_eq!(calculate_cost_microdollars("claude-sonnet", 1000, 1000, 1000, 1000), 22_050); // reverse-prefix, order tie → sonnet-4-6
        assert_eq!(calculate_cost_microdollars("claude-", 1000, 1000, 1000, 1000), 22_050); // longest key of order
        assert_eq!(calculate_cost_microdollars("", 1, 0, 0, 0), 3); // QUIRK: empty → sonnet, NOT 0
        assert_eq!(calculate_cost_microdollars("gpt-4", 1000, 1000, 1000, 1000), 0); // unknown → 0
        assert_eq!(calculate_cost_microdollars("claude-foo", 1000, 1000, 1000, 1000), 0);
    }
    #[test]
    fn cost_rounding_half_up() {
        assert_eq!(calculate_cost_microdollars("claude-opus-4-6", 0, 0, 0, 1), 2); // 1.5 → 2
        assert_eq!(calculate_cost_microdollars("claude-opus-4-6", 0, 0, 1, 0), 19); // 18.75 → 19
        assert_eq!(calculate_cost_microdollars("claude-opus-4-6", 0, 0, 2, 0), 38); // 37.5 → 38 (not banker's)
        assert_eq!(calculate_cost_microdollars("claude-haiku-3-5", 0, 0, 0, 1), 0); // 0.08 → 0
        assert_eq!(calculate_cost_microdollars("claude-haiku-4-5", 0, 0, 0, -1), 0); // -0.08 → 0
    }

    // ---- active minutes (Node-captured) ----
    #[test]
    fn active_minutes_cases() {
        assert_eq!(calculate_active_minutes(&[], DEFAULT_IDLE_MS), 0.0);
        assert_eq!(calculate_active_minutes(&[1000], DEFAULT_IDLE_MS), 0.0);
        assert_eq!(calculate_active_minutes(&[0, 60000], DEFAULT_IDLE_MS), 1.0);
        assert_eq!(calculate_active_minutes(&[0, 900000], DEFAULT_IDLE_MS), 0.0); // == threshold excluded
        assert_eq!(calculate_active_minutes(&[0, 900001], DEFAULT_IDLE_MS), 0.0);
        assert_eq!(calculate_active_minutes(&[0, 90000], DEFAULT_IDLE_MS), 1.5);
        assert_eq!(calculate_active_minutes(&[0, 60000, 1060000], DEFAULT_IDLE_MS), 1.0); // big gap dropped
        assert_eq!(calculate_active_minutes(&[300000, 0, 100000], DEFAULT_IDLE_MS), 5.0); // sorted internally
        assert_eq!(calculate_active_minutes(&[0, 30000, 90000, 150000], DEFAULT_IDLE_MS), 2.5);
        assert_eq!(calculate_active_minutes(&[0, 1000], 1000), 0.0); // custom threshold boundary
        assert!((calculate_active_minutes(&[0, 899999], DEFAULT_IDLE_MS) - 14.999983333333333).abs() < 1e-9);
    }

    // ---- message counting + types ----
    #[test]
    fn message_counting() {
        let r = parse(concat!(
            "{\"type\":\"summary\",\"summary\":\"A prior summary\"}\n",
            "{\"type\":\"user\",\"message\":{\"content\":\"Hello there\"},\"timestamp\":\"2026-01-01T00:00:00Z\"}\n",
            "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-opus-4-6\",\"content\":[{\"type\":\"text\",\"text\":\"Hi\"}],\"usage\":{\"input_tokens\":0,\"output_tokens\":0}}}\n",
            "{\"type\":\"system\",\"content\":\"note\"}"
        ));
        assert_eq!(r.message_count, 3);
        assert_eq!(r.user_message_count, 1);
        assert_eq!(r.assistant_message_count, 1);
        assert_eq!(r.compaction_count, 1);
        assert_eq!(r.summary.as_deref(), Some("A prior summary"));
        assert_eq!(r.first_prompt.as_deref(), Some("Hello there"));
        assert_eq!(r.model.as_deref(), Some("claude-opus-4-6"));
    }
    #[test]
    fn tool_use_result_truthy_suppresses() {
        // truthy object → suppressed; the second (real) is the firstPrompt
        let r = parse(concat!(
            "{\"type\":\"user\",\"toolUseResult\":{\"ok\":true},\"message\":{\"content\":\"tool output\"},\"timestamp\":\"2026-01-01T00:00:00Z\"}\n",
            "{\"type\":\"user\",\"message\":{\"content\":\"real prompt\"},\"timestamp\":\"2026-01-01T00:01:00Z\"}"
        ));
        assert_eq!(r.message_count, 2);
        assert_eq!(r.user_message_count, 1);
        assert_eq!(r.first_prompt.as_deref(), Some("real prompt"));
        // falsy toolUseResult values count as REAL
        let r2 = parse(concat!(
            "{\"type\":\"user\",\"toolUseResult\":false,\"message\":{\"content\":\"a\"},\"timestamp\":\"2026-01-01T00:00:00Z\"}\n",
            "{\"type\":\"user\",\"toolUseResult\":0,\"message\":{\"content\":\"b\"},\"timestamp\":\"2026-01-01T00:01:00Z\"}\n",
            "{\"type\":\"user\",\"toolUseResult\":\"\",\"message\":{\"content\":\"c\"},\"timestamp\":\"2026-01-01T00:02:00Z\"}\n",
            "{\"type\":\"user\",\"toolUseResult\":null,\"message\":{\"content\":\"d\"},\"timestamp\":\"2026-01-01T00:03:00Z\"}"
        ));
        assert_eq!(r2.user_message_count, 4);
        assert_eq!(r2.first_prompt.as_deref(), Some("a"));
    }
    #[test]
    fn unknown_and_malformed_skipped() {
        let r = parse(concat!(
            "\n   \n{not valid json\n",
            "{\"type\":\"user\",\"message\":{\"content\":\"valid\"},\"timestamp\":\"2026-01-01T00:00:00Z\"}\n",
            "null\n42\n\"a string\"\n[]\n",
            "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-haiku-4-5\",\"usage\":{\"input_tokens\":2,\"output_tokens\":3}}}"
        ));
        assert_eq!(r.message_count, 2);
        assert_eq!(r.user_message_count, 1);
        assert_eq!(r.assistant_message_count, 1);
        assert_eq!(r.first_prompt.as_deref(), Some("valid"));
        // unknown/missing type not counted
        let r2 = parse(concat!(
            "{\"type\":\"tool_result\",\"timestamp\":\"2026-01-01T00:00:00Z\"}\n",
            "{\"type\":\"foobar\"}\n",
            "{\"message\":{\"content\":\"no type\"}}\n",
            "{\"type\":\"assistant\",\"message\":{\"model\":\"claude-sonnet-4-5\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}"
        ));
        assert_eq!(r2.message_count, 1);
        assert_eq!(r2.assistant_message_count, 1);
    }

    // ---- token aggregation + model precedence ----
    #[test]
    fn token_aggregation() {
        // nested usage/model
        let r = parse("{\"type\":\"assistant\",\"timestamp\":\"2025-01-01T00:00:00.000Z\",\"message\":{\"model\":\"claude-sonnet-4-5\",\"usage\":{\"input_tokens\":100,\"output_tokens\":50,\"cache_creation_input_tokens\":200,\"cache_read_input_tokens\":1000}}}");
        assert_eq!(r.total_input_tokens, 100);
        assert_eq!(r.total_cache_read_tokens, 1000);
        assert_eq!(r.cost_microdollars, 2100);
        assert_eq!(r.model.as_deref(), Some("claude-sonnet-4-5"));
        // top-level usage/model fallback
        let r2 = parse("{\"type\":\"assistant\",\"timestamp\":\"2025-01-01T00:00:00.000Z\",\"model\":\"claude-opus-4-6\",\"usage\":{\"input_tokens\":10,\"output_tokens\":20,\"cache_creation_input_tokens\":30,\"cache_read_input_tokens\":40}}");
        assert_eq!(r2.cost_microdollars, 2273);
        assert_eq!(r2.model.as_deref(), Some("claude-opus-4-6"));
        // msg precedence over top + model LAST seen
        let r3 = parse(concat!(
            "{\"type\":\"assistant\",\"timestamp\":\"2025-01-01T00:00:00.000Z\",\"model\":\"claude-opus-4-6\",\"usage\":{\"input_tokens\":999,\"output_tokens\":999},\"message\":{\"model\":\"claude-sonnet-4-5\",\"usage\":{\"input_tokens\":100,\"output_tokens\":50}}}"
        ));
        assert_eq!(r3.total_input_tokens, 100);
        assert_eq!(r3.cost_microdollars, 1050);
        assert_eq!(r3.model.as_deref(), Some("claude-sonnet-4-5"));
        // string token → 0
        let r4 = parse("{\"type\":\"assistant\",\"timestamp\":\"2025-01-01T00:00:00.000Z\",\"message\":{\"model\":\"claude-sonnet-4-5\",\"usage\":{\"input_tokens\":\"100\",\"output_tokens\":50}}}");
        assert_eq!(r4.total_input_tokens, 0);
        assert_eq!(r4.total_output_tokens, 50);
        assert_eq!(r4.cost_microdollars, 750);
    }
    #[test]
    fn direct_cost_fields() {
        let r = parse("{\"type\":\"user\",\"timestamp\":\"2025-01-01T00:00:00.000Z\",\"costUSD\":0.0123456,\"message\":{\"content\":\"hi\"}}");
        assert_eq!(r.cost_microdollars, 12346); // round(12345.6)
        let r2 = parse("{\"type\":\"system\",\"timestamp\":\"2025-01-01T00:00:00.000Z\",\"cost_usd\":1.5}");
        assert_eq!(r2.cost_microdollars, 1_500_000);
        // both present → costUSD wins
        let r3 = parse("{\"type\":\"system\",\"timestamp\":\"2025-01-01T00:00:00.000Z\",\"costUSD\":0.002,\"cost_usd\":5.0}");
        assert_eq!(r3.cost_microdollars, 2000);
        // costUSD + tokens both add
        let r4 = parse("{\"type\":\"assistant\",\"timestamp\":\"2025-01-01T00:00:00.000Z\",\"costUSD\":0.001,\"message\":{\"model\":\"claude-sonnet-4-5\",\"usage\":{\"input_tokens\":1000,\"output_tokens\":0}}}");
        assert_eq!(r4.cost_microdollars, 4000); // 1000 (costUSD) + 3000 (tokens)
    }

    // ---- compaction detection ----
    #[test]
    fn compaction_detection() {
        // string preTokens with trailing junk → parseInt prefix
        let r = parse("{\"type\":\"system\",\"subtype\":\"compact_boundary\",\"compactMetadata\":{\"preTokens\":\"45000abc\"}}");
        assert_eq!(r.compaction_count, 1);
        assert_eq!(r.pre_compaction_tokens, Some(45000));
        // preTokens 0 → guard rejects
        let r2 = parse("{\"type\":\"system\",\"subtype\":\"compact_boundary\",\"compactMetadata\":{\"preTokens\":0}}");
        assert_eq!(r2.pre_compaction_tokens, None);
        // "notanumber" → NaN → rejected
        let r3 = parse("{\"type\":\"system\",\"subtype\":\"compact_boundary\",\"compactMetadata\":{\"preTokens\":\"notanumber\"}}");
        assert_eq!(r3.pre_compaction_tokens, None);
        // content keyword (case-insensitive) on a non-boundary system line
        let r4 = parse("{\"type\":\"system\",\"content\":\"COMPACT operation done\"}");
        assert_eq!(r4.compaction_count, 1);
        // compact_boundary + content "compact" → NOT double counted (if/else)
        let r5 = parse("{\"type\":\"system\",\"subtype\":\"compact_boundary\",\"content\":\"compact marker\",\"compactMetadata\":{\"preTokens\":500}}");
        assert_eq!(r5.compaction_count, 1);
        assert_eq!(r5.pre_compaction_tokens, Some(500));
        // summary: number summary → not set; count still ++
        let r6 = parse("{\"type\":\"summary\",\"summary\":12345}");
        assert_eq!(r6.compaction_count, 1);
        assert_eq!(r6.summary, None);
        // last valid preTokens wins
        let r7 = parse(concat!(
            "{\"type\":\"system\",\"subtype\":\"compact_boundary\",\"compactMetadata\":{\"preTokens\":1000}}\n",
            "{\"type\":\"system\",\"subtype\":\"compact_boundary\",\"compactMetadata\":{\"preTokens\":2000}}"
        ));
        assert_eq!(r7.compaction_count, 2);
        assert_eq!(r7.pre_compaction_tokens, Some(2000));
    }

    // ---- metadata, content extraction, timestamps ----
    #[test]
    fn metadata_and_timestamps() {
        // first-seen metadata; wrong-typed ignored
        let r = parse("{\"type\":\"user\",\"version\":123,\"slug\":true,\"gitBranch\":\"ok-branch\",\"message\":{\"content\":\"q\"},\"timestamp\":\"2026-01-01T00:00:00.000Z\"}");
        assert_eq!(r.version, None); // number ignored
        assert_eq!(r.slug, None); // bool ignored
        assert_eq!(r.git_branch.as_deref(), Some("ok-branch"));
        assert_eq!(r.started_at, Some(1767225600000));
        // content-block array → first text block
        let r2 = parse("{\"type\":\"user\",\"message\":{\"content\":[{\"type\":\"image\",\"source\":\"x\"},{\"type\":\"text\",\"text\":\"block text here\"},{\"type\":\"text\",\"text\":\"second ignored\"}]},\"timestamp\":\"2026-01-01T00:00:00.000Z\"}");
        assert_eq!(r2.first_prompt.as_deref(), Some("block text here"));
        // firstHumanSeen latch: empty first real prompt → firstPrompt NEVER set even though a later one has text
        let r3 = parse(concat!(
            "{\"type\":\"user\",\"message\":{\"content\":\"\"},\"timestamp\":\"2026-01-01T00:00:00.000Z\"}\n",
            "{\"type\":\"user\",\"message\":{\"content\":\"second non-empty\"},\"timestamp\":\"2026-01-01T00:00:01.000Z\"}"
        ));
        assert_eq!(r3.first_prompt, None);
        assert_eq!(r3.user_message_count, 2);
        // earliest/latest across out-of-order ISO; offset normalized
        let r4 = parse(concat!(
            "{\"type\":\"user\",\"message\":{\"content\":\"a\"},\"timestamp\":\"2026-03-15T12:00:00.000Z\"}\n",
            "{\"type\":\"assistant\",\"timestamp\":\"2026-03-15T10:00:00.000Z\"}\n",
            "{\"type\":\"assistant\",\"timestamp\":\"2026-03-15T14:00:00.000Z\"}"
        ));
        assert_eq!(r4.started_at, Some(1773568800000));
        assert_eq!(r4.ended_at, Some(1773583200000));
        // +05:00 offset → UTC
        let r5 = parse(concat!(
            "{\"type\":\"user\",\"message\":{\"content\":\"a\"},\"timestamp\":\"2026-01-01T05:00:00+05:00\"}\n",
            "{\"type\":\"assistant\",\"timestamp\":\"2026-01-01T01:00:00.000Z\"}"
        ));
        assert_eq!(r5.started_at, Some(1767225600000));
        assert_eq!(r5.ended_at, Some(1767229200000));
        // unparseable + null ts → none collected
        let r6 = parse(concat!(
            "{\"type\":\"user\",\"message\":{\"content\":\"a\"},\"timestamp\":\"not-a-date\"}\n",
            "{\"type\":\"assistant\",\"timestamp\":null}"
        ));
        assert_eq!(r6.started_at, None);
        assert_eq!(r6.ended_at, None);
        // 600-char prompt sliced to 500
        let big = "A".repeat(600);
        let r7 = parse(&format!("{{\"type\":\"user\",\"message\":{{\"content\":\"{big}\"}},\"timestamp\":\"2026-01-01T00:00:00.000Z\"}}"));
        assert_eq!(r7.first_prompt.as_ref().map(|p| p.len()), Some(500));
    }
}

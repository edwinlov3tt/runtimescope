//! Headless surveys (ADR-0014, slice 4) — pure targeting evaluation + answer
//! validation. Survey storage + the endpoints live in analytics_store.rs /
//! server.rs; this module is the pure, testable core.

use serde_json::Value;
use sha2::{Digest, Sha256};

/// The targeted feature name (so the caller can count the user's uses), if the
/// survey uses a feature-usage trigger.
pub fn target_feature(targeting: &Value) -> Option<String> {
    targeting.get("feature").and_then(Value::as_str).filter(|f| !f.is_empty()).map(String::from)
}

/// Is the user eligible for the survey given its targeting + the user's role +
/// their use-count of the targeted feature? Role / feature-usage / sampling are
/// AND-combined; all optional. (active-status + once-per-user suppression are the
/// store's job, not here.)
pub fn eligible(targeting: &Value, survey_id: &str, anon_id: &str, role: Option<&str>, feature_uses: u64) -> bool {
    // Role filter.
    if let Some(roles) = targeting.get("roles").and_then(Value::as_array) {
        if !roles.is_empty() {
            let r = role.unwrap_or("");
            if !roles.iter().any(|x| x.as_str() == Some(r)) {
                return false;
            }
        }
    }
    // Feature-usage trigger.
    if target_feature(targeting).is_some() {
        let min = targeting.get("minUses").and_then(Value::as_u64).unwrap_or(1);
        if feature_uses < min {
            return false;
        }
    }
    // Deterministic sampling (stable per user+survey so it doesn't flicker on poll).
    if let Some(pct) = targeting.get("samplePct").and_then(Value::as_u64) {
        if pct < 100 && sample_bucket(survey_id, anon_id) >= pct {
            return false;
        }
    }
    true
}

/// Stable 0..99 bucket for (survey, user).
pub fn sample_bucket(survey_id: &str, anon_id: &str) -> u64 {
    let mut h = Sha256::new();
    h.update(survey_id.as_bytes());
    h.update([0u8]);
    h.update(anon_id.as_bytes());
    let d = h.finalize();
    u64::from_be_bytes(d[..8].try_into().unwrap_or([0; 8])) % 100
}

/// Validate submitted answers against the question set: every `required` question
/// must have a non-empty answer, and every answered `qid` must exist in the survey.
pub fn validate_answers(questions: &Value, answers: &Value) -> Result<(), String> {
    let qs = questions.as_array().ok_or_else(|| "survey has no questions".to_string())?;
    let ans = answers.as_object().ok_or_else(|| "answers must be an object {qid: value}".to_string())?;
    let qids: std::collections::HashSet<&str> = qs.iter().filter_map(|q| q.get("id").and_then(Value::as_str)).collect();
    for qid in ans.keys() {
        if !qids.contains(qid.as_str()) {
            return Err(format!("unknown question id: {qid}"));
        }
    }
    for q in qs {
        let qid = q.get("id").and_then(Value::as_str).unwrap_or("");
        let required = q.get("required").and_then(Value::as_bool).unwrap_or(false);
        if required {
            let answered = ans.get(qid).is_some_and(|v| !is_empty_answer(v));
            if !answered {
                return Err(format!("required question '{qid}' not answered"));
            }
        }
    }
    Ok(())
}

fn is_empty_answer(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::String(s) => s.trim().is_empty(),
        Value::Array(a) => a.is_empty(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn eligible_role_feature_and_sampling() {
        // role filter
        let t = json!({ "roles": ["Specialist", "Director"] });
        assert!(eligible(&t, "s1", "A", Some("Director"), 0));
        assert!(!eligible(&t, "s1", "A", Some("Coordinator"), 0));
        assert!(!eligible(&t, "s1", "A", None, 0));

        // feature-usage trigger
        let t = json!({ "feature": "geocode", "minUses": 5 });
        assert_eq!(target_feature(&t).as_deref(), Some("geocode"));
        assert!(!eligible(&t, "s1", "A", None, 4));
        assert!(eligible(&t, "s1", "A", None, 5));

        // empty targeting ⇒ everyone eligible
        assert!(eligible(&json!({}), "s1", "A", None, 0));
    }

    #[test]
    fn sampling_is_deterministic_and_roughly_proportional() {
        let t = json!({ "samplePct": 30 });
        // stable across calls for the same user
        let a = eligible(&t, "s1", "user-A", None, 0);
        assert_eq!(a, eligible(&t, "s1", "user-A", None, 0));
        // ~30% of a population included (loose bound)
        let n = 2000;
        let included = (0..n).filter(|i| eligible(&t, "s1", &format!("u{i}"), None, 0)).count();
        let pct = included as f64 / n as f64 * 100.0;
        assert!((20.0..40.0).contains(&pct), "expected ~30%, got {pct:.1}%");
        // samplePct 100 (or absent) ⇒ all included
        assert!(eligible(&json!({ "samplePct": 100 }), "s1", "z", None, 0));
    }

    #[test]
    fn validate_required_and_unknown_qids() {
        let qs = json!([
            { "id": "q1", "type": "rating", "required": true },
            { "id": "q2", "type": "text", "required": false },
        ]);
        assert!(validate_answers(&qs, &json!({ "q1": 5 })).is_ok());
        assert!(validate_answers(&qs, &json!({ "q1": 4, "q2": "nice" })).is_ok());
        // missing required
        assert!(validate_answers(&qs, &json!({ "q2": "x" })).is_err());
        // required present but empty
        assert!(validate_answers(&qs, &json!({ "q1": "" })).is_err());
        // unknown qid
        assert!(validate_answers(&qs, &json!({ "q1": 5, "ghost": 1 })).is_err());
    }
}

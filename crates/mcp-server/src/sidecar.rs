//! Recon sidecar client (ADR-0007).
//!
//! `scan_website` and the browser-recon tools are JS-only (Playwright). Per
//! ADR-0007 the Rust mcp-server spawns the Node recon sidecar on demand and
//! talks to it over the newline-delimited JSON stdio protocol documented in
//! `packages/recon-sidecar/README.md`:
//!   stdin:  {"id":1,"method":"<method>","params":{...}}\n
//!   stdout: {"id":1,"result":{...}}\n   |   {"id":1,"error":{"message":"..."}}\n
//!
//! One-shot per call: spawn, write the request, close stdin (the sidecar drains
//! then exits 0), read the response line. The sidecar manages its own Chromium
//! lifecycle. The launch command comes from `RUNTIMESCOPE_RECON_SIDECAR` (e.g.
//! `node /path/to/packages/recon-sidecar/dist/index.js`); when unset, the tools
//! report the sidecar isn't configured. Resolving/bundling it into the
//! curl-install is Milestone 6.

use serde_json::{json, Value};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

fn sidecar_command() -> Option<(String, Vec<String>)> {
    let raw = std::env::var("RUNTIMESCOPE_RECON_SIDECAR").ok()?;
    let raw = raw.trim();
    // Preferred: a JSON argv array (handles paths with spaces) —
    // e.g. `["node","/Users/a b/recon-sidecar/dist/index.js"]`.
    if raw.starts_with('[') {
        if let Ok(argv) = serde_json::from_str::<Vec<String>>(raw) {
            let (cmd, args) = argv.split_first()?;
            return Some((cmd.clone(), args.to_vec()));
        }
    }
    // Back-compat: whitespace-split (breaks on spaces in paths — use JSON form).
    let parts: Vec<String> = raw.split_whitespace().map(String::from).collect();
    let (cmd, args) = parts.split_first()?;
    Some((cmd.clone(), args.to_vec()))
}

/// Call a sidecar method and return its `result` (or the error message). Browser
/// scans can take seconds; the read is bounded to 45s.
pub async fn call_sidecar(method: &str, params: Value) -> Result<Value, String> {
    let Some((cmd, args)) = sidecar_command() else {
        return Err("recon sidecar not configured (set RUNTIMESCOPE_RECON_SIDECAR)".into());
    };

    let mut child = Command::new(&cmd)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("failed to spawn recon sidecar ({cmd}): {e}"))?;

    let request = json!({ "id": 1, "method": method, "params": params }).to_string();
    {
        let mut stdin = child.stdin.take().ok_or("sidecar stdin unavailable")?;
        stdin.write_all(request.as_bytes()).await.map_err(|e| e.to_string())?;
        stdin.write_all(b"\n").await.map_err(|e| e.to_string())?;
        // stdin dropped here → closed → sidecar drains in-flight work + exits.
    }

    let stdout = child.stdout.take().ok_or("sidecar stdout unavailable")?;
    let mut lines = BufReader::new(stdout).lines();

    let response = tokio::time::timeout(Duration::from_secs(45), async {
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
            // The response line is the one carrying `result` or `error`.
            if v.get("result").is_some() || v.get("error").is_some() {
                return Some(v);
            }
        }
        None
    })
    .await;

    let _ = child.kill().await;

    match response {
        Ok(Some(v)) if v.get("result").is_some() => Ok(v["result"].clone()),
        Ok(Some(v)) => Err(v
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("sidecar error")
            .to_string()),
        Ok(None) => Err("recon sidecar produced no response".into()),
        Err(_) => Err("recon sidecar timed out (45s)".into()),
    }
}

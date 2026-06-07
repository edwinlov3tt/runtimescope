# Draft — Analytics slice 5: uptime / status

> Design for the **Status** view (`docs/ui-update/analytics-status.html`),
> ADR-0012 slice 5. Companion to [analytics-data-model.md](./analytics-data-model.md)
> (§ Status). Status: **IMPLEMENTED (collector-side)** — store (3 tables + prune +
> cascade), pure rollups (`classify`/`app_status`) + the SSRF guard
> (`analytics_uptime.rs`), the 6 endpoints, and the background probe task are live
> and tested (unit + HTTP + a live self-probe). **Deferred** (tagged
> `TODO(analytics-status-heartbeat)`): the SDK auto-heartbeat client wiring and
> missed-heartbeat→down detection (the `/heartbeat` endpoint exists; the active
> probe is the primary signal). The dashboard page remains the `TODO(analytics-status)`
> stub — now has a backend to wire.

## What the prototype renders (the contract)

- **Monitored apps:** `id, name, url, state (up|degraded|down), uptime_pct, resp_ms,
  last_check`, + a **60-day daily uptime strip** (per-day 0=up / 1=degraded / 2=down).
- **Incidents:** `app, status (ongoing|resolved), started, duration, type`
  (e.g. "No heartbeat (3 missed)", "Slow response (512ms > 400ms)", "503 on
  /heartbeat", "Deploy lock"), severity.
- **KPIs:** Apps Monitored (+ healthy count), Overall Uptime (90-day avg), Active
  Incidents (down/degraded split), Avg Response (healthy only), Healthy N/total,
  Incidents (30d, resolved count).
- **Mechanics (from the toolbar):** "SDK heartbeat every hour · active probe every
  60s." Actions: **Check all now** (force probe), **Monitor app** (add).

## Two signals → state

1. **SDK heartbeat (hourly):** the instrumented app POSTs a liveness ping. Missing
   **N consecutive** expected heartbeats ⇒ candidate **down**.
2. **Active probe (every 60s):** the collector requests the app's `url` (or a
   `/heartbeat` path) and times it. Non-2xx / unreachable ⇒ **down**; latency
   **> 400ms** (configurable) ⇒ **degraded**; else **up**.

State precedence: down > degraded > up. A daily uptime-strip cell = the worst
observed state that day.

## Data model (new tables in `analytics.db`)

```sql
CREATE TABLE analytics_monitored_apps (
  id          TEXT PRIMARY KEY,         -- slug
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,            -- probe target
  probe_path  TEXT,                     -- optional, e.g. /heartbeat (else url)
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE TABLE analytics_uptime_checks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id      TEXT NOT NULL,
  checked_at  INTEGER NOT NULL,
  source      TEXT NOT NULL,           -- 'probe' | 'heartbeat'
  state       INTEGER NOT NULL,        -- 0 up / 1 degraded / 2 down
  resp_ms     INTEGER,                 -- probe latency (null for heartbeat)
  FOREIGN KEY (app_id) REFERENCES analytics_monitored_apps(id) ON DELETE CASCADE
);
CREATE TABLE analytics_incidents (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id      TEXT NOT NULL,
  type        TEXT NOT NULL,           -- "No heartbeat (N missed)", "Slow response (Xms)" ...
  severity    TEXT NOT NULL,           -- 'down' | 'degraded'
  started_at  INTEGER NOT NULL,
  resolved_at INTEGER,                 -- null = ongoing
  FOREIGN KEY (app_id) REFERENCES analytics_monitored_apps(id) ON DELETE CASCADE
);
```

Rollups (uptime %, the 60-day strip, avg response, KPIs) are SQL over
`analytics_uptime_checks`; incidents are opened/closed on state transitions.
`uptime_checks` needs its own **retention sweep** (e.g. keep 90d) so it doesn't
grow unbounded — wire into the existing daily sweep.

## Endpoints (mirror the analytics surface)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/analytics/status` | apps + state/uptime%/resp/last_check + 60-day strip + KPIs |
| GET | `/api/analytics/incidents?status=ongoing\|resolved&window=` | incident list |
| POST | `/api/analytics/monitored-apps` `{name,url,probePath?}` | add a monitored app (SSRF-guarded — see below) |
| DELETE | `/api/analytics/monitored-apps/{id}` | stop monitoring |
| POST | `/api/analytics/heartbeat` `{appId}` | SDK hourly liveness ping (records a heartbeat check) |
| POST | `/api/analytics/status/check-all` | force an immediate probe of all enabled apps |

All auth-gated like the rest of analytics. `heartbeat` is ingest-side
(rate-limited like `/api/events`).

## Background probe task

A tokio task (like the Mosaic periodic sync / retention sweep) every
`RUNTIMESCOPE_UPTIME_PROBE_SECS` (default 60): for each enabled app, time a GET to
its URL/probe_path, classify (up/degraded/down), insert an `uptime_checks` row,
and open/resolve incidents on transitions. Heartbeat-missed detection runs in the
same tick (no heartbeat in the last N intervals ⇒ down).

## ⚠ Security — the active probe is an SSRF vector (must guard)

The probe makes the collector fetch **operator-supplied URLs**. This is the same
hazard CLAUDE.md calls out for `scan_website` → `page.goto`. Before probing, the
`monitored-apps` POST and the probe loop MUST:
- enforce an `http(s)://` scheme allowlist (block `file://`, `gopher://`, etc.);
- block private/loopback/link-local/metadata IPs (`127.0.0.0/8`, `10/8`,
  `172.16/12`, `192.168/16`, `169.254/16`, `::1`, `fd00::/8`, `169.254.169.254`)
  unless an explicit `RUNTIMESCOPE_UPTIME_ALLOW_PRIVATE=1` opt-in (self-host on a
  private network is a legit case — but default-deny);
- cap redirects + set a short timeout; never follow to a different scheme.
Reuse / factor the `guard_scan_url` logic from the scanner tools.

## Env vars

| Var | Default | |
|---|---|---|
| `RUNTIMESCOPE_UPTIME_PROBE_SECS` | `60` | active-probe interval (0 disables probing; heartbeat-only) |
| `RUNTIMESCOPE_UPTIME_SLOW_MS` | `400` | latency → degraded threshold |
| `RUNTIMESCOPE_UPTIME_MISSED_HEARTBEATS` | `3` | consecutive misses → down |
| `RUNTIMESCOPE_UPTIME_ALLOW_PRIVATE` | _unset_ | allow probing private/loopback IPs (default-deny, SSRF) |

## Implementation plan (slices)

1. **Store:** the 3 tables + methods (`add_app`/`list_apps`/`delete_app`,
   `record_check`, `open_incident`/`resolve_incident`/`list_incidents`, the
   uptime/strip/KPI queries) + the retention sweep extension. Unit-tested.
2. **SSRF guard:** factor `guard_probe_url` (reuse scanner logic); unit-test the
   blocklist (private IPs, schemes, metadata IP).
3. **Endpoints:** the 6 routes above (status/incidents/monitored-apps CRUD/
   heartbeat/check-all), auth-gated; heartbeat rate-limited.
4. **Probe task:** the 60s background loop (needs an http client — reqwest is now
   a dep from 3b; reuse it) with timeout + the SSRF guard; state classification +
   incident open/close on transitions.
5. **SDK heartbeat:** an opt-in `RuntimeScope.heartbeat()` / auto-hourly ping
   (browser + server SDK), default off (it's an outbound call from the app).

## Open questions

- **App identity:** does a monitored app map to a runtime `appName`/`projectId`,
  or is it a standalone uptime target? (Prototype shows arbitrary URLs incl.
  external domains → standalone. Lean: standalone `monitored_apps`, optionally
  linkable to an app.)
- **Heartbeat vs probe authority:** if probe says up but heartbeats stopped (app
  serving cached/static but the SDK died), which wins? Propose: report both;
  incident type distinguishes "No heartbeat" vs "Slow/Down probe."
- **TODO(analytics-status):** the dashboard page is already stubbed with this tag
  (handoff doc) — wire it to `/status` + `/incidents` once these land.

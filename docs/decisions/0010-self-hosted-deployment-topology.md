# ADR-0010: Self-hosted deployment topology (droplet + Cloudflare Tunnel)

**Status:** `Accepted` — implemented 2026-06-02 (see Notes)
**Date:** 2026-06-02
**Deciders:** Edwin (owner) + implementing instance
**Phase:** `Deploy & Remote-MCP`

---

## Context

Users want to run a RuntimeScope collector for **deployed** applications and reach
its analytics from anywhere — via a server IP or a tunneled domain. A drift check
of the existing deploy surface (this turn) found the story was **designed
end-to-end but built for the Node collector that M7 deleted** (`ab1095d`), and
several pieces don't line up with the current Rust collector:

- `serve()` binds **`127.0.0.1` hardcoded** (`crates/collector-core/src/server.rs:264-265`).
  `RUNTIMESCOPE_HOST` appears only in a CLI help string (`crates/cli/src/main.rs:61`)
  — it is **not honored**. So the collector cannot be reached over a Docker
  network or a public interface.
- The `Dockerfile` + `docker-compose*.yml` `COPY packages/collector/` and run
  `node …/standalone.js` — both **deleted**. The image won't build.
- The **dashboard + read API have no first-party auth client** (`api.ts` sends no
  `Authorization` header; the SPA route is public — `server.rs:153-157`). With
  auth active, the dashboard loads but every data call 401s. So a protected *and*
  usable dashboard needs auth at the proxy layer today.
- The TLS DSN derives ports `6768`/`6767` even with no port given
  (`packages/sdk/src/dsn.ts:35-36`), so the README's own example DSN wouldn't
  reach a Caddy-on-443 deployment.

What **is** solid and reusable: the auth core (`auth.rs` — `RUNTIMESCOPE_AUTH_TOKEN`,
constant-time compare, `AUTH_FAILED`, workspace `tk_` keys), the SDK DSN/`serverUrl`
config + production auto-disable guard, retention, and the Caddy HTTPS/WSS design.

Forces: keep the **batteries-included, single-binary** posture (RS's differentiator);
make the *safe* thing the *default* (no accidental public bind); minimize collector
code change; and give a clean path to a tunneled domain with real auth.

## Decision

**Ship two supported self-host paths, recommend the tunnel path, and make
localhost the default bind.** A collector reached from the internet is fronted by
a reverse proxy / tunnel that terminates TLS and enforces access — the collector
itself stays a localhost-default, single-binary process.

**What we are doing:**

- **Path A (recommended) — native binary + Cloudflare Tunnel.** Run the Rust
  `collector-server` on a droplet/VPS bound to `127.0.0.1`; run `cloudflared` on
  the same host with ingress routing the domain → `127.0.0.1:6768` (REST +
  dashboard + `POST /api/events`) and the SDK WS → `127.0.0.1:6767`. Cloudflare
  provides the domain, HTTPS/WSS, and **zero open inbound ports**. *Because
  cloudflared dials localhost, this needs no bind change to work.*
- **Path B — Docker + Caddy.** A new **Rust** multi-stage `Dockerfile`
  (cargo-chef build → copy the static binary onto a minimal base; drop the Node
  toolchain), refreshed `docker-compose.yml` / `deploy/docker-compose.prod.yml`,
  and the existing `deploy/Caddyfile` for automatic Let's Encrypt HTTPS/WSS.
- **Honor `RUNTIMESCOPE_HOST`** in `serve()` (default `127.0.0.1`). Path B sets
  it to `0.0.0.0` so Caddy (a separate container) can reach the collector over
  the Docker network. Path A leaves the default.
- **Delegate dashboard/read auth to the proxy layer** for now: Cloudflare Access
  (SSO/email) on Path A, Caddy `basic_auth` on Path B. `RUNTIMESCOPE_AUTH_TOKEN`
  continues to gate SDK ingest independently.
- **Deployment hardening** (Q3 robustness): document + add **ingest
  rate-limiting / quota** on `POST /api/events`, a **backup runbook** (the
  `VACUUM INTO` snapshots + volume snapshots), and disk-pressure guidance tied to
  `RUNTIMESCOPE_RETENTION_DAYS`.
- A copy-paste **droplet runbook** (Path A) + the refreshed Docker assets (Path B).

**What we are explicitly NOT doing:**

- **Not** hosting the collector on Cloudflare Workers — it is a stateful,
  long-running process with SQLite + a WebSocket server; Workers are ephemeral. A
  Durable-Objects/D1 rebuild is a port, not a config, and is out of scope.
- **Not** binding `0.0.0.0` by default — a public bind must be opt-in.
- **Not** building first-party dashboard login in this ADR (deferred; proxy auth
  covers it). Tracked as a follow-up.
- **Not** multi-node / HA / horizontal scale — single host, accepted (see 0012
  for the store seam that keeps that door open).

## Consequences

**Positive:**

- A tunneled domain with real HTTPS + SSO, no open ports, working **today** on
  Path A with effectively no collector code change.
- The safe default (localhost) is preserved; public exposure is a deliberate act.
- The stale deploy assets get fixed; Docker/Caddy users have a real path again.

**Negative / accepted trade-offs:**

- Dashboard auth lives in the proxy, not the app — a self-hoster who skips the
  proxy and binds publicly exposes their data. Mitigated by the localhost default
  + loud docs.
- SQLite single-host limits (write concurrency, single point of failure) remain
  — acceptable for the internal-tools / moderate-traffic target; the escape hatch
  is the store seam in ADR-0012.
- Two supported paths = more docs/CI surface to keep honest.

**Reversal cost:** Cheap. `RUNTIMESCOPE_HOST` is additive; the Docker assets are
isolated under `deploy/`; the tunnel is pure ops config. First-party dashboard
auth can be added later without undoing any of this.

## Alternatives considered

1. **Bind `0.0.0.0` by default + direct port exposure.** Simplest, but an
   insecure default for a tool that holds your app's runtime data; one missed
   firewall rule = public data. Rejected — keep localhost default.
2. **Caddy-only (drop the tunnel path).** Works and is in-repo already, but
   requires the bind fix to be load-bearing, opens 80/443, and needs DNS + cert
   management on the host. Kept as Path B, not the recommendation.
3. **Cloudflare Workers-hosted collector.** Impossible without a stateful
   rewrite (DO + D1). Rejected for now; noted as a future research item.
4. **First-party dashboard auth now.** More correct long-term, but a larger
   surface (login UI, token plumbing in `api.ts`, session mgmt) that proxy auth
   makes non-urgent. Deferred.

## Cross-links

- Related ADRs: [`./0011-remote-mcp-streamable-http.md`](./0011-remote-mcp-streamable-http.md)
  (the remote MCP that rides this topology), [`./0012-analytics-adoption-subsystem.md`](./0012-analytics-adoption-subsystem.md)
  (store seam for scale), [`./0008-rust-mcp-embeds-collector-core.md`](./0008-rust-mcp-embeds-collector-core.md).
- Source: [`../../crates/collector-core/src/server.rs`](../../crates/collector-core/src/server.rs)
  (bind), [`../../crates/collector-core/src/auth.rs`](../../crates/collector-core/src/auth.rs),
  [`../../deploy/`](../../deploy/), [`../../Dockerfile`](../../Dockerfile),
  [`../../packages/sdk/src/dsn.ts`](../../packages/sdk/src/dsn.ts).
- Drift audit that surfaced the stale assets: this turn's investigation (see
  [`../reviews/0004-dashboard-collector-drift.md`](../reviews/0004-dashboard-collector-drift.md)
  for the related dashboard/collector audit pattern).

## Notes

**Implemented 2026-06-02** (commits `cfa7062`, `7aa502d`):

- `RUNTIMESCOPE_HOST` is honored by the standalone collector (`host_from_env()` +
  `serve(host, …)`), default `127.0.0.1`, fail-closed to loopback; non-loopback
  binds warn. The embedded MCP collector always binds loopback. **Verified live**
  (`0.0.0.0` → `*:port`; default → loopback) + unit-tested.
- Rust multi-stage `Dockerfile` replaces the Node one; `docker-compose.yml` +
  `deploy/docker-compose.prod.yml` refreshed; **`deploy/droplet-cloudflared.md`**
  is the recommended runbook (cloudflared dials loopback; local Caddy does the
  WS/HTTP split + bearer injection; SDK ingest on a second hostname).
- ⚠ **Docker image not yet built** (no Docker in the authoring env) — Dockerfile/
  compose are written + reviewed but unverified; build them on a Docker host
  before relying on the container path. The code change is verified.

WS-routing was resolved as **two hostnames** (dashboard vs SDK-WS) in the runbook,
because cloudflared ingress can't split by the `Upgrade` header on one hostname
(Caddy can, via `@websocket`). The DSN→endpoint single-443 mismatch (`dsn.ts`)
remains a tracked follow-up — apps use explicit `serverUrl`/`endpoint` for now.

The **dashboard-token caveat** surfaced during implementation and is load-bearing:
when `RUNTIMESCOPE_AUTH_TOKEN` is set the read API requires it but the dashboard
sends none, so a token-protected dashboard is empty *everywhere* (not just
remotely). The runbook works around it with proxy-layer bearer injection behind
Cloudflare Access.

**Update — first-party dashboard auth landed** (commits `a91c9fa`, `d625587`):
`/api/health` now advertises `authRequired`, and the dashboard has a token login
screen that sends `Authorization: Bearer` on every call + `?token=` on the WS.
So the proxy bearer-injection in the runbook is now **optional** — you can log
into the dashboard with the token directly. Cloudflare Access (SSO) is still
recommended in front of the dashboard for defense-in-depth, but it's no longer
required for the dashboard to *function*. The "NOT doing → first-party dashboard
login" item above is therefore resolved.

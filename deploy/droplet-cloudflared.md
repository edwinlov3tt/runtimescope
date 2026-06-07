# Droplet + Cloudflare Tunnel runbook (ADR-0010, Path A — recommended)

Stand up a RuntimeScope collector for **deployed** apps, reachable at a domain
with HTTPS and SSO, **no open inbound ports**. This is the recommended self-host
path: `cloudflared` runs on the droplet and dials `127.0.0.1`, so the collector
keeps its safe localhost-default bind.

```
deployed apps ──(SDK, DSN + token)──┐
                                     ▼
你 (browser, SSO) ──► Cloudflare edge (TLS + Access) ──► cloudflared ──► local Caddy ──► collector
                                                          (on droplet)   (127.0.0.1)   :6767 / :6768
```

Two hostnames, two trust models:

| Hostname | Serves | Auth |
|---|---|---|
| `rs.example.com` | dashboard + REST read API + dashboard live WS (`:6768`) | **Cloudflare Access** (SSO) — Caddy injects the admin bearer (see "the dashboard-token caveat") |
| `ingest.example.com` | SDK ingest: browser WS (`:6767`) + server/workers `POST /api/events` (`:6768`) | **`RUNTIMESCOPE_AUTH_TOKEN`** (each SDK sends it via DSN) — **no** Access |

---

## 0. Dashboard auth (token login — bearer injection now optional)

When `RUNTIMESCOPE_AUTH_TOKEN` is set, the collector's read API + dashboard WS
require that token. The dashboard now has a **first-party login screen**: it reads
`authRequired` from `/api/health` and, when on, prompts for the token and sends it
on every call (`Authorization: Bearer`) and the WS (`?token=`). So you can simply
**open the dashboard and enter the token** — no proxy header injection needed.

**Recommended (defense-in-depth):** still put **Cloudflare Access** (SSO) in front
of the dashboard hostname so the login screen isn't even reachable without your
identity, *and* the token gates the API. The bearer-injection in §2 is now an
**optional** convenience (skip the token prompt for SSO'd users); the WS/HTTP
split it performs is still needed. The ingest hostname never injects — SDKs send
their own token.

---

## 1. Provision + run the collector

**Native binary (recommended):**

```bash
# On the droplet (Ubuntu/Debian). Install the Rust collector.
cargo install runtimescope          # or download the release binary
# Generate the shared auth token (used by SDKs + injected for the dashboard):
export AUTH_TOKEN=$(openssl rand -hex 32)   # save this
# Run as a background service (binds 127.0.0.1 by default — correct here):
RUNTIMESCOPE_AUTH_TOKEN=$AUTH_TOKEN runtimescope service install
runtimescope service status         # → healthy on 127.0.0.1:6768
```

> Do **not** set `RUNTIMESCOPE_HOST=0.0.0.0` here — cloudflared/Caddy reach the
> collector over loopback. `0.0.0.0` is only for the Docker path
> (`deploy/docker-compose.prod.yml`), where a separate container needs it.

**Docker alternative:** `docker compose -f deploy/docker-compose.prod.yml up -d`
uses Caddy for TLS directly (skip the tunnel) — see that file's header.

## 2. Local Caddy — WS/HTTP split + bearer injection

`cloudflared` ingress routes by hostname, not by the WebSocket `Upgrade` header,
so a small local Caddy does the split (and the dashboard bearer injection). Caddy
here serves plain HTTP on loopback — **Cloudflare terminates TLS**, not Caddy.

`/etc/caddy/Caddyfile`:

```caddy
# Dashboard + read API (behind Cloudflare Access). Inject the admin bearer so the
# read API is satisfied; no SDK traffic reaches this site, so injection is safe.
:8081 {
    header_up Authorization "Bearer {$AUTH_TOKEN}"
    reverse_proxy 127.0.0.1:6768
}

# SDK ingest. No injection — each SDK presents its own token via DSN.
:8082 {
    @websocket header Connection *Upgrade*
    @websocket header Upgrade    websocket
    reverse_proxy @websocket 127.0.0.1:6767   # browser SDK WebSocket
    reverse_proxy            127.0.0.1:6768   # server/workers POST /api/events
}
```

Run Caddy with `AUTH_TOKEN` in its environment (`sudo AUTH_TOKEN=$AUTH_TOKEN caddy run --config /etc/caddy/Caddyfile`, or set it in the systemd unit).

## 3. cloudflared — tunnel + ingress + DNS

```bash
cloudflared tunnel login
cloudflared tunnel create runtimescope
# Map both hostnames to the local Caddy site ports:
cloudflared tunnel route dns runtimescope rs.example.com
cloudflared tunnel route dns runtimescope ingest.example.com
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: runtimescope
credentials-file: /root/.cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: rs.example.com
    service: http://127.0.0.1:8081      # → Caddy (dashboard, bearer-injected)
  - hostname: ingest.example.com
    service: http://127.0.0.1:8082      # → Caddy (SDK ingest split)
  - service: http_status:404
```

```bash
cloudflared service install   # run the tunnel as a service
```

## 4. Cloudflare Access (SSO on the dashboard)

In the Cloudflare Zero Trust dashboard → **Access → Applications**: add a
self-hosted app for `rs.example.com`, policy = your email / Google Workspace /
GitHub org. **Do not** put Access on `ingest.example.com` — SDKs cannot complete
an SSO flow; that host is gated by the token instead.

Visit `https://rs.example.com/dashboard` → SSO → live analytics.

## 5. Point deployed apps at the collector

Ingest goes to `ingest.example.com`, which proxies both the WS and the HTTP
ingest (the §2 Caddy `@websocket` split). A TLS DSN with no port now resolves to
that single 443 domain (`wss://ingest.example.com` + `https://ingest.example.com`),
so the bare DSN works — no explicit ports needed:

```bash
# .env.production (expose with the right prefix for your framework)
RUNTIMESCOPE_DSN=runtimescopes://proj_xxx:<AUTH_TOKEN>@ingest.example.com
VITE_RUNTIMESCOPE_DSN=runtimescopes://proj_xxx:<AUTH_TOKEN>@ingest.example.com
```

```ts
// Browser / Server / Workers — DSN carries projectId, token, host, and TLS.
RuntimeScope.init({ appName: 'my-web', dsn: process.env.VITE_RUNTIMESCOPE_DSN });
RuntimeScope.connect({ appName: 'my-api', dsn: process.env.RUNTIMESCOPE_DSN });
```

(Prefer not to embed the token in the browser bundle for a public app — use a
workspace `tk_` key scoped to ingest, or an explicit `serverUrl` + short-lived
token, per your threat model.)

## 5b. Remote MCP (optional) — let a coding agent inspect the deployed app

Expose the MCP tool surface over Streamable HTTP (ADR-0011) so Claude Code can
query the deployed app's runtime. It's **bearer-gated** and refuses to start
without a token, so it can ride the tunnel directly.

On the droplet, run it alongside the collector (reads the same store via attach):

```bash
RUNTIMESCOPE_AUTH_TOKEN=$AUTH_TOKEN RUNTIMESCOPE_MCP_HTTP_PORT=6770 \
  runtimescope mcp --http      # serves http://127.0.0.1:6770/mcp (loopback)
```

Add a third tunnel hostname for it (no Access — agents send the bearer, not SSO):

```yaml
# ~/.cloudflared/config.yml ingress (add above the 404 catch-all)
  - hostname: mcp.example.com
    service: http://127.0.0.1:6770
```
```bash
cloudflared tunnel route dns runtimescope mcp.example.com
```

Connect Claude Code:

```bash
claude mcp add runtimescope-prod --transport http \
  https://mcp.example.com/mcp \
  --header "Authorization: Bearer $AUTH_TOKEN"
```

Now the agent can call `detect_issues`, `get_network_requests`, etc. against the
**deployed** app. (Command-channel tools like `capture_dom_snapshot` only work
for an SDK currently connected to that collector's WS.) Interactive claude.ai
custom connectors need OAuth — a tracked follow-up; the bearer path above covers
Claude Code + the MCP-connector API today.

## 6. Backups + retention

- The collector keeps `RUNTIMESCOPE_RETENTION_DAYS` (default 90) of events and
  prunes + `VACUUM`s daily; it also keeps `RUNTIMESCOPE_MAX_SNAPSHOTS`
  `VACUUM INTO` backups under `~/.runtimescope/snapshots/`.
- Back up `~/.runtimescope/` (or the docker volume) on a schedule, and/or take
  droplet volume snapshots. The DB is WAL — copy a `VACUUM INTO` snapshot rather
  than the live `collector.db` for a consistent backup.
- Watch disk on small droplets: `collector.db` grows to the retention window.

## Hardening follow-ups (tracked, ADR-0010)

- ✅ **First-party dashboard auth** — landed (token login screen); the §2
  bearer-injection is now optional.
- ✅ **DSN single-443 mode** — landed; the bare
  `runtimescopes://proj_xxx:token@ingest.example.com` resolves to the 443 domain.
- ✅ **Ingest rate-limiting** — landed: per-client token bucket on `POST /api/events`
  + the SDK WS handshake (`RUNTIMESCOPE_INGEST_RATE` / `_BURST`, default 120/s).
  **Behind this tunnel, set `RUNTIMESCOPE_TRUST_PROXY=1`** so it keys on the real
  client IP (`CF-Connecting-IP`) rather than the proxy's loopback address.

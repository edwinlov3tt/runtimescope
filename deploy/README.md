# Deploying RuntimeScope

Self-host a RuntimeScope collector so your production apps can send telemetry to a central endpoint. Once deployed, point your SDKs at the hosted URL via DSN.

## One-Click Deploys

| Platform | Cost | Deploy |
|----------|------|--------|
| **Fly.io** | ~$3/mo (scale-to-zero) | [![Deploy to Fly.io](https://fly.io/static/images/launch/deploy-to-fly.svg)](https://fly.io/launch/github/edwinlov3tt/runtimescope) |
| **DigitalOcean App Platform** | $5/mo | [![Deploy to DO](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new?repo=https://github.com/edwinlov3tt/runtimescope/tree/main) |
| **Railway** | ~$5/mo | [![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/runtimescope) |
| **Render** | $7/mo | [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/edwinlov3tt/runtimescope) |

## Self-Host on a VPS (with automatic HTTPS)

For Hetzner, Linode, DigitalOcean Droplet, Vultr, AWS EC2, etc.

### Prerequisites

- A server with Docker + Docker Compose installed
- A domain name pointed at the server's public IP (e.g., `runtimescope.yourcompany.com` → `1.2.3.4`)

### Steps

```bash
# 1. Clone the repo (or just the deploy/ directory)
git clone https://github.com/edwinlov3tt/runtimescope.git
cd runtimescope

# 2. Generate a secure auth token
echo "AUTH_TOKEN=$(openssl rand -hex 32)" > .env

# 3. Edit the Caddyfile — replace `runtimescope.example.com` with your domain
nano deploy/Caddyfile

# 4. Start the collector + Caddy reverse proxy
docker compose -f deploy/docker-compose.prod.yml --env-file .env up -d

# 5. Verify it's running (should return {"status":"ok",...})
curl https://runtimescope.yourcompany.com/api/health
```

Caddy will automatically provision an HTTPS certificate via Let's Encrypt on first start. No manual TLS setup needed.

## Docker — Minimal Local Run

```bash
docker run -d \
  -p 6767:6767 \
  -p 6768:6768 \
  -v rs-data:/home/runtimescope/.runtimescope \
  -e RUNTIMESCOPE_AUTH_TOKEN=$(openssl rand -hex 32) \
  --name runtimescope \
  runtimescope/collector:latest
```

## Point Your SDKs at the Hosted Collector

Once the collector is deployed, update your SDK init to use a production DSN.

### Environment variable (recommended)

```bash
# .env.production
RUNTIMESCOPE_DSN=runtimescopes://proj_xxx@runtimescope.yourcompany.com
```

For frontend frameworks, expose it with the right prefix:

```bash
# Next.js / Vite
NEXT_PUBLIC_RUNTIMESCOPE_DSN=runtimescopes://proj_xxx@runtimescope.yourcompany.com
VITE_RUNTIMESCOPE_DSN=runtimescopes://proj_xxx@runtimescope.yourcompany.com
```

### SDK init

```typescript
// Browser SDK (React, Vue, Svelte, etc.)
import { RuntimeScope } from '@runtimescope/sdk';

RuntimeScope.init({
  dsn: import.meta.env.VITE_RUNTIMESCOPE_DSN || process.env.NEXT_PUBLIC_RUNTIMESCOPE_DSN,
});
// If no DSN is set (dev without collector), the SDK is completely inert — no console errors.

// Server SDK (Express, Hono, etc.)
import { RuntimeScope } from '@runtimescope/server-sdk';

RuntimeScope.connect(); // Auto-reads RUNTIMESCOPE_DSN env var

// Cloudflare Workers
import { withRuntimeScope } from '@runtimescope/workers-sdk';

export default withRuntimeScope(handler, {
  dsn: env.RUNTIMESCOPE_DSN,
  appName: 'my-worker',
});
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RUNTIMESCOPE_HOST` | `127.0.0.1` | Bind address. Set to `0.0.0.0` in Docker. |
| `RUNTIMESCOPE_PORT` | `6767` | WebSocket port |
| `RUNTIMESCOPE_HTTP_PORT` | `6768` | HTTP API port |
| `RUNTIMESCOPE_BUFFER_SIZE` | `10000` | Max in-memory events |
| `RUNTIMESCOPE_RETENTION_DAYS` | `30` | SQLite event retention |
| `RUNTIMESCOPE_AUTH_TOKEN` | _(none)_ | Auth token required on SDK connections |

## Persistent Data

The collector stores events and session metadata in SQLite at `/home/runtimescope/.runtimescope/`. Always mount this as a persistent volume in production.

## Scaling

For high-traffic deployments (millions of events/day), upgrade to a larger instance and consider:

- **Vertical**: More RAM/CPU — each collector handles 10K+ concurrent WS connections on 1 vCPU
- **Horizontal**: Multiple collectors behind a sticky-session load balancer (SDK sessions must stay on the same instance)
- **Storage**: Replace SQLite with Postgres by setting `RUNTIMESCOPE_DATABASE_URL` (future feature)

## Troubleshooting

**SDK connects but no events appear**
- Check the DSN protocol: `runtimescopes://` (with `s`) for HTTPS/WSS, `runtimescope://` for localhost
- Verify auth token matches what's configured on the collector
- Check browser console for `[RuntimeScope]` messages

**HTTPS certificate fails**
- Ensure DNS A record points to the correct IP
- Port 80 must be reachable for Let's Encrypt HTTP-01 challenge
- Check Caddy logs: `docker compose -f deploy/docker-compose.prod.yml logs caddy`

**Out of disk space**
- Reduce `RUNTIMESCOPE_RETENTION_DAYS` (default 30)
- Check volume size: `docker system df -v`

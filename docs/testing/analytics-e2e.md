# Analytics end-to-end testing (pre-v0.12)

Two ways to exercise the whole analytics subsystem (slices 1–6) against a real
collector: the **local playground** (fast loop) and a **droplet live deploy**
(real network, TLS, remote SDK).

---

## 1. Local — the playground

The playground (`playground/`) is a Vite+React app + node backend with both SDKs;
it now has an **Analytics** panel (identify + ROI features + headless surveys).

```bash
npm install                                   # once, from the repo root
npm run build -w packages/sdk                 # ensure the SDK dist is current
npm run dev -w playground                      # frontend :5173, backend :5174 (collector auto-starts)
npm run dashboard                              # dashboard at :3200 (if not already up)
node scripts/seed-playground-analytics.mjs     # baselines (geocode/export) + a Specialist-targeted survey
```

Then at **http://localhost:5173**, in the **Analytics** + **Surveys** panels:

1. Pick role **Specialist** → **identify()** (sends email/role/consent/externalId → anon id).
2. Click **use geocode ×10** and **use export** a few times → ROI `value`/`hours`.
3. **getActiveSurveys()** → the seeded CSAT survey renders (the playground draws its
   *own* UI from the question defs) → fill it → **Submit** (or **Dismiss**).
4. Re-run **getActiveSurveys()** → it's gone (once-per-user). Switch role to
   **Director** → identify → getActiveSurveys() → empty (role targeting).

**Verify the data landed** (any of):
- **Dashboard** (:3200) → Analytics → Overview (`valueSaved`/adoption), Features
  (geocode/export $), Surveys (the response).
- **API**: `curl localhost:6768/api/analytics/overview?window=30d`,
  `…/features`, `…/surveys` (admin list), `…/surveys/<id>/responses`.
- **MCP** (in Claude Code): "show me the analytics overview" / network requests.

**Admin de-anon (slice 6)** — closed unless a key is set. Restart the collector with
one to test the PII path:
```bash
RUNTIMESCOPE_ADMIN_KEY=topsecret npm run dev -w playground   # (or export it for the collector)
curl localhost:6768/api/analytics/admin/users                 # → 403 (no header)
curl -H 'X-Admin-Key: topsecret' localhost:6768/api/analytics/admin/users   # → email/ip/externalId
curl -H 'X-Admin-Key: topsecret' localhost:6768/api/analytics/admin/audit    # → who/when accessed PII
```

**Uptime (slice 5)** — register a target and probe it (loopback needs the opt-in):
```bash
# add the playground frontend as a monitored app, then force a probe
curl -XPOST localhost:6768/api/analytics/monitored-apps -d '{"name":"PG","url":"https://example.com"}'
curl -XPOST localhost:6768/api/analytics/status/check-all
curl localhost:6768/api/analytics/status            # state / uptime% / strip / KPIs
```
(To probe a loopback URL, start the collector with `RUNTIMESCOPE_UPTIME_ALLOW_PRIVATE=1`.)

---

## 2. Droplet — live deploy

Full instructions: [`deploy/droplet-cloudflared.md`](../../deploy/droplet-cloudflared.md)
(+ [`deploy/docker-compose.prod.yml`](../../deploy/docker-compose.prod.yml),
[`deploy/Caddyfile`](../../deploy/Caddyfile)). Topology + auth: ADR-0010.

1. On the droplet: copy `deploy/.env.example` → `.env`, set `AUTH_TOKEN`
   (`openssl rand -hex 32`); optionally `ADMIN_KEY` (de-anon) and bump
   `RETENTION_DAYS` if you'll use 12-month windows.
2. `docker compose -f deploy/docker-compose.prod.yml up -d` (Caddy terminates TLS;
   only it is published — the collector binds the docker network).
3. Point an app at it. Browser SDK:
   ```ts
   RuntimeScope.init({
     appName: 'my-app',
     projectId: 'proj_...',
     // single-domain TLS DSN (ADR-0010): wss on 443, token in the DSN
     dsn: 'runtimescopes://proj_xxx:<AUTH_TOKEN>@runtimescope.yourcompany.com',
   });
   await RuntimeScope.identify({ email, role, consent: true, externalId: yourUserId });
   ```
4. Exercise the same flow as local (identify → track features → surveys). Manage
   surveys with a workspace `tk_` key (`Authorization: Bearer tk_...`), or the
   global `AUTH_TOKEN` for admin.
5. **Remote MCP** (ADR-0011): set `RUNTIMESCOPE_MCP_TRANSPORT=http` so a coding
   agent can reach the deployed collector's tools over the internet.

### What "good" looks like
- SDK connects (dashboard shows the session; `…/api/analytics/overview` non-empty
  after identify + tracks).
- ROI `$` appears once baselines exist; surveys target/suppress correctly.
- Admin de-anon is **403 without** `X-Admin-Key`, returns PII **with** it, and every
  access shows in `…/admin/audit`.
- The uptime probe records checks; `…/api/analytics/status` reflects the target's
  health; opening/closing an incident on a down→up transition.

> Security reminders (all enforced, but verify on the live box): the de-anon path
> is closed unless `ADMIN_KEY` is set; the uptime probe blocks private/metadata IPs
> unless `UPTIME_ALLOW_PRIVATE=1`; survey admin is workspace-isolated (a `tk_` key
> can't touch another tenant's surveys).

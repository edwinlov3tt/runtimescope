# @runtimescope/recon-sidecar

The **Playwright browser sidecar** for RuntimeScope's Rust collector (v0.11.0+).

The Rust `mcp-server` ports ~50 tools to pure Rust, but `scan_website` and the
browser-driven recon captures depend on **Playwright**, which is JS-only with no
production-grade Rust equivalent. Per [ADR-0007](../../docs/decisions/0007-playwright-node-sidecar.md),
the Rust collector keeps these tools by spawning this small Node process on
demand and talking to it over a **stdio JSON line protocol**.

This package is the *only* JS the Rust collector carries, isolated behind one
narrow boundary. It is **lazy** (no browser/Chromium until a request arrives),
**standalone** (no `@runtimescope/collector` imports), and **stateless across
restarts** (the parent tears it down when idle and re-spawns as needed).

```
Rust mcp-server ──spawn──▶ node dist/index.js
       │  {"id":1,"method":"scan_website","params":{...}}\n   (stdin)
       ◀──────────────────  {"id":1,"result":{...}}\n          (stdout)
```

---

## Running

```bash
npm run build -w packages/recon-sidecar      # produces dist/index.js
node packages/recon-sidecar/dist/index.js    # starts the stdio loop
```

Manual smoke test (the deliverable check):

```bash
echo '{"id":1,"method":"scan_website","params":{"url":"https://example.com"}}' \
  | node packages/recon-sidecar/dist/index.js
```

…or the scripted version (spawns the process, sends ping + scan, prints results):

```bash
npm run smoke -w packages/recon-sidecar          # defaults to https://example.com
node packages/recon-sidecar/scripts/smoke.mjs https://stripe.com
```

---

## Protocol (the contract the Rust mcp-server speaks)

A **newline-delimited JSON** request/response stream over stdio.

- The parent writes one JSON **request** object per line to the sidecar's **stdin**.
- The sidecar writes one JSON **response** object per line to its **stdout**.
- **stdout is exclusively the protocol channel.** All logs/diagnostics go to **stderr**.
- Requests are handled concurrently; responses are correlated by `id` and may
  arrive out of order. Use a unique `id` per request.

### Request

```json
{ "id": 1, "method": "scan_website", "params": { "url": "https://example.com" } }
```

| Field    | Type                     | Notes                                            |
|----------|--------------------------|--------------------------------------------------|
| `id`     | number \| string \| null | Echoed back on the response for correlation.     |
| `method` | string                   | One of the methods below.                        |
| `params` | object                   | Method-specific (see below). Optional for `ping`.|

### Response

Success:
```json
{ "id": 1, "result": { ... } }
```

Failure:
```json
{ "id": 1, "error": { "message": "..." } }
```

Invalid JSON or a request with no `method` yields `{ "id": null|<id>, "error": { "message": "..." } }`.
A failed scan/capture (bad URL, timeout, no Chromium) is returned as an `error`
response — it never crashes the process — mirroring the Node tool's
"Scan failed: …" path.

---

## Methods

Every browser method accepts these **shared navigation options** in `params`
(all optional): `viewport_width` (default 1280), `viewport_height` (default 720),
`wait_for` (`"load"` | `"networkidle"` | `"domcontentloaded"`, default
`"networkidle"`), `timeout` (ms, default 60000).

### `scan_website`
Full page scan: tech-stack detection + all six page-level recon captures.
Mirrors the Node `scan_website` tool — the `result.events` are ready to store
verbatim in the collector's event store.

`params`: `{ url, viewport_width?, viewport_height?, wait_for?, timeout? }`

`result`:
```jsonc
{
  "url": "https://example.com/",   // final URL after redirects
  "title": "Example Domain",
  "techStack": [ { "name": "...", "version": "...", "confidence": 87, "categories": [ { "id": 12, "name": "..." } ] } ],
  "events": [ /* RuntimeEvent[]: recon_metadata, recon_design_tokens, recon_layout_tree,
                 recon_accessibility, recon_fonts, recon_asset_inventory */ ],
  "summary": "Scanned: … . Tech stack: … . …",
  "scanDurationMs": 1234
}
```
The `events` array uses the exact recon event shapes from
`packages/collector/src/types.ts` (mirrored locally in `src/types.ts`). The Rust
side stores them and shapes the standard tool envelope; the `eventId` /
`sessionId` are pre-filled (`sessionId` = `scan-<ts>`).

### On-demand single captures
Each navigates to `url` in a fresh context, runs one collector, and returns the
**raw** capture (the Rust side wraps it into an event + envelope, exactly as the
Node `recon-*` tools build a synthetic event from raw data).

| Method            | `params` (besides nav opts)              | `result`                                              |
|-------------------|------------------------------------------|------------------------------------------------------|
| `computed_styles` | `{ url, selector, properties? }`         | `RawComputedStyles` (`{ selector, propertyFilter?, entries[] }`) |
| `element_snapshot`| `{ url, selector, depth? }` (depth 5)    | `RawElementSnapshot \| null` (`{ selector, depth, totalNodes, root }`) |
| `layout_tree`     | `{ url, max_depth? }` (depth 6)          | `RawLayoutTree` (`{ viewport, scrollHeight, tree, totalElements, maxDepth }`) |
| `design_tokens`   | `{ url }`                                | `RawDesignTokens`                                    |
| `accessibility`   | `{ url }`                                | `RawAccessibility`                                   |
| `fonts`           | `{ url }`                                | `RawFonts`                                           |
| `assets`          | `{ url }`                                | `RawAssets`                                          |

`properties` is a string array of CSS property names to filter to (omit for the
default visual/layout property set). The exact field shapes are defined in
`src/recon-collectors.ts`.

> **Page metadata** (`get_page_metadata`) is not a standalone method — it
> requires full tech detection, so it is produced as the `recon_metadata` event
> by `scan_website`. The Rust side should call `scan_website` to (re)populate
> metadata.

### Control methods

| Method     | `params` | `result`                                           | Effect                                  |
|------------|----------|----------------------------------------------------|-----------------------------------------|
| `ping`     | —        | `{ ok: true, version, lastScannedUrl }`            | Health check; never launches a browser. |
| `shutdown` | —        | `{ ok: true }`                                     | Closes Chromium, then exits(0).         |

The sidecar also shuts down (closes Chromium, exits 0) when **stdin closes** —
the normal teardown path when the parent process goes away.

---

## Lifecycle & laziness

- **No work at startup.** Playwright is `import()`-ed and Chromium launched only
  on the first browser method. A bare `ping` stays cheap.
- **Browser reuse + idle auto-close.** One Chromium instance is shared across
  requests and closed after **60s idle**; the next request relaunches it.
- **Concurrency.** Up to 2 browser contexts run concurrently (internal
  semaphore); excess requests queue. Responses are `id`-correlated, so the Rust
  side may pipeline requests.

---

## How Playwright's browser is obtained

This package depends on `playwright` (`^1.49.0`), which provides the automation
API. The headless **Chromium binary** is a separate download:

- **Development / in-monorepo:** `npx playwright install chromium` once. If the
  browser is missing, `scan_website` returns an `error` whose message includes
  `browserType.launch` — the documented hint is to run that install command.
- **Bundled (curl-install, Milestone 6 — per ADR-0007):** the install bundle
  ships this sidecar plus a vendored Chromium (or runs `playwright install`
  as a documented one-time post-install step). Packaging is out of scope here;
  the **architecture** (sidecar, not native Rust CDP) is what ADR-0007 fixed.

### Technology-detection database

Tech-stack detection reuses `@runtimescope/extension` (a private monorepo
package — the detection engine). Its **code** is bundled into `dist/` by tsup
(`noExternal`), so the sidecar carries the detection logic itself. The large
**data** files (`technologies.json` ≈ 2.5 MB, `categories.json` ≈ 196 KB) are
loaded from disk at runtime (`src/detection.ts` probes the monorepo layout and a
packaged `data/` sibling). For the standalone curl-install bundle these two JSON
files travel next to `dist/` (Milestone 6).

---

## What was lifted (and from where)

All logic is reused, not reinvented, from the Node collector
(`packages/mcp-server`, v0.10.13):

| Sidecar file              | Source                                              |
|---------------------------|-----------------------------------------------------|
| `src/engine.ts`           | `scanner/index.ts` (`PlaywrightScanner`)            |
| `src/signal-collector.ts` | `scanner/signal-collector.ts` (verbatim)            |
| `src/recon-collectors.ts` | `scanner/recon-collectors.ts` (verbatim)            |
| `src/event-builder.ts`    | `scanner/event-builder.ts` (collector types localized) |
| `src/types.ts`            | recon event types from `collector/src/types.ts`     |

The only behavioral additions are the stdio protocol (`src/index.ts`) and the
on-demand single-capture methods on the engine (`design_tokens`, `accessibility`,
`fonts`, `assets`, `layout_tree`), which simply expose existing collectors.

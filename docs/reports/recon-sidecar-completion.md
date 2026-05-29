# Completion note — Playwright recon sidecar (`packages/recon-sidecar`)

**Date:** 2026-05-28
**Branch:** `feat/recon-sidecar`
**Implements:** [ADR-0007](../decisions/0007-playwright-node-sidecar.md) (Hard Spot #1 in the
[Rust-Collector handoff](../handoffs/phase-rust-collector-handoff.md)).

## What shipped

A new standalone Node package, `@runtimescope/recon-sidecar` (v0.11.0, private),
that the Rust `mcp-server` spawns on demand to run `scan_website` and the
browser-driven recon captures. It is the single, narrow JS boundary the Rust
collector carries for the browser tools; everything else stays pure Rust.

- **Transport:** newline-delimited JSON over stdio — `{id, method, params}` in,
  `{id, result}` / `{id, error}` out. No HTTP, no MCP SDK (the Rust side owns
  MCP). stdout is the protocol channel; all diagnostics go to stderr.
- **Methods:** `scan_website` (full scan → 6 recon events ready to store),
  on-demand single captures (`computed_styles`, `element_snapshot`,
  `layout_tree`, `design_tokens`, `accessibility`, `fonts`, `assets`), plus
  `ping` and `shutdown` controls.
- **Lazy + self-tearing-down:** Playwright is `import()`-ed and Chromium
  launched only on the first browser request; Chromium auto-closes after 60s
  idle; the process drains in-flight work and exits when stdin closes.

The full request/response contract lives in
[`packages/recon-sidecar/README.md`](../../packages/recon-sidecar/README.md) —
that README is the spec the Rust mcp-server speaks to.

## What was lifted (reuse, not reinvent)

All scan/recon logic comes from the Node collector (`packages/mcp-server`,
v0.10.13), unchanged in behavior:

| Sidecar file              | Source                                   | Change |
|---------------------------|------------------------------------------|--------|
| `src/engine.ts`           | `scanner/index.ts` (`PlaywrightScanner`) | collector imports removed; on-demand capture methods added via a shared `withPage` helper |
| `src/signal-collector.ts` | `scanner/signal-collector.ts`            | verbatim |
| `src/recon-collectors.ts` | `scanner/recon-collectors.ts`            | verbatim |
| `src/event-builder.ts`    | `scanner/event-builder.ts`               | recon event types resolve from local `./types.js` |
| `src/types.ts`            | recon event types in `collector/src/types.ts` | mirrored locally (no collector import) |

Tech-stack detection reuses the `@runtimescope/extension` engine: its **code** is
bundled into `dist/` (tsup `noExternal`); the large **data** files
(`technologies.json` ≈ 2.4 MB, `categories.json`) are loaded from disk at runtime
(`src/detection.ts` probes monorepo + packaged layouts).

## Constraints honored

- **`crates/` untouched** — no Rust changed.
- **`packages/mcp-server/` untouched** — it still builds at v0.10.13 (verified:
  `npm run build -w packages/mcp-server` → exit 0, ESM + DTS success). The
  sidecar has **zero `@runtimescope/collector` imports**.
- **Workspaces:** `packages/recon-sidecar` added to the root `package.json`
  `workspaces` array. (Note: the existing `packages/*` glob already matched it;
  the explicit entry was added per the task constraint and npm accepts both with
  no duplicate warning — `npm install` → exit 0.)
- **Tight scope:** stdio JSON protocol + Playwright + the lifted logic only. No
  HTTP server, no MCP SDK.

## Verification

```
npm run build -w packages/recon-sidecar      # tsup → dist/index.js (~60 KB), exit 0
npx tsc --noEmit -p packages/recon-sidecar/tsconfig.json   # clean (esbuild skips types)
```

Manual smoke (the deliverable check):

```
$ echo '{"id":1,"method":"scan_website","params":{"url":"https://example.com"}}' \
    | node packages/recon-sidecar/dist/index.js
{"id":1,"result":{"url":"https://example.com/","title":"Example Domain",
  "techStack":[], "events":[recon_metadata, recon_design_tokens, recon_layout_tree,
  recon_accessibility, recon_fonts, recon_asset_inventory], ...}}
```

Result: 6 recon events with the exact collector event shapes, Chromium launched
and closed cleanly, process exited 0. Multi-request persistent-stdin runs
(`ping` + `computed_styles` + `element_snapshot`) also verified — 3 correlated
responses, clean drain on stdin close. Scripted smoke:
`npm run smoke -w packages/recon-sidecar [url]`.

## Follow-ups (not in scope here)

- **Milestone 6 packaging (per ADR-0007):** bundle the sidecar + a Chromium
  (or a documented one-time `npx playwright install`) into the curl-install
  flow, and ship the two detection data JSONs next to `dist/` (the loader
  already probes a sibling `data/` directory).
- **Rust side:** implement the child-process spawn/teardown + the stdio client
  that speaks this protocol, mapping the 9 browser tools onto these methods.

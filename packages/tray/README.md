# @runtimescope/tray

Native macOS menu-bar app for the RuntimeScope launchd collector.

The tray polls the local collector's HTTP API on `http://127.0.0.1:6768`
every 5 seconds and surfaces collector health, the active SDK session count,
and update availability — without ever opening a websocket, reading a
SQLite file, or importing collector internals.

This is **v0.1.0**, macOS only, ad-hoc signed.

## Run during development

The launchd collector must be running first (the tray has nothing to render
against otherwise):

```bash
runtimescope service status
# ✓ Service running — PID 12345
```

Then in this directory:

```bash
cargo tauri dev
```

This starts Vite on port 1420 and the Tauri shell. The tray icon appears in
the macOS menu bar; left-click toggles the dropdown.

## Build a release `.dmg`

```bash
cargo tauri build
```

Output lands at:

```
src-tauri/target/release/bundle/dmg/RuntimeScope_0.1.0_aarch64.dmg
```

Tauri ad-hoc signs the `.app` during the bundle step (`signingIdentity: "-"`
in `tauri.conf.json`). For a Developer-ID-signed release in the future,
swap the identity in the same field and add the cert to the local keychain.

## What the tray reads

Documented as a locked surface in
[`docs/specs/tray-api-surface.md`](../../docs/specs/tray-api-surface.md). The
tray will not call anything outside that list.

## Architecture

- `src/` — React webview UI (Vite, TypeScript)
- `src-tauri/src/lib.rs` — Tauri shell: tray icon, dropdown window, tokio
  polling task, IPC commands
- `src-tauri/src/collector_client.rs` — reqwest-based client for
  `/api/health`, `/api/sessions`, npm latest version
- `src-tauri/icons/` — placeholder monochrome icons (P2 v1 default — owner
  swaps for a polished icon at v1.1)
- `scripts/generate-placeholder-icons.py` — re-runnable icon generator

## Auto-updater

Disabled in v0.1.0 — the Tauri update-signing keypair (P1 prerequisite of the
Phase Tauri-Tray brief) has not been generated yet. The plugin is registered
only when `TAURI_SIGNING_PUBKEY` is set at build time, so v0.1.0 ships as a
manual-download `.dmg` on GitHub Releases. When P1 lands, set the pubkey in
`tauri.conf.json` and the env var, and the same binary picks up the updater.

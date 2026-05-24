# Phase Tauri-Tray Handoff — macOS menu-bar app for RuntimeScope

> **Audience:** the Claude Code instance running in this repo that picks up Phase Tauri-Tray.
> **You inherit a green v0.10.10.** Read this whole file before touching code.

---

## Where Phase Audit (and the v0.10.10 install-blocker exception) ended

- **Last commit:** `656e37e` — *docs: ADR-0005 (Proposed) — prefer pnpm over npm for internal tooling*
- **Last release commit:** `8d4baad` — *feat(v0.10.10): install-timeout fix + bundled dashboard + dashboard CLI*
- **Published versions on npm:**
  - `runtimescope` (CLI) → 0.10.10
  - `@runtimescope/sdk` / `server-sdk` / `workers-sdk` / `collector` / `mcp-server` → 0.10.10
  - `runtimescope` (Python, PyPI) → 0.10.10
  - Plugin (Claude marketplace) → 0.10.14
- **Test status:** 586 / 0 unit, 7 / 7 stress.
- **Gates green:** `npm run build` clean across 13 packages, `npm test` green, `npm run stress` green.
- **Smoke checks all passing:**
  - `runtimescope --version` → `0.10.10`
  - `runtimescope service install` → completes within 30s on a 40+ project machine
  - `runtimescope dashboard` → opens the now-bundled dashboard SPA in browser
  - `runtimescope dashboard --network` → detects LAN IP, opens LAN URL (after `RUNTIMESCOPE_HOST=0.0.0.0 runtimescope service install`)
  - Parent-death exit: spawn `runtimescope-mcp` then close stdin → exits in **5ms** with code 0
- **Toolchain:** Node 20+ for the collector. **Rust toolchain is NEW for this phase** — pin it in a new `rust-toolchain.toml` at the repo root.
- **Outstanding deferrals from prior phases addressed by this phase:** none directly. This phase introduces NEW work — the tray app — that doesn't depend on prior deferrals.

For the audit context that produced the now-stable Node collector, read [`../reports/phase-audit-completion-report.md`](../reports/phase-audit-completion-report.md). The strategic frame that re-ordered everything post-audit is [`../decisions/0002-rust-port-sequence-and-distribution.md`](../decisions/0002-rust-port-sequence-and-distribution.md). The operating manual is [`../../CLAUDE.md`](../../CLAUDE.md).

---

## Phase Tauri-Tray prompt (verbatim — this is your contract)

> **Goal**: ship a native macOS menu-bar app that gives me at-a-glance visibility into the RuntimeScope launchd collector — is it running? what version? how many SDK sessions? — plus one-click "update available" handling. v1 is macOS-only, ad-hoc signed for personal use.
>
> **Stack constraints**:
> - Tauri 2 (Rust shell + system webview). This is also your Rust toolchain shakedown before the larger collector port — exercise tokio, serde, reqwest patterns that the Rust collector will reuse.
> - Webview UI in React + Vite, sharing a TypeScript surface with the existing `packages/dashboard/` where it makes sense (don't refactor the dashboard; just lift components if they help).
> - Talks to the existing HTTP API on port 6768 ONLY. The tray must not read any collector internals, must not import from `@runtimescope/collector`, must not touch `~/.runtimescope/` directly. Everything goes through the existing HTTP surface.
> - The same tray binary that talks to today's Node collector must work unchanged when the Rust collector ships in Phase Rust-Collector. HTTP API stability is your design contract.
>
> **In scope (v1)**:
> - Menu-bar icon with status color: green (collector healthy), yellow (collector running but degraded — slow responses or auth errors), red (collector not responding), gray (starting up / unknown).
> - Click reveals a dropdown showing:
>   - Collector status line: `PID 12345, port 6768, uptime 12h 4m, version 0.10.10`
>   - Active SDK session count + the apps' names (e.g. `3 sessions: my-web, my-api, my-worker`)
>   - "Update Available: 0.10.10 → 0.10.11" line with a button when the running version is older than npm `runtimescope@latest`
>   - Action buttons:
>     - "Open Dashboard" → opens `http://127.0.0.1:6768/dashboard` in the default browser
>     - "Open Logs" → opens `~/.runtimescope/logs/collector.err.log` in the default `*.log` viewer (usually Console.app on macOS)
>     - "Restart Service" → shells out to `runtimescope service restart`
>     - "Update Now" (only when update available) → shells out to `runtimescope service update`
>   - "Quit Service" → unloads the launchd plist (since the CLI doesn't have a `service stop` today; add one as part of this phase if cleaner, see context §C).
>   - "Quit RuntimeScope (Tray)" → quits the tray app itself, doesn't touch the daemon.
> - Auto-update for the tray app itself via Tauri's built-in updater. Manifest published to GitHub Releases.
>
> **Out of scope (v1, defer to v2)**:
> - Linux / Windows tray support. macOS first.
> - Per-session detail views, event timeline, real-time event streaming.
> - Auto-launch the tray on macOS login (user can drag to Login Items manually for v1).
> - Notifications for collector events (errors, slow queries). Polling only.
> - Settings UI for retention days, port overrides, etc. — env vars or service-install flags continue to be the configuration surface.
> - App Store distribution. Ad-hoc signed `.dmg` on GitHub Releases is the v1 distribution path.
>
> **Hard rules**:
> 1. **The tray reads from the HTTP API only.** No file system reads of `~/.runtimescope/`, no SQLite opens, no WebSocket subscription, no importing collector internals.
> 2. **The HTTP API surface used by the tray must be documented.** Whatever endpoints you call become part of the locked wire protocol in Phase Wire-Protocol-Lock. Add them to a `docs/specs/tray-api-surface.md` (new file) so we know what to protect.
> 3. **No version bump to the collector or any existing package.** This phase ships under its own version inside `packages/tray/package.json` (start at 0.1.0); the rest of the workspace stays at 0.10.10.
> 4. **The tray app shells out to `runtimescope` for service lifecycle.** Don't reimplement `launchctl` calls inside the Rust code unless the CLI doesn't expose what you need — and if you have to, write the new CLI command first, then have the tray shell out to it. Keeps the surface area small.
> 5. **Code-signing approach:** ad-hoc only for v1 (no Developer ID required). Document the codesign command in the completion report so a future Developer-ID-based release flow knows what to swap in.
> 6. **Estimated effort: 5–7 days.** If anything feels like it's pushing past that, stop and write a SPEC QUESTION rather than absorbing scope.

---

## Context the prompt above does NOT spell out

These are landmarks you'll need but the user-facing prompt didn't include. Pulled from the source code, the master phase plan, and lessons from the audit phase.

### A. Tauri 2 menu-bar app specifics

You're building a "menu-bar-only" app — no Dock icon, no traditional window. Tauri 2's tray API is built-in (no longer a plugin like in v1).

Key Tauri configuration in `src-tauri/tauri.conf.json`:

```json
{
  "app": {
    "macOSPrivateApi": true,
    "windows": [
      {
        "label": "main",
        "decorations": false,
        "transparent": true,
        "alwaysOnTop": true,
        "visible": false,
        "width": 320,
        "height": 480
      }
    ],
    "trayIcon": {
      "iconPath": "icons/tray-icon.png",
      "iconAsTemplate": true
    }
  },
  "bundle": {
    "macOS": {
      "minimumSystemVersion": "13.0"
    }
  }
}
```

In `src-tauri/src/main.rs`, set the app's activation policy to "Accessory" so it doesn't show in the Dock:

```rust
#[cfg(target_os = "macos")]
{
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}
```

For the dropdown UI, the simplest pattern: a `TrayIconBuilder` with an `on_tray_icon_event` that toggles the main window's visibility, positioned anchored to the tray icon. The `tauri-plugin-positioner` plugin handles anchoring properly across multi-display setups.

### B. HTTP endpoints the tray must call

The currently-published Node collector at v0.10.10 exposes these endpoints on `http://127.0.0.1:6768`. These are what the tray polls (every 5s default; tune later if needed).

| Endpoint | Auth | Response shape | Used for |
|---|---|---|---|
| `GET /api/health` | none | `{ status: "ok", version: "0.10.10", timestamp: ..., uptime: 12345, sessions: 3, authEnabled: false }` | Status color + version + uptime |
| `GET /api/sessions` | yes (if authEnabled) | `{ data: [{ sessionId, appName, projectName, isConnected: true, ... }] }` | Active session list + app names |
| `GET /readyz` | none | `200 { status: "ready" }` during normal operation; `503 { status: "starting" }` during warm-up | Could use as alternative to /api/health, but health is richer |
| `https://registry.npmjs.org/runtimescope/latest` | none | `{ version: "0.10.10" }` | Update check; compare against /api/health's version |

Example fetch in Rust via reqwest:

```rust
let health: serde_json::Value = reqwest::Client::new()
    .get("http://127.0.0.1:6768/api/health")
    .timeout(std::time::Duration::from_millis(1500))
    .send().await?
    .json().await?;
```

**Polling strategy**: 5s interval. Use `tokio::time::interval` with a cancellation token so the polling cleanly stops when the tray quits. **Do NOT keep the event loop alive forever** — the same `.unref()` discipline from Phase Audit applies here, just in tokio terms: tokio tasks should be tied to the app's lifetime, not orphaned.

**Error handling**: if `/api/health` 5xx's or times out, status goes red. If it succeeds but `authEnabled: true` and you don't have a token, you'll get 401 on `/api/sessions` — surface that as yellow ("authenticated endpoints unreachable") with a note about adding an API key.

### C. Lifecycle commands — what the CLI already exposes vs. what you may need to add

Today's `runtimescope` CLI ([packages/cli/src/service.ts](../../packages/cli/src/service.ts)):

| Command | What it does | Tray usage |
|---|---|---|
| `runtimescope service install` | Writes plist, `launchctl load` | Not used directly by tray |
| `runtimescope service uninstall` | `launchctl unload`, deletes plist | Tray's "Quit Service" — but this REMOVES the plist, not just stops |
| `runtimescope service status` | Prints PID + version | Tray reads HTTP API instead; faster |
| `runtimescope service restart` | `launchctl unload && launchctl load` | Tray's "Restart Service" — shells out |
| `runtimescope service update` | `npm install -g runtimescope@latest && service install` | Tray's "Update Now" — shells out |
| `runtimescope service logs` | Tails `~/.runtimescope/logs/*.err.log` | Tray's "Open Logs" should open the file in Console.app, not run this |

**Missing command you'll likely want**: `runtimescope service stop` — unloads the plist without deleting it, so the service is dormant but reinstall-free. Add this. It's a 10-line change to [`service.ts`](../../packages/cli/src/service.ts), then the tray's "Quit Service" shells out to it cleanly. If you DON'T add it, the tray would either invoke `launchctl unload` directly (breaking the "shell out for lifecycle" rule above) or use `service uninstall` (which removes the plist, requiring a full reinstall — wrong UX).

Adding `service stop` is allowed scope for this phase. It's the same shape as the existing commands, just the unload-without-delete path.

### D. macOS code signing for v1 (ad-hoc only)

**No Developer ID required.** Ad-hoc signing is the local-keychain identity; macOS Gatekeeper will warn on first launch but the user can right-click → Open to override.

The Tauri build will produce `RuntimeScope.app`. Sign with:

```bash
codesign --sign - --force --deep --options runtime RuntimeScope.app
```

For Tauri's bundled `.dmg`, the sign happens during `tauri build` if you configure it in `src-tauri/tauri.conf.json`:

```json
{
  "bundle": {
    "macOS": {
      "signingIdentity": "-"
    }
  }
}
```

(The `-` means ad-hoc. When the project gets a Developer ID Application certificate, this becomes `"Developer ID Application: Edwin Lovett (TEAMID)"`.)

For Tauri's auto-updater, the update manifest at `https://github.com/edwinlov3tt/runtimescope/releases/.../updater.json` needs the new build's pubkey hash. Generate via `tauri signer generate` once, store the public key in `tauri.conf.json` and the private key as a GitHub Actions secret (`TAURI_SIGNING_PRIVATE_KEY`). The signing here is for the *update* signature, not macOS code signing — different keys, both needed.

### E. What NOT to touch

- **`packages/collector/`** — locked. The HTTP API is your contract; the implementation is not yours to modify.
- **`packages/mcp-server/`** — out of scope for the tray.
- **`packages/sdk/`, `packages/server-sdk/`, `packages/workers-sdk/`, `packages/nextjs/`, `packages/remix/`, `packages/sveltekit/`, `packages/vite/`, `packages/python-sdk/`** — out of scope.
- **`packages/cli/`** — touch ONLY to add `runtimescope service stop` (and its CLI dispatch + help text). Do not change existing behavior.
- **`packages/dashboard/`** — read-only reference. You may lift component patterns into the tray's UI but do not modify the dashboard package.
- **`docs/specs/wire-protocol.md`** — does NOT exist yet. Phase Wire-Protocol-Lock writes it. You DO write `docs/specs/tray-api-surface.md` as an *input* to that future spec (per hard rule 2).

---

## Pointers to existing files you will most likely touch

| Why you might touch it | File | Phase action |
|---|---|---|
| Adding `runtimescope service stop` | [`../../packages/cli/src/service.ts`](../../packages/cli/src/service.ts) | Add stop function + dispatch case; small mirror of `restart` minus the load step |
| CLI help text gains "service stop" | [`../../packages/cli/src/cli.ts`](../../packages/cli/src/cli.ts) | One line in `printHelp()` |
| Lift status icon, session list, version badge patterns | [`../../packages/dashboard/src/`](../../packages/dashboard/src/) | Read-only reference for React component shapes |
| `npm install` adds new workspace | [`../../package.json`](../../package.json) — root | Add `"packages/tray"` to the workspaces array |

**Files you will CREATE:**

```
packages/tray/
├── package.json                    workspace member at 0.1.0
├── tsconfig.json                   extends root
├── vite.config.ts                  React + Vite for the webview UI
├── src/                            React UI (TS)
│   ├── main.tsx
│   ├── App.tsx
│   ├── components/
│   │   ├── StatusBadge.tsx
│   │   ├── SessionList.tsx
│   │   ├── UpdateBanner.tsx
│   │   └── ActionButtons.tsx
│   └── hooks/
│       └── useCollectorHealth.ts   the 5s polling hook
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   ├── src/
│   │   ├── main.rs                 tray icon, window, lifecycle
│   │   └── collector_client.rs     reqwest calls to /api/health and friends
│   ├── icons/
│   │   ├── tray-icon.png           16x16 template (monochrome, alpha)
│   │   └── tray-icon@2x.png        32x32 retina
│   └── build.rs
├── README.md
└── rust-toolchain.toml             (or pin at the repo root — see context §A)

docs/specs/tray-api-surface.md       new file — documents every HTTP endpoint
                                     the tray calls; input to Phase
                                     Wire-Protocol-Lock
```

---

## Reproducible commands you can rely on

These all exit 0 today on the inherited HEAD (`656e37e`). They are the ground state your work must preserve.

```bash
cd /Users/edwinlovettiii/runtimescope
npm install                          # restores tree
npm run build                        # all 13 workspace packages build clean
npm test                             # 586 / 0
npm run stress                       # 7 / 7 scenarios
node packages/cli/dist/cli.js --version  # → 0.10.10
runtimescope service status          # ✓ Service running (PID + version + uptime)
curl -fsS http://127.0.0.1:6768/api/health  # the contract you'll consume
```

Once you've started Phase Tauri-Tray, you'll also need:

```bash
# Rust toolchain — pin to a known good version
rustup toolchain install 1.83.0
echo 'channel = "1.83.0"' > rust-toolchain.toml   # at repo root (or packages/tray/)

# Tauri 2 CLI (install once, used by every Tauri project)
cargo install create-tauri-app
cargo install tauri-cli --version "^2.0.0"

# Inside packages/tray/:
cd packages/tray
npm install                          # webview-side deps (React, Vite)
cargo tauri dev                      # hot-reload dev mode — should show tray icon
cargo tauri build                    # produces target/release/bundle/dmg/RuntimeScope_*.dmg
```

---

## Final checklist before you call Phase Tauri-Tray done

- [ ] Every item in the prompt's "In scope (v1)" list is implemented.
- [ ] HTTP API used is documented in [`docs/specs/tray-api-surface.md`](../specs/tray-api-surface.md) (per hard rule 2).
- [ ] `runtimescope service stop` exists and is what the tray's "Quit Service" shells out to.
- [ ] All 586 existing unit tests still pass.
- [ ] All 7 stress scenarios still pass.
- [ ] `npm run build` exits clean across the existing 13 packages AND the new `packages/tray`.
- [ ] `cargo tauri build` produces a signed `.dmg` (ad-hoc signing is fine).
- [ ] Smoke check: install the `.dmg` on the project owner's primary machine, see correct status for the running launchd collector. Test all action buttons.
- [ ] Tauri auto-update channel configured — manifest hosted on GitHub Releases, public key in `tauri.conf.json`.
- [ ] No collector / mcp-server / SDK changes (per hard rule 3).
- [ ] No bump to any existing package's version (per hard rule 3).
- [ ] Completion report written at [`../reports/phase-tauri-tray-completion-report.md`](../reports/phase-tauri-tray-completion-report.md) following [`../templates/phase-completion-report.md`](../templates/phase-completion-report.md).
- [ ] CURRENT_STATE.md updated to reflect Phase Tauri-Tray shipped.
- [ ] HANDOFF.md updated to point at Phase Wire-Protocol-Lock as the next active phase.

If you are uncertain at any point, the resolution order is:

1. The Phase Tauri-Tray prompt above.
2. [`../reports/phase-audit-completion-report.md`](../reports/phase-audit-completion-report.md) — for what the v0.10.9/0.10.10 baseline contains.
3. [`../decisions/0002-rust-port-sequence-and-distribution.md`](../decisions/0002-rust-port-sequence-and-distribution.md) — for the strategic frame.
4. [`../decisions/0001-audit-then-rust.md`](../decisions/0001-audit-then-rust.md) — for the original rationale.
5. [`../audits/0001-collector-process-lifetime.md`](../audits/0001-collector-process-lifetime.md) — for the lessons learned that informed the current Node collector's behavior.
6. [`../../CLAUDE.md`](../../CLAUDE.md) operating manual.
7. Anything else.

If those still don't resolve it: stop, write a SPEC QUESTION in the chat, and wait. Do not guess at scope, do not absorb requirements that aren't in the prompt, and do not ship "while I'm here" cleanup that touches files outside `packages/tray/` and `packages/cli/src/service.ts` (for the `service stop` addition).

---

## Notes from the handing-off session

- **The HTTP API surface is the contract**, not the prompt's wording. Two endpoints you'll lean on hardest: `/api/health` (status + version + uptime + session count) and `/api/sessions` (per-session detail). Both are stable across v0.10.x and will be the contract for the Rust port.
- **Tauri 2 is a fresh API** — be careful with tutorials/StackOverflow answers that target Tauri 1 (the tray API moved from plugin to core, the activation policy mechanism changed, the window decoration API renamed). The Tauri 2 docs at tauri.app are the source of truth.
- **The user is on macOS 26.4 (Tahoe)**. Tray icon templates need both regular and @2x versions for retina; macOS 14+ also handles dark/light mode automatically if `iconAsTemplate: true` is set.
- **Don't overthink the polling rate**. 5s is generous. Tighter polling adds nothing for a status app where the underlying state changes on human timescales (collector restarts, SDK connections). Burns laptop battery for no benefit.
- **`runtimescope service stop` should be straightforward** — look at the existing `restartLaunchd()` function in [service.ts](../../packages/cli/src/service.ts); strip the load step at the end and you have stop. Similar for systemd (Linux).
- The project owner is the only user. If a design tension comes up, optimize for their flow first: persistent collector, multi-machine dev workflow, frequent Claude Code restarts that previously left zombie MCP servers (now fixed in v0.10.8). The tray exists to give them confidence the collector is alive without having to run CLI commands.
- The Rust patterns you establish here (tokio polling tasks with cancellation, reqwest HTTP client with timeouts, serde for JSON deserialization, structured logging via `tracing`) all carry directly into Phase Rust-Collector. Use this phase as the toolchain shakedown the master plan calls it.

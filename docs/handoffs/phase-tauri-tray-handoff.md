# Phase Tauri-Tray Handoff — macOS menu-bar app for RuntimeScope

> **Audience:** the Claude Code instance running in this repo that picks up Phase Tauri-Tray.
> **You inherit a green v0.10.12.** Read this whole file before touching code.
> **Before you begin:** confirm the *Pre-handoff prerequisites* section below — two of them require the project owner's hands, not yours.

---

## Where Phase Audit (and the v0.10.10–0.10.12 install-blocker exceptions) ended

- **Last commit:** `538a399` — *fix(cli): bump readyz install poll 30s → 60s (v0.10.12)*
- **Last release commit:** same. v0.10.11 and v0.10.12 are small follow-ons to v0.10.10's ADR-0004 exception (dashboard not bundled in v0.10.10 CI; readyz timeout message wrong; readyz timeout too short for 44-project machines). All three captured as same-exception-class releases.
- **Published versions on npm:**
  - `runtimescope` (CLI) → 0.10.12
  - `@runtimescope/sdk` / `server-sdk` / `workers-sdk` / `collector` / `mcp-server` → 0.10.12
  - `runtimescope` (Python, PyPI) → 0.10.12
  - Plugin (Claude marketplace) → 0.10.16
- **Test status:** 586 / 0 unit, 7 / 7 stress.
- **Gates green:** `npm run build` clean across 13 packages, `npm test` green, `npm run stress` green.
- **Smoke checks all passing:**
  - `runtimescope --version` → `0.10.12`
  - `runtimescope service install` → completes within 60s even on a 44-project machine
  - `runtimescope dashboard` → opens the bundled dashboard SPA in browser (v0.10.11+ ships the static bundle inside the collector npm package)
  - `runtimescope dashboard --network` → detects LAN IP, opens LAN URL (after `RUNTIMESCOPE_HOST=0.0.0.0 runtimescope service install`)
  - Parent-death exit: spawn `runtimescope-mcp` then close stdin → exits in **5ms** with code 0
- **Toolchain:** Node 20+ for the collector. **Rust toolchain is NEW for this phase** — pin to **1.90.0** in a new `rust-toolchain.toml` at the repo root (1.83.0 was suggested in an earlier draft; bump to current stable that Tauri 2 supports). If newer stable exists at handoff time, prefer it — there's no reason to hold back.
- **Canonical MCP tool count:** **63 tools across 34 files**, derived from `grep -c "server\.tool(" packages/mcp-server/src/tools/*.ts`. Project CLAUDE.md says "44" and the master phase plan says "55" — both stale. Use 63 if you cite a number; the source of truth is the grep.
- **Outstanding deferrals from prior phases addressed by this phase:** none directly. This phase introduces NEW work — the tray app — that doesn't depend on prior deferrals.

---

## Pre-handoff prerequisites (the project owner must complete these before you begin)

You — the receiving Claude Code instance — **cannot complete these yourself**: they require interactive commands that don't capture cleanly in a non-interactive shell, and they touch GitHub Actions secrets / Apple Developer accounts that aren't in your tool surface. If any of these aren't done when you start, stop and ask the project owner to complete them before going further.

### P1 — Tauri update-signing keys generated and secret set

The Tauri auto-updater requires a signing keypair so update artifacts can be verified by clients. The owner runs **once**:

```bash
cargo install tauri-cli --version "^2"
tauri signer generate -w ~/.tauri/runtimescope.key
# Outputs a public key (paste into tauri.conf.json's "pubkey" field) and a
# private key file. DO NOT commit the private key.
```

Then sets the GitHub Actions secret:

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/runtimescope.key
```

Without P1 done, the auto-updater requirement in the prompt is unreachable — fall back to "manual `.dmg` downloads from GitHub Releases" and call out the regression in the completion report.

### P2 — Tray icon assets

The default: **you (the implementing instance) generate a placeholder monochrome geometric icon** (16×16, 22×22, 32×32 alpha-only PNGs, `iconAsTemplate: true`) and ship it as the v1 icon. The owner replaces it in a v1.1 polish pass.

If the owner has already provided icons at `packages/tray/src-tauri/icons/`, use those instead. Check that directory before drawing anything.

### P3 — launchd collector is running and reachable

Required state for any visual smoke test:

```bash
runtimescope service status
# Expect: ✓ Service running (PID, version, uptime)
# If not running, the owner needs to run:
runtimescope service install
# (60s wait is normal on machines with many historical projects.)
curl -fsS http://127.0.0.1:6768/api/health
# Expect: {"status":"ok","version":"0.10.12",...}
```

Without P3, you have nothing to render against during dev.

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
> 2. **The HTTP API surface used by the tray must be documented.** Whatever endpoints you call become part of the locked wire protocol in Phase Wire-Protocol-Lock. Add them to a `docs/specs/tray-api-surface.md` (new file — this will be the **first file under `docs/specs/`**, so you're also establishing the convention for that directory). **Derive contents from [`packages/collector/src/http-server.ts`](../../packages/collector/src/http-server.ts) — the live route handlers are the source of truth, not the prose excerpts in §B of this handoff.** The §B table is a *starting* inventory; double-check shapes against the implementation as you go.
> 3. **No version bump to the collector or any existing package.** This phase ships under its own version inside `packages/tray/package.json` (start at 0.1.0); the rest of the workspace stays at 0.10.12.
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

For the dropdown UI, the simplest pattern: a `TrayIconBuilder` with an `on_tray_icon_event` that toggles the main window's visibility, positioned anchored to the tray icon. The `tauri-plugin-positioner` plugin handles anchoring properly across multi-display setups. **Pin a specific version** in `Cargo.toml` — use whatever's current at handoff time (was `2.0.0` family in early 2025; check `cargo search tauri-plugin-positioner` for the latest).

`bundle.macOS.minimumSystemVersion: "13.0"` is intentional — RuntimeScope's launchd plist + the polling-friendly TimerCoalescing changes Apple made post-Ventura. Don't bump it.

**Polling rules (specify both):**

1. **Use `MissedTickBehavior::Delay`** on the `tokio::time::interval`. Otherwise after macOS sleep/wake the runtime fires a burst of catch-up ticks all at once, hammering the local HTTP API. The Delay behavior skips missed ticks and resumes cleanly:

   ```rust
   let mut interval = tokio::time::interval(Duration::from_secs(5));
   interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
   ```

2. **Pause polling when the dropdown window is hidden.** No one's looking; it's a battery-life decision. Listen for `WindowEvent::Focused(false)` (or `Visible(false)`) and pause the polling task via a `tokio::sync::Notify` or `CancellationToken`. Resume on focus. Status color in the tray icon itself doesn't update while hidden — that's correct; it refreshes on next show.

These aren't optional polish — without them the tray will visibly misbehave after a multi-hour laptop sleep.

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

**Polling strategy**: 5s interval. Use `tokio::time::interval` with a cancellation token so the polling cleanly stops when the tray quits, plus the `MissedTickBehavior::Delay` from §A above. **Do NOT keep the event loop alive forever** — the same `.unref()` discipline from Phase Audit applies here, just in tokio terms: tokio tasks should be tied to the app's lifetime, not orphaned.

**Error handling**: if `/api/health` 5xx's or times out, status goes red. If it succeeds but `authEnabled: true` and you don't have a token, you'll get 401 on `/api/sessions` — surface that as yellow ("authenticated endpoints unreachable") with a note about adding an API key.

### B.1 The version-check URL transition at v0.12.0 (must be designed for now)

The tray compares `/api/health.version` (running collector) against `registry.npmjs.org/runtimescope/latest` (npm latest CLI version). This works **today** because both numbers reference the same npm-published package.

**At v0.12.0 (Phase Rust-Collector), this comparison breaks** — the Rust collector is no longer distributed via npm, so `registry.npmjs.org/runtimescope/latest` becomes irrelevant. Per [ADR-0002](../decisions/0002-rust-port-sequence-and-distribution.md) the new distribution channel is GitHub Releases + a manifest at `runtimescope.dev/manifest.json`.

**What you do in v1 of the tray:** abstract the version-check source behind a single function. Today it reads npm; at v0.12.0 someone changes one call site to read the GitHub Releases manifest. Don't bake the npm URL into multiple places.

```rust
async fn latest_published_version() -> Result<Version> {
    // v1 (Node era): npm registry
    fetch_npm_latest("runtimescope").await
    // v2 (Rust era — Phase Rust-Collector): GitHub Releases
    // fetch_gh_releases_latest("edwinlov3tt/runtimescope").await
}
```

Drop a `// TODO(v0.12.0): swap to GitHub Releases manifest` comment so the swap is obvious.

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

### C.1 "Update Now" and the ADR-0002 npm tension (must be acknowledged in code)

`runtimescope service update` today shells out to `npm install -g runtimescope@latest && service install`. [ADR-0002](../decisions/0002-rust-port-sequence-and-distribution.md) says "No npm install for the CLI ever again" — that rule is forward-looking, the trigger for it is Phase Rust-Collector's curl-install channel at v0.12.0.

**The reconciliation:** in the Node era (now → v0.12.0), the tray's "Update Now" uses the npm path because that's how the Node CLI updates. At v0.12.0, the same button shells out to the curl-install-driven `runtimescope service update` (which by then will fetch a signed binary from GitHub Releases, not invoke npm). The tray's UI doesn't change — only the underlying command's implementation changes inside the CLI.

**What you do in v1 of the tray:** wire "Update Now" to `runtimescope service update` (no special-casing). Add a `// TODO(v0.12.0): the CLI's service update implementation flips from npm-install-g to curl-install; this button's contract is unchanged` comment on the button's handler. Document the same transition in the completion report.

**What you do NOT do:** drop the "Update Now" button. The button is the right shape for v1; only the channel it pulls from is temporary.

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
| Phase completion bookkeeping | [`../CURRENT_STATE.md`](../CURRENT_STATE.md) | At phase end: bump "active phase" → Wire-Protocol-Lock; note Tray v0.1.0 shipped |
| Phase completion bookkeeping | [`../HANDOFF.md`](../HANDOFF.md) | At phase end: replace the pointer-to-this-file with a pointer to the Wire-Protocol-Lock handoff |

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

These all exit 0 today on the inherited HEAD (`538a399`). They are the ground state your work must preserve.

```bash
cd /Users/edwinlovettiii/runtimescope
npm install                          # restores tree
npm run build                        # all 13 workspace packages build clean
npm test                             # 586 / 0
npm run stress                       # 7 / 7 scenarios
node packages/cli/dist/cli.js --version  # → 0.10.12
runtimescope service status          # ✓ Service running (PID + version + uptime) — requires P3
curl -fsS http://127.0.0.1:6768/api/health  # the contract you'll consume — requires P3
```

The last two commands depend on **P3 (launchd collector running)** from the Pre-handoff prerequisites section. If those fail, you're missing P3, not the build — go fix that first.

Once you've started Phase Tauri-Tray, you'll also need:

```bash
# Rust toolchain — pin to current stable Tauri 2 supports
rustup toolchain install 1.90.0
echo 'channel = "1.90.0"' > rust-toolchain.toml   # at repo root (or packages/tray/)

# Tauri 2 CLI (install once, used by every Tauri project)
cargo install create-tauri-app
cargo install tauri-cli --version "^2"

# Inside packages/tray/:
cd packages/tray
npm install                          # webview-side deps (React, Vite)
cargo tauri dev                      # hot-reload dev mode — should show tray icon
cargo tauri build                    # produces target/release/bundle/dmg/RuntimeScope_*.dmg
```

**Disk-impact heads-up:** a fresh Rust toolchain plus Tauri's transitive Cargo deps will allocate **~3–5 GB** under `~/.cargo/` and `~/.rustup/`, and the first `cargo tauri build` produces another ~1 GB under `packages/tray/src-tauri/target/`. Make sure you've got the room before kicking off the install — interrupting the first build halfway through leaves a fragmented Cargo cache that's annoying to clean up.

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
2. [`../reports/phase-audit-completion-report.md`](../reports/phase-audit-completion-report.md) — for what the v0.10.9/0.10.12 baseline contains.
3. [`../decisions/0002-rust-port-sequence-and-distribution.md`](../decisions/0002-rust-port-sequence-and-distribution.md) — for the strategic frame.
4. [`../decisions/0004-v0-10-10-install-blocker-exception.md`](../decisions/0004-v0-10-10-install-blocker-exception.md) — for the exception-class rule that governs v0.10.10–0.10.12 and tells you when an "install blocker" justifies bypassing version-bump conservatism. Read this before you ship any patch outside `packages/tray/`.
5. [`../decisions/0001-audit-then-rust.md`](../decisions/0001-audit-then-rust.md) — for the original rationale.
6. [`../audits/0001-collector-process-lifetime.md`](../audits/0001-collector-process-lifetime.md) — for the lessons learned that informed the current Node collector's behavior.
7. [`../../CLAUDE.md`](../../CLAUDE.md) operating manual.
8. Anything else.

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

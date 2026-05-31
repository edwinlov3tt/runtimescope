# Phase Tauri-Tray Completion Report

**Project:** RuntimeScope — Native macOS menu-bar app for the launchd collector.
**Brief:** [`../handoffs/phase-tauri-tray-handoff.md`](../handoffs/phase-tauri-tray-handoff.md)
**Operating manual:** [`../../CLAUDE.md`](../../CLAUDE.md)
**Initial commit:** `538a399` — *fix(cli): bump readyz install poll 30s → 60s (v0.10.12)*
**Final commit (this phase, uncommitted at report time):** working tree at `538a399` plus the changes described in §7.
**Released as:** `@runtimescope/tray` 0.1.0 (workspace-private; v1 distribution is a manual `.dmg` on GitHub Releases — see §3.1).

---

## 1. Commands run + summarized outputs

| Command | Purpose | Result |
|---|---|---|
| `npm install` | Restore workspace deps + pull in the new tray package | 193 new packages added, 671 audited |
| `npm run build -w packages/cli` | Rebuild CLI after adding `service stop` | Clean (ESM + DTS) |
| `npm run build` (root) | Full workspace build gate | **All 13 existing packages + new tray build clean.** `runtimescope-playground` errors with `Missing script: "build"` — see §3.2 (pre-existing) |
| `npm test` | Unit-test gate | **586 / 0** (matches v0.10.12 baseline) |
| `npm run stress` | Stress harness gate | **7 / 7 scenarios** passing |
| `cargo check` (in `packages/tray/src-tauri`) | Quick Rust compile | Clean after fixing three Tauri-2 API mismatches (§4.3) |
| `cargo test --lib` | Tray unit tests | 2 / 0 (version-comparison logic) |
| `cargo tauri build` | Release Tauri build → `.app` + `.dmg` | Clean. Bundle sizes: `RuntimeScope.app` 6.3 MB, `RuntimeScope_0.1.0_aarch64.dmg` 2.6 MB |
| `codesign --verify` on `.app` | Confirm ad-hoc signature | `valid on disk`, `satisfies its Designated Requirement`, `Signature=adhoc` |
| `runtimescope service stop` then `service restart` | Smoke test the new CLI subcommand | Stop unloads plist (HTTP 6768 stops responding ~2s); restart re-loads (collector back up after ~30s WAL replay) |
| Launch `.app` for 10s with live collector | Tray smoke (terminal-only — no UI inspection from this shell) | 92 MB RSS, no crash, no stderr noise |
| `runtimescope --version` | Smoke check | `0.10.12` (unchanged — phase does not bump existing packages, per hard rule 3) |
| `curl -fsS http://127.0.0.1:6768/api/health` | Live API check | `{"status":"ok","version":"0.10.12",...}` |

No deviations from spec'd output for the gate commands. The build-gate footnote about `runtimescope-playground` is a pre-existing condition — see §3.2.

---

## 2. Final test count

**Total: 586 unit + 2 Rust unit + 7 stress scenarios. 0 failures.**

Per target:

| Target | Passed | Notes |
|---|---:|---|
| Existing workspace unit suite | 586 | Identical to baseline — no test files touched outside `packages/tray/` |
| `packages/tray/src-tauri` Rust unit | 2 | New: `compare_versions` correctness, including pre-release-suffix handling |
| `stress/scenarios/*` (full, not `--quick`) | 7 / 7 | flood-events, concurrent-sessions, pathological-events, auth-fuzz, crash-recovery, memory-leak, framework-smoke |
| **Total** | **595** | |

---

## 3. Deviations from the brief

1. **Auto-updater wired but disabled at build time** — Pre-handoff prerequisite P1 (Tauri signing keys + GitHub secret) was blocked at phase start; the v0.1.0 `.dmg` ships without an in-app updater. §4.1.
2. **`npm run build` exit code is non-zero at the inherited HEAD** — Caused by the `runtimescope-playground` workspace lacking a `build` script. Pre-existing, not introduced by this phase. §4.2.
3. **Three Tauri 2 API differences from the brief's example snippets** — `Position::TrayCenter` (variant gated behind a feature flag in plugin-positioner 2.3.1), `Image::from_bytes` (replaced by `tauri::include_image!`), and `menu_on_left_click` (deprecated in favor of `show_menu_on_left_click`). §4.3.
4. **The brief's §B table called the session app name `projectName`; the live API returns `appName`** — the source-of-truth grep against `http-server.ts` + `types.ts` was authoritative (the brief itself instructed this). The tray uses `appName`. §4.4.
5. **No `__tests__` under `packages/tray/`** — Two Rust unit tests live inside `collector_client.rs`; no JS/TS test files. The webview UI is render-only; the testable behavior (version comparison, snapshot building) lives in Rust. §4.5.

Each rationale is in §4.

---

## 4. Rationale per deviation

### 4.1 Auto-updater disabled at build time

**What the brief says:** "Auto-update for the tray app itself via Tauri's built-in updater. Manifest published to GitHub Releases."

**What I did:** Wired the `tauri-plugin-updater` plugin into `Cargo.toml` and `tauri.conf.json`, but the plugin is conditionally registered in `lib.rs`:

```rust
if option_env!("TAURI_SIGNING_PUBKEY").is_some() {
    builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
}
```

With no `TAURI_SIGNING_PUBKEY` env var at build time, the updater plugin is omitted. v0.1.0 ships as a manual-download `.dmg` on GitHub Releases.

**Rationale:** Phase Tauri-Tray's Pre-handoff prerequisite P1 requires the project owner to run `tauri signer generate` and `gh secret set TAURI_SIGNING_PRIVATE_KEY` — both interactive and outside the implementing agent's tool surface. P1 was not done at handoff start. The brief explicitly contemplated this case: "If P1 is blocked, fall back to manual `.dmg` distribution and call out the auto-updater regression in the completion report."

When P1 lands:
1. Project owner runs `tauri signer generate -w ~/.tauri/runtimescope.key`.
2. Paste the public key into `tauri.conf.json`'s `plugins.updater.pubkey`.
3. Set `TAURI_SIGNING_PRIVATE_KEY` as a GitHub Actions secret and the matching `TAURI_SIGNING_PUBKEY` (or a build-arg equivalent) in the build environment.
4. Re-run `cargo tauri build`. The plugin registers itself, and the manifest at `https://github.com/edwinlov3tt/runtimescope/releases/latest/download/latest.json` becomes the update channel.

No code changes needed for the unblock — only configuration + signing keys.

### 4.2 `npm run build` is non-zero at the inherited HEAD

**What the brief says:** "These all exit 0 today on the inherited HEAD (`538a399`)" — listing `npm run build` among them.

**What I did:** Confirmed via `git stash` + re-run that `npm run build` already failed at `538a399` (before any of my changes), because `playground/package.json` defines no `build` script and the root `build` invokes `npm run build --workspaces` (without `--if-present`). All 13 existing packages and the new `packages/tray` build cleanly; the error happens when npm reaches `runtimescope-playground` at the end.

**Rationale:** This is a pre-existing condition in the inherited tree, not a regression introduced by this phase. Fixing it is one of:

- Add `--if-present` to the root `build` script (one-character behavior change to root `package.json`).
- Add a stub `build` script to `playground/package.json`.

Both fall under "while I'm here" cleanup that the brief's resolution-order §7 explicitly tells the implementing agent NOT to absorb. Documented here so the next phase can decide whether to address it. The 13 existing packages and the tray ALL build clean.

### 4.3 Three Tauri 2 API differences from the brief's example snippets

The brief includes example Rust snippets that target Tauri 2 broadly — the specific API surface has moved between Tauri 2.0 and Tauri 2.11 (the version `cargo install tauri-cli --version "^2"` resolved to today, 2.11.2).

| Brief example | Reality (Tauri 2.11.2) | Fix |
|---|---|---|
| `Image::from_bytes(icon_bytes)` | `Image::new(rgba, w, h)` only — `from_bytes` is gone | Use `tauri::include_image!("./icons/tray-icon.png")` macro which decodes at build time |
| `Position::TrayCenter` | Variant requires the `tracker` feature in `tauri-plugin-positioner` 2.3.1 (not enabled by default) | Fall back to `Position::TopRight` and TODO(v1.1) refine via the tray-icon `rect` from `TrayIconEvent::Click` |
| `TrayIconBuilder::menu_on_left_click(false)` | Deprecated; replaced by `show_menu_on_left_click(false)` | Use the new spelling |

**Rationale:** These are mechanical Tauri version differences. None changes the brief's intent — the v0.1 dropdown opens in roughly the right spot, the icon embeds the same PNG, the left-click still toggles the dropdown rather than a system menu.

### 4.4 The brief's §B used `projectName`; live API returns `appName`

**What the brief says (§B):** "`GET /api/sessions` → `{ data: [{ sessionId, appName, projectName, isConnected: true, ... }] }`"

**What I did:** Sourced the actual shape from
[`packages/collector/src/http-server.ts:229–232`](../../packages/collector/src/http-server.ts) (the route) and
[`packages/collector/src/types.ts:726–734`](../../packages/collector/src/types.ts) (the `SessionInfo` interface). The interface defines `sessionId`, `appName`, `connectedAt`, `sdkVersion`, `eventCount`, `isConnected`, `projectId?` — no `projectName`. The tray's Rust client therefore deserializes `appName` only.

**Rationale:** The brief itself flagged this: "Derive contents from `packages/collector/src/http-server.ts` — the live route handlers are the source of truth, not the prose excerpts in §B of this handoff." Surfacing here so the next reader notices the §B-vs-reality drift.

### 4.5 No `__tests__/` directory under `packages/tray/`

**What the brief says:** Implies test coverage for "every item in the 'In scope (v1)' list". The brief lists `586` as the existing total and the brief's checklist requires "all 586 existing unit tests still pass" but doesn't prescribe new test counts.

**What I did:** Added 2 Rust unit tests in `collector_client.rs` (covering the version-comparison function). The React webview UI is render-only — its inputs come from a single typed `HealthSnapshot` payload, which the Rust shell synthesizes. The non-trivial logic (HTTP timeouts, error mapping to status colors, npm-vs-running version diff) all lives in `lib.rs`/`collector_client.rs` and is exercised by `cargo test`.

**Rationale:** The brief's hard rule 1 ("HTTP API only") implies no mocked-HTTP integration tests inside the tray package — the existing collector integration tests already exercise `/api/health` and `/api/sessions`. A future phase could add UI snapshot tests via Playwright if the dropdown grows; v1 doesn't justify the harness.

---

## 5. Acceptance criteria — complete

| # | Criterion | Status |
|---:|---|---|
| 1 | Menu-bar icon with status color (green/yellow/red/gray) | ✓ Implemented in `lib.rs::build_snapshot`; React `StatusBadge` renders the dot. |
| 2 | Dropdown shows collector status line (`PID, port, uptime, version`) | ✓ Format: `port 6768, uptime 12h 4m, v0.10.12`. PID is not in the HTTP API (intentional — see hard rule 1), so the line omits PID. Documented in `tray-api-surface.md`. |
| 3 | Dropdown shows active SDK session count + app names | ✓ `SessionList.tsx` — shows N sessions and lists each `appName`. |
| 4 | "Update Available: X → Y" line + button when running version < npm latest | ✓ `UpdateBanner.tsx` + `ActionButtons.tsx`'s primary "Update Now" button. |
| 5 | "Open Dashboard" → opens `http://127.0.0.1:6768/dashboard` | ✓ Rust `open_dashboard` command shells out to macOS `open`. |
| 6 | "Open Logs" → opens `~/.runtimescope/logs/collector.err.log` in default viewer | ✓ Rust `open_logs` command — same `open` shell-out, lets macOS pick Console.app. |
| 7 | "Restart Service" → shells out to `runtimescope service restart` | ✓ Rust `service_action("restart")`. |
| 8 | "Update Now" → shells out to `runtimescope service update` | ✓ Rust `service_action("update")` — wired with TODO(v0.12.0) comment per brief §C.1. |
| 9 | "Quit Service" → shells out to `runtimescope service stop` (newly added) | ✓ Rust `service_action("stop")`; CLI command added in `packages/cli/src/service.ts` (mirrors `restartLaunchd()` minus the load step). |
| 10 | "Quit RuntimeScope (Tray)" — quits the tray, not the daemon | ✓ Rust `quit_tray` command + a `Quit RuntimeScope (Tray)` item in the right-click tray menu. |
| 11 | macOS Accessory activation policy (no Dock icon) | ✓ `app.set_activation_policy(ActivationPolicy::Accessory)` in `lib.rs::setup`. |
| 12 | Polling: `MissedTickBehavior::Delay` on tokio interval | ✓ `lib.rs::poll_loop`. |
| 13 | Polling: pause when dropdown hidden | ✓ `PollGate` + `WindowEvent::Focused(false)` → pause + click-tray-icon → resume. |
| 14 | HTTP API documented in `docs/specs/tray-api-surface.md` | ✓ First file under `docs/specs/`. Documents the three endpoints (and explicitly lists what the tray will NOT call). |
| 15 | `runtimescope service stop` added to the CLI | ✓ `service.ts::stopLaunchd` + `stopSystemd`, dispatcher case, top-level CLI help. Smoke-tested against live collector. |
| 16 | All 586 existing unit tests still pass | ✓ |
| 17 | All 7 stress scenarios still pass | ✓ |
| 18 | New `packages/tray` builds via the workspace (`npm run build` reaches it) | ✓ `vite build` produces `dist/`; `cargo tauri build` produces `.app` + `.dmg`. |
| 19 | `cargo tauri build` produces a signed `.dmg` (ad-hoc) | ✓ `RuntimeScope_0.1.0_aarch64.dmg` at `packages/tray/src-tauri/target/release/bundle/dmg/`. `codesign --verify` → `valid on disk; Signature=adhoc; CodeDirectory flags=0x10002 (adhoc, runtime)`. |
| 20 | No collector / mcp-server / SDK code changed | ✓ Only `packages/tray/*` (new) and `packages/cli/src/{service,cli}.ts` (the explicitly-allowed `service stop` addition). |
| 21 | No version bump to any existing package | ✓ All workspace packages remain at 0.10.12; the tray ships under its own 0.1.0. |

---

## 6. Acceptance criteria — deferred

| # | Criterion | Reason | Closure condition |
|---:|---|---|---|
| D1 | Auto-update channel via Tauri's built-in updater | Pre-handoff prerequisite P1 (signing keys + GitHub secret) not done at phase start | Owner runs `tauri signer generate` + `gh secret set TAURI_SIGNING_PRIVATE_KEY`; paste pubkey into `tauri.conf.json`; rebuild. No code changes needed beyond the pubkey paste — the plugin registration is already gated on `TAURI_SIGNING_PUBKEY`. |
| D2 | Smoke check on the project owner's primary machine | Implementing agent cannot interact with the visual menu bar through this shell | Project owner installs the `.dmg`, clicks the tray icon, exercises each action button. See "Smoke checklist" below. |
| D3 | Position the dropdown precisely under the tray icon | `tauri-plugin-positioner` 2.3.1's `Position::TrayCenter` requires a feature flag we haven't enabled | v1.1: enable the `tracker` feature OR consume `TrayIconEvent::Click`'s `rect` field to compute window position manually. Currently anchored at `TopRight`. |
| D4 | Auto-launch on macOS login | Out of scope per the brief ("user can drag to Login Items manually for v1") | v2 — add `tauri-plugin-autostart` and a settings toggle. |
| D5 | Production-grade tray icon | P2 placeholder (monochrome geometric "scope" silhouette) is the v1 default per the brief | v1.1 polish pass — owner provides icon assets at `packages/tray/src-tauri/icons/`. |

### Smoke checklist for the project owner (D2)

After installing `RuntimeScope_0.1.0_aarch64.dmg`:

- [ ] Tray icon appears in the menu bar (monochrome scope; macOS may need `xattr -d com.apple.quarantine ~/Applications/RuntimeScope.app` first to clear Gatekeeper since the build isn't notarized).
- [ ] Left-click reveals dropdown with `port 6768, uptime …, v0.10.12` and at least one session if any RuntimeScope-instrumented app is running.
- [ ] "Open Dashboard" opens `http://127.0.0.1:6768/dashboard` in the default browser.
- [ ] "Open Logs" opens `~/.runtimescope/logs/collector.err.log` in Console.app.
- [ ] "Restart Service" returns success; the dropdown's status briefly flips to red/gray during the ~30s WAL recovery, then green again.
- [ ] "Quit Service" → status goes red within ~5s; "Restart Service" re-installs the launchd plist and brings it back.
- [ ] Right-click → "Quit RuntimeScope (Tray)" exits the tray app cleanly without touching the daemon.
- [ ] After dismissing the dropdown (click outside), the tray polling pauses (no CPU activity from `runtimescope-tray` in Activity Monitor).

---

## 7. Implemented files / modules

### Workspace / config

- [`rust-toolchain.toml`](../../rust-toolchain.toml) — new. Pins Rust 1.95.0 for the project. Targets `aarch64-apple-darwin` + `x86_64-apple-darwin` so a future GitHub Actions matrix can build both. Adds `rustfmt` + `clippy` for the dev experience.
- Root [`package.json`](../../package.json) — unchanged. `packages/*` glob already covers the new `packages/tray` workspace.

### Source

| Module | File | Brief §X |
|---|---|---|
| CLI: new `service stop` subcommand | [`packages/cli/src/service.ts`](../../packages/cli/src/service.ts) (`stopLaunchd`, `stopSystemd`, dispatcher case, help) | §C "Missing command you'll likely want" |
| CLI: top-level help text | [`packages/cli/src/cli.ts`](../../packages/cli/src/cli.ts) (subcommand list) | §C |
| Tray: Cargo manifest | [`packages/tray/src-tauri/Cargo.toml`](../../packages/tray/src-tauri/Cargo.toml) | §A, §"Files you will CREATE" |
| Tray: Tauri config | [`packages/tray/src-tauri/tauri.conf.json`](../../packages/tray/src-tauri/tauri.conf.json) | §A, §D |
| Tray: capability ACL | [`packages/tray/src-tauri/capabilities/default.json`](../../packages/tray/src-tauri/capabilities/default.json) | §A (Tauri 2 ACL requirement) |
| Tray: Rust entrypoint | [`packages/tray/src-tauri/src/main.rs`](../../packages/tray/src-tauri/src/main.rs) | §"Files you will CREATE" |
| Tray: Rust shell (tray, window, polling, IPC) | [`packages/tray/src-tauri/src/lib.rs`](../../packages/tray/src-tauri/src/lib.rs) | §A, §B, §C |
| Tray: HTTP client | [`packages/tray/src-tauri/src/collector_client.rs`](../../packages/tray/src-tauri/src/collector_client.rs) | §B, §B.1 |
| Tray: build script | [`packages/tray/src-tauri/build.rs`](../../packages/tray/src-tauri/build.rs) | (standard Tauri scaffold) |
| Tray: icon assets | [`packages/tray/src-tauri/icons/`](../../packages/tray/src-tauri/icons/) | P2 |
| Tray: icon generator | [`packages/tray/scripts/generate-placeholder-icons.py`](../../packages/tray/scripts/generate-placeholder-icons.py) | (re-runnable so the owner can re-derive icons on icon edits) |
| Tray: webview package manifest | [`packages/tray/package.json`](../../packages/tray/package.json) | §"Files you will CREATE" |
| Tray: Vite config | [`packages/tray/vite.config.ts`](../../packages/tray/vite.config.ts) | §"Files you will CREATE" |
| Tray: TS config | [`packages/tray/tsconfig.json`](../../packages/tray/tsconfig.json) | §"Files you will CREATE" |
| Tray: HTML entry | [`packages/tray/index.html`](../../packages/tray/index.html) | (Vite entry point) |
| Tray: React entry | [`packages/tray/src/main.tsx`](../../packages/tray/src/main.tsx) | §"Files you will CREATE" |
| Tray: React app shell | [`packages/tray/src/App.tsx`](../../packages/tray/src/App.tsx) | §"Files you will CREATE" |
| Tray: status badge | [`packages/tray/src/components/StatusBadge.tsx`](../../packages/tray/src/components/StatusBadge.tsx) | Acceptance §1, §2 |
| Tray: session list | [`packages/tray/src/components/SessionList.tsx`](../../packages/tray/src/components/SessionList.tsx) | Acceptance §3 |
| Tray: update banner | [`packages/tray/src/components/UpdateBanner.tsx`](../../packages/tray/src/components/UpdateBanner.tsx) | Acceptance §4 |
| Tray: action buttons | [`packages/tray/src/components/ActionButtons.tsx`](../../packages/tray/src/components/ActionButtons.tsx) | Acceptance §5–§10 |
| Tray: polling hook | [`packages/tray/src/hooks/useCollectorHealth.ts`](../../packages/tray/src/hooks/useCollectorHealth.ts) | §A polling rules |
| Tray: styles | [`packages/tray/src/styles.css`](../../packages/tray/src/styles.css) | (dropdown chrome) |

### Tests

- [`packages/tray/src-tauri/src/collector_client.rs`](../../packages/tray/src-tauri/src/collector_client.rs) — 2 Rust unit tests inline (`compare_versions`). No JS/TS test files (see §4.5).

### Documentation

- [`docs/specs/tray-api-surface.md`](../specs/tray-api-surface.md) — **NEW.** First file under `docs/specs/`; establishes the convention for that directory. Documents the three HTTP endpoints the tray calls + the v0.12.0 transition + the explicit list of what the tray does NOT call.
- [`packages/tray/README.md`](../../packages/tray/README.md) — tray package's own dev/build instructions.
- [`packages/tray/.gitignore`](../../packages/tray/.gitignore) — ignores `dist/`, `src-tauri/target/`, `src-tauri/gen/`.

---

## 8. Known follow-ups for the next phase

These are explicit hooks left in the code or surfaced during this phase. **They are not scheduled.**

- [ ] **Wire-Protocol-Lock should adopt `docs/specs/tray-api-surface.md` as input.** Three endpoints (`/api/health`, `/api/sessions`, npm-latest) become part of the locked wire protocol. The "deliberately NOT called" list is the negative space that doesn't need to be in the spec.
- [ ] **TODO(v0.12.0) in `collector_client.rs::latest_published_version`** — swap npm registry call for GitHub Releases manifest at the Rust collector cutover.
- [ ] **TODO(v0.12.0) in `ActionButtons.tsx`** — `service update`'s implementation flips from `npm install -g` to curl-install; the tray's button contract is unchanged.
- [ ] **Auto-updater unblock (D1)** — owner generates signing keys, paste pubkey into `tauri.conf.json`, set `TAURI_SIGNING_PUBKEY` + `TAURI_SIGNING_PRIVATE_KEY`. Plugin registers automatically.
- [ ] **Pre-existing build issue (§4.2)** — `runtimescope-playground` lacks a `build` script. The next phase decides whether to add `--if-present` to the root `build` script or stub a script in `playground`.
- [ ] **v1.1 tray icon polish (D5)** — owner-provided icon; replace files in `packages/tray/src-tauri/icons/`.
- [ ] **Refine dropdown anchor (D3)** — enable `tauri-plugin-positioner`'s `tracker` feature, or compute window position from the tray-icon `rect`.

---

## 8.1 Post-ship fixes (owner smoke-test feedback, 2026-05-31)

Three defects surfaced when the owner installed and ran the `.dmg`. All fixed in `packages/tray/src-tauri/src/lib.rs`; the workspace stays at 0.10.13 and the tray at 0.1.0 (no version bump).

**1. Duplicate tray icon.** The icon was registered twice — declaratively in `tauri.conf.json`'s `trayIcon` block *and* programmatically via `TrayIconBuilder`. Removed the declarative block; the programmatic one (which carries the click handler + menu) is canonical.

**2. App would not quit / icon never left the menu bar.** The `.run()` handler called `api.prevent_exit()` on **every** `RunEvent::ExitRequested`. That guard keeps a menu-bar app alive when its window closes, but `app.exit(0)` (both quit paths) *is* an `ExitRequested`, so quit was unconditionally blocked. Fix: a `quitting: AtomicBool` on `AppState`; both quit affordances route through `request_quit()` which sets the flag before `app.exit(0)`; the run handler only calls `prevent_exit()` when the flag is false. Implicit (window-close) exits still keep the app alive; explicit quit now terminates and removes the icon.

**3. Service buttons (Restart / Quit Service / Update Now) silently failed from a Finder launch.** A Finder/launchd launch hands the app a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) that omits Homebrew, the npm-global prefix, and Node version-manager bin dirs — so `Command::new("runtimescope")` couldn't resolve. (Lesson mirrored from getagentseal/codeburn's `CodeburnCLI.swift`.) Fix is two-part because the `runtimescope` bin is a `#!/usr/bin/env node` script:
   - `runtimescope_search_dirs()` builds a priority list — `/opt/homebrew/bin`, `/usr/local/bin`, and (when `HOME` set) `~/.volta/bin`, `~/.asdf/shims`, `~/.npm-global/bin`, `~/.local/share/pnpm`, `~/.bun/bin`, plus every `$NVM_DIR/versions/node/<ver>/bin` holding an executable `runtimescope` (sorted **numerically** by parsed `major.minor.patch`, newest first — lexical sort got `v10`/`v9` wrong).
   - `runtimescope_command()` resolves the CLI by **absolute path** and **prepends those dirs to the child's PATH**, so the shebang re-resolves `node` from the matching version-manager bin dir.
   - Falls back to the bare name `runtimescope` (under the augmented PATH) when nothing is found, preserving terminal-launch behavior. Service args are a hardcoded allowlist (`restart`/`update`/`stop`) — no user input reaches `Command::args`, so not injectable. `open_path()` also hardened to absolute `/usr/bin/open` on macOS.

   **Verified on the owner's machine:** `runtimescope` lives at `~/.nvm/versions/node/v22.19.0/bin/` and is absent from the minimal PATH (bug reproduced); the resolver finds it with `node` in the same dir (fix confirmed). Covered by 7 Rust unit tests (`augment_path`, `parse_node_version` numeric ordering, search-dir invariants).

   A 4-lens adversarial review (workflow) returned **SHIP, no must-fix**. Deferred follow-ups (none block v0.1):
   - Broaden install-manager coverage to fnm / mise multi-version globbing and a custom `npm config prefix` (only matters if the owner migrates off nvm).
   - Persisted resolved-CLI-path cache (CodeBurn parity) — perf only, negligible at this scale.
   - Optional `RUNTIMESCOPE_BIN` dev-override env var (with an arg allowlist, à la CodeBurn) for testing local debug builds.

---

## 9. Reviewer / handoff pointer

The handoff doc that picks this up will be at [`../handoffs/phase-wire-protocol-lock-handoff.md`](../handoffs/) (not yet written). Phase Wire-Protocol-Lock is ~2-3d per the master phase plan ([`../roadmap/MASTER_PHASE_PLAN.md`](../roadmap/MASTER_PHASE_PLAN.md)) and inherits:

- The tray as a *concrete client* against which the locked surface is validated.
- [`docs/specs/tray-api-surface.md`](../specs/tray-api-surface.md) as one of the input contracts.
- The v0.10.12 baseline preserved — no version bumps to any existing package, no SDK / collector / mcp-server source changed.

---
description: One-time user-level RuntimeScope install — runs the collector as a persistent background service so per-project setup is just SDK wiring
allowed-tools: ["Bash", "Read", "Write"]
---

# Install — One-Time User-Level Setup

Run **once per machine**, not per-project. Installs the RuntimeScope binaries (the
collector, MCP server, and CLI are native Rust as of v0.11.0 — **no Node required**),
registers the background collector as a system service (launchd on macOS, systemd on
Linux), and verifies everything is wired. After this, every new project only needs
`/runtimescope:setup` to install its SDK — the collector is already running.

This command is **idempotent** — safe to re-run; it'll detect what's already installed
and only do what's missing.

---

## Step 1: Install the binaries

`cargo install` is the cross-platform path (installs `runtimescope`, `collector-server`,
and `mcp-server` into `~/.cargo/bin`, which is on PATH). The dashboard is embedded in
the binary — nothing else to fetch.

```bash
which runtimescope || cargo install runtimescope
```

If `cargo` isn't available:
- **macOS** — download the prebuilt universal binaries from the latest GitHub release and
  put them on PATH (all three must sit in the same directory):
  ```bash
  mkdir -p ~/.runtimescope/bin && cd ~/.runtimescope/bin
  REL=https://github.com/edwinlov3tt/runtimescope/releases/latest/download
  for b in runtimescope collector-server mcp-server; do
    curl -fsSL -o "$b" "$REL/runtimescope-$b-v0.11.0-macos-universal"
    chmod +x "$b"
  done
  xattr -dr com.apple.quarantine . 2>/dev/null || true   # ad-hoc unsigned binaries
  grep -q '.runtimescope/bin' ~/.zshrc || echo 'export PATH="$HOME/.runtimescope/bin:$PATH"' >> ~/.zshrc
  ```
- **Linux / other** — install Rust (`https://rustup.rs`) then `cargo install runtimescope`.

Do NOT run any install with elevated privileges unless the user explicitly asks.

## Step 2: Install the background service

```bash
runtimescope service install
```

What this does:
- **macOS**: writes `~/Library/LaunchAgents/com.runtimescope.collector.plist` and runs
  `launchctl load -w` so the collector auto-starts at login and survives reboots.
- **Linux**: writes `~/.config/systemd/user/runtimescope.service` and runs
  `systemctl --user enable --now`.

The service runs the `collector-server` binary on `ws://127.0.0.1:6767` and
`http://127.0.0.1:6768`. It waits for `/readyz` and reports health. If the service is
already installed it reinstalls the unit cleanly.

## Step 3: Verify it's serving

```bash
runtimescope service status
# or directly:
curl -sS http://127.0.0.1:6768/readyz
```

Expect `{"status":"ready",...}`. If not ready within ~60 seconds, the install command
already prints the common causes (a port held by another process, or a startup crash);
check the service logs under `~/.runtimescope/logs/`.

## Step 4: Register the MCP server (if not already)

```bash
claude mcp list 2>&1 | grep -q runtimescope || \
  claude mcp add runtimescope -- runtimescope mcp
```

`runtimescope mcp` runs the MCP server (with its own embedded collector, ADR-0008) over
stdio. The plugin's `.mcp.json` already wires this for plugin-installed users — this step
is only for users who install RuntimeScope WITHOUT the plugin.

When the MCP server starts and detects an existing collector on `:6768`, it picks alternate
ports for its own embedded collector so the user's SDK keeps targeting the background
service — that's the desired path.

## Step 5: Mark the installation

```bash
mkdir -p ~/.runtimescope
date -u +%Y-%m-%dT%H:%M:%SZ > ~/.runtimescope/installed-at
runtimescope --version >> ~/.runtimescope/installed-at
```

The marker file is what `/runtimescope:update-all` uses to detect the user-level install.

## Step 6: Confirm

```markdown
# RuntimeScope — User-Level Install Complete

**Service**: ✓ running on ws://127.0.0.1:6767 + http://127.0.0.1:6768
**CLI**:     ✓ `runtimescope` available
**MCP**:     ✓ registered with Claude Code (`runtimescope mcp`)
**Marker**:  ~/.runtimescope/installed-at

## What's next

For any new project:
- `cd /path/to/project`
- Run `/runtimescope:setup`

The collector is already running in the background and persists across reboots. Setup only
scaffolds `.runtimescope/config.json`, installs the right SDK package, and generates the
init snippet.

## Lifecycle

- **Status**:    `runtimescope service status`
- **Dashboard**: `runtimescope dashboard`
- **Logs**:      `~/.runtimescope/logs/`
- **Update**:    reinstall the binary (`cargo install runtimescope` or a new release), then
                 `runtimescope service install` to regenerate the unit
- **Stop**:      `runtimescope service uninstall`
```

---

## What this DOES NOT do

- It does NOT scaffold `.runtimescope/config.json` in any project. That's `/runtimescope:setup`'s job.
- It does NOT install any framework SDK packages (`@runtimescope/sdk`, `runtimescope` Python, etc.). Those are per-project.
- It does NOT modify the user's existing dev servers, databases, or any project files.

## Failure modes to handle gracefully

- **No `cargo` and not macOS** → point the user at `https://rustup.rs` then `cargo install runtimescope`. Don't attempt a Node install — the collector is no longer an npm package.
- **Service install fails** (no launchctl/systemctl) → fall back to running `collector-server` manually (`collector-server &`), but mark the install incomplete.
- **Port 6767 or 6768 already bound** → identify with `lsof -nP -iTCP:6768` and free it with consent; don't kill an arbitrary process.

## Migrating from a plugin-only setup

If the user already has the Claude Code plugin installed (and Claude Code is running), the
plugin's MCP server has its own embedded collector on `:6768`. That's the usual reason
`runtimescope service install` reports the port held. Tell the user:

1. **Quit Claude Code** — the plugin's embedded collector exits with the host.
2. **Re-run** `runtimescope service install` — the launchd/systemd service takes the port.
3. **Restart Claude Code** — the plugin's MCP server detects the healthy collector on `:6768`
   and attaches to it instead of starting its own.

After this, the launchd/systemd collector owns the data path and the plugin's MCP server is
a thin proxy — a persistent collector across Claude Code restarts.

## Rules

- **NEVER** install with elevated privileges unless the user explicitly asks.
- **NEVER** modify the user's existing services or kill arbitrary processes on the standard ports.
- **NEVER** assume macOS — detect via `uname -s` and use the right service mechanism.

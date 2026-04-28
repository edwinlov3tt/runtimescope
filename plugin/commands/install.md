---
description: One-time user-level RuntimeScope install — runs the collector as a persistent background service so per-project setup is just SDK wiring
allowed-tools: ["Bash", "Read", "Write"]
---

# Install — One-Time User-Level Setup

Run **once per machine**, not per-project. Installs the RuntimeScope CLI globally, registers the background collector as a system service (launchd on macOS, systemd on Linux), and verifies everything is wired. After this, every new project only needs `/runtimescope:setup` to install its SDK — the collector is already running.

This command is **idempotent** — safe to re-run; it'll detect what's already installed and only do what's missing.

---

## Step 1: Confirm prerequisites

```bash
node --version    # need ≥ 20
npm --version
```

If Node is < 20, prompt the user to upgrade and stop. RuntimeScope's collector targets Node 20.

## Step 2: Install the unscoped CLI globally

```bash
which runtimescope || npm install -g runtimescope@latest
```

This installs the `runtimescope` binary to the user's npm-global bin, used for service install/uninstall, status, doctor, and update. It pulls in `@runtimescope/collector` and `@runtimescope/mcp-server` as runtime deps.

If the user is on a system where `npm install -g` requires sudo (older nvm-less setups), suggest installing nvm first or using `--prefix=~/.local`.

## Step 3: Install the background service

```bash
runtimescope service install
```

What this does:
- **macOS**: writes `~/Library/LaunchAgents/com.runtimescope.collector.plist` and runs `launchctl load -w` so the collector auto-starts at login and survives reboots.
- **Linux**: writes `~/.config/systemd/user/runtimescope.service` and runs `systemctl --user enable --now`.

The service starts the standalone collector listening on `ws://127.0.0.1:6767` and `http://127.0.0.1:6768`.

If the service is already installed, the command no-ops with a friendly message.

## Step 4: Verify it's serving

```bash
runtimescope status
# or directly:
curl -sS http://127.0.0.1:6768/readyz
```

Expect `{"status":"ready",...}`. If not ready within 10 seconds:
- Check ports aren't in use by another process: `runtimescope doctor`
- Check service logs: `runtimescope service logs`

## Step 5: Register the MCP server (if not already)

```bash
claude mcp list 2>&1 | grep -q runtimescope || \
  claude mcp add runtimescope npx -y @runtimescope/mcp-server@latest
```

The plugin's `.mcp.json` already wires this for plugin-installed users. This step is for users who install RuntimeScope WITHOUT the plugin (rare).

When the MCP server starts up and detects an existing collector on `:6768`, it picks alternate ports for its own embedded collector and logs that the user's SDK should target the background service's ports — that's the desired path.

## Step 6: Mark the installation

```bash
mkdir -p ~/.runtimescope
date -u +%Y-%m-%dT%H:%M:%SZ > ~/.runtimescope/installed-at
runtimescope --version >> ~/.runtimescope/installed-at
```

The marker file is what `/runtimescope:update-all` uses to detect "yes, this user has the user-level install". Without it, `update-all` falls back to "no global install detected — nothing to update at user level."

## Step 7: Confirm

```markdown
# RuntimeScope — User-Level Install Complete

**Service**: ✓ running on ws://127.0.0.1:6767 + http://127.0.0.1:6768
**CLI**:     ✓ `runtimescope` available
**MCP**:     ✓ registered with Claude Code
**Marker**:  ~/.runtimescope/installed-at

## What's next

For any new project:
- `cd /path/to/project`
- Run `/runtimescope:setup`

That's it — the collector is already running in the background and persists across reboots. The setup command will only scaffold `.runtimescope/config.json`, install the right SDK package, and generate the init snippet.

## Lifecycle

- **Status**: `runtimescope status`
- **Logs**:   `runtimescope service logs`
- **Update**: `/runtimescope:update-all` (or `runtimescope service update`)
- **Stop**:   `runtimescope service uninstall`
```

---

## What this DOES NOT do

- It does NOT scaffold `.runtimescope/config.json` in any project. That's `/runtimescope:setup`'s job.
- It does NOT install any framework SDK packages (`@runtimescope/nextjs`, `runtimescope` Python, etc.). Those are installed per-project.
- It does NOT modify the user's existing dev servers, databases, or any project files.

## Failure modes to handle gracefully

- **Node < 20** → tell the user, stop. Don't attempt npm install.
- **`npm install -g` fails with EACCES** → suggest nvm or `npm config set prefix ~/.local`. Don't sudo-shell-out without consent.
- **Service install fails** (no launchctl/systemctl) → fall back to a manual "run it yourself" instruction, but mark the install incomplete.
- **Port 6767 or 6768 already bound by something else** → run `runtimescope doctor` to identify, don't kill the offending process without consent.

## Migrating from a plugin-only setup

If the user already has the Claude Code plugin installed (and Claude Code is currently running), the plugin's MCP server has its own embedded collector listening on `:6768`. That's the most common reason `runtimescope service install` fails on Step 3 — port held by the plugin, not by a stranger.

The CLI's foreign-collector detector (v0.10.4+) catches this and aborts with a tailored message that says exactly which process to free. Tell the user:

1. **Quit Claude Code** — the plugin's embedded collector exits with the host.
2. **Re-run** `runtimescope service install` — the launchd/systemd service takes the port.
3. **Restart Claude Code** — the plugin's MCP server detects the existing healthy collector on `:6768` and gracefully attaches to it (skips its own collector entirely, transports MCP-ready in seconds instead of timing out).

After this migration, the plugin and the launchd service coexist: the launchd collector owns the data path, the plugin's MCP server is a thin proxy. Persistent collector across Claude Code restarts is the upgrade.

## Rules

- **NEVER** install with elevated privileges unless the user explicitly asks.
- **NEVER** modify the user's existing services or kill arbitrary processes on the standard ports.
- **NEVER** assume macOS — detect via `uname -s` and use the right service mechanism.
- The whole flow should complete in under 30 seconds on a clean machine.

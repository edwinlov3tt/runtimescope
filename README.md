# RuntimeScope

Runtime profiling for web apps, piped directly into Claude Code via MCP.

RuntimeScope intercepts network requests and console output from your running browser app, streams them over WebSocket to a local collector, and exposes everything as MCP tools — so Claude Code can see exactly what your app is doing at runtime.

## How It Works

```
Browser (SDK) --WebSocket--> [Collector + MCP Server] --stdio--> Claude Code
```

1. **SDK** monkey-patches `fetch` and `console.*` in the browser
2. Events stream over WebSocket to the collector (single Node.js process)
3. Collector stores events in a 10K ring buffer
4. MCP server exposes 6 tools that Claude Code can query

## Quick Start

### 1. Install & Build

```bash
npm install
npm run build
```

### 2. Register with Claude Code

```bash
claude mcp add runtimescope node packages/mcp-server/dist/index.js
```

### 3. Add SDK to Your App

```bash
npm install ../runtime-profiler/packages/sdk
```

```typescript
import { RuntimeScope } from '@runtimescope/sdk';

RuntimeScope.connect({
  serverUrl: 'ws://localhost:9090',
  appName: 'my-app',
});
```

Or use the IIFE build via script tag:

```html
<script src="node_modules/@runtimescope/sdk/dist/index.global.js"></script>
<script>
  RuntimeScope.RuntimeScope.connect({ appName: 'my-app' });
</script>
```

### 4. Ask Claude Code

> "Run detect_issues and tell me what's wrong with my app."

## MCP Tools

| Tool | Description |
|------|-------------|
| `detect_issues` | Runs all pattern detectors — failed requests, slow requests, N+1 patterns, error spam, high error rate |
| `get_event_timeline` | Chronological view of all events for tracing causal chains |
| `get_network_requests` | Captured fetch requests with timing, status, headers, GraphQL detection |
| `get_console_messages` | Console output (log/warn/error/info/debug/trace) with stack traces |
| `get_session_info` | Connection status and event statistics |
| `clear_events` | Reset the event buffer for a clean capture |

See [TOOLS.md](TOOLS.md) for full parameter reference.

## Detected Patterns

| Pattern | Trigger | Severity |
|---------|---------|----------|
| Failed requests | HTTP 4xx/5xx | HIGH (5xx) / MEDIUM (4xx) |
| Slow requests | Duration > 3s | MEDIUM |
| N+1 requests | Same endpoint > 5x in 2s | MEDIUM |
| Console error spam | Same error > 5x in 10s | MEDIUM |
| High error rate | > 30% of console messages are errors | HIGH |

## Project Structure

```
packages/
  sdk/           # Browser SDK (zero deps, ~3KB gzipped)
  collector/     # WebSocket receiver + ring buffer + issue detection
  mcp-server/    # MCP stdio server with 6 tools
```

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `RUNTIMESCOPE_PORT` | 9090 | WebSocket collector port |
| `RUNTIMESCOPE_BUFFER_SIZE` | 10000 | Max events in ring buffer |

## SDK Options

```typescript
RuntimeScope.connect({
  serverUrl: 'ws://localhost:9090',  // Collector WebSocket URL
  appName: 'my-app',                // Identifies this app in session info
  captureNetwork: true,              // Intercept fetch requests
  captureConsole: true,              // Intercept console output
  redactHeaders: ['authorization', 'cookie', 'set-cookie'],
});
```

## License

MIT

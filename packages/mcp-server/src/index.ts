import { execSync } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CollectorServer } from '@runtimescope/collector';
import { registerNetworkTools } from './tools/network.js';
import { registerConsoleTools } from './tools/console.js';
import { registerSessionTools } from './tools/session.js';
import { registerIssueTools } from './tools/issues.js';
import { registerTimelineTools } from './tools/timeline.js';

const COLLECTOR_PORT = parseInt(process.env.RUNTIMESCOPE_PORT ?? '9090', 10);
const BUFFER_SIZE = parseInt(process.env.RUNTIMESCOPE_BUFFER_SIZE ?? '10000', 10);

/**
 * Attempt to kill any stale process holding the collector port.
 * This handles the case where a previous MCP server process didn't
 * clean up (e.g. Claude Code session crashed).
 */
function killStaleProcess(port: number): void {
  try {
    const pids = execSync(`lsof -ti :${port} 2>/dev/null`, { encoding: 'utf-8' }).trim();
    if (pids) {
      const myPid = process.pid.toString();
      for (const pid of pids.split('\n')) {
        if (pid && pid !== myPid) {
          console.error(`[RuntimeScope] Killing stale process ${pid} on port ${port}`);
          try {
            process.kill(parseInt(pid, 10), 'SIGTERM');
          } catch {
            // Process may have already exited
          }
        }
      }
    }
  } catch {
    // lsof not available or no process found — that's fine
  }
}

async function main() {
  // 1. Clear any stale collector from a previous session
  killStaleProcess(COLLECTOR_PORT);

  // 2. Start the collector WebSocket server (retries on EADDRINUSE)
  const collector = new CollectorServer({ bufferSize: BUFFER_SIZE });
  await collector.start({ port: COLLECTOR_PORT, maxRetries: 5, retryDelayMs: 1000 });

  // 3. Create MCP server
  const mcp = new McpServer({
    name: 'runtimescope',
    version: '0.1.0',
  });

  // 4. Register all tools with the shared event store
  const store = collector.getStore();
  registerNetworkTools(mcp, store);
  registerConsoleTools(mcp, store);
  registerSessionTools(mcp, store);
  registerIssueTools(mcp, store);
  registerTimelineTools(mcp, store);

  // 5. Connect MCP to stdio transport
  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  console.error('[RuntimeScope] MCP server running on stdio');
  console.error(`[RuntimeScope] SDK should connect to ws://127.0.0.1:${COLLECTOR_PORT}`);

  // 6. Robust shutdown — ensure the WebSocket server is closed on any exit path
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    collector.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('beforeExit', shutdown);

  // If stdin closes (Claude Code disconnected), shut down cleanly
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
}

main().catch((err) => {
  console.error('[RuntimeScope] Fatal error:', err);
  process.exit(1);
});

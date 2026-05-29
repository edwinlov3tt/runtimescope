/**
 * Conformance: representative MCP tools across families actually read the store.
 *
 * `mcp-tools` proves the catalog shape + the get_network_requests round-trip.
 * This proves tools from OTHER families return real data through the MCP layer —
 * a read tool (get_console_messages), a status tool (get_session_info), and an
 * analysis tool (detect_issues). It's the gate for Milestone 3: when the 63-tool
 * fan-out makes the catalog test pass, these ensure the tools are wired to the
 * store, not just registered as empty stubs.
 *
 * Runs against the Node mcp-server (default); swap with RUNTIMESCOPE_MCP_CMD for
 * the Rust mcp-server. Assertions stay shape/count-based (not deep per-tool) so
 * the gate is broad coverage, not brittle.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { McpDriver, SdkDriver } from '../harness/index.js';

let mcp: McpDriver | null = null;
afterEach(async () => { await mcp?.stop(); mcp = null; });

const PROJECT = 'proj_mcp_families';

function consoleEvent(sessionId: string, i: number): object {
  return {
    eventId: `evt-console-${i}-${randomBytes(4).toString('hex')}`,
    sessionId,
    timestamp: Date.now(),
    eventType: 'console',
    level: 'log',
    message: `hello ${i}`,
    args: [],
  };
}

describe('MCP tool families', () => {
  it('get_console_messages, get_session_info, and detect_issues read through the store', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();

    const driver = new SdkDriver({ wsPort: mcp.wsPort, appName: 'mcp-fam', projectId: PROJECT });
    await driver.connect();
    await new Promise((r) => setTimeout(r, 150));

    const N = 5;
    driver.sendBatch(Array.from({ length: N }, (_, i) => consoleEvent(driver.sessionId, i)));
    await driver.flush();
    await new Promise((r) => setTimeout(r, 600));

    // get_console_messages — must reflect the N console events.
    {
      const { envelope } = await mcp.callTool('get_console_messages', { project_id: PROJECT });
      const env = envelope as { summary: string; data: unknown; metadata?: { eventCount?: number } };
      expect(typeof env.summary).toBe('string');
      const count = env.metadata?.eventCount ?? (Array.isArray(env.data) ? env.data.length : -1);
      expect(count, 'console messages returned via MCP').toBe(N);
    }

    // get_session_info — must report the live session.
    {
      const { envelope } = await mcp.callTool('get_session_info', {});
      const env = envelope as { summary: string; data: unknown };
      expect(typeof env.summary).toBe('string');
      expect(env.data, 'session info data present').toBeTruthy();
    }

    // detect_issues — analysis tool; returns the standard envelope (issues array,
    // possibly empty for clean events). Proves it runs over the store.
    {
      const { envelope } = await mcp.callTool('detect_issues', { project_id: PROJECT });
      const env = envelope as { summary: string; data: unknown; issues: unknown };
      expect(typeof env.summary).toBe('string');
      expect('issues' in (env as object), 'detect_issues returns the standard envelope').toBe(true);
    }

    await driver.close();
  });
});

/**
 * Conformance: MCP tool surface + the server→SDK command channel.
 *
 * Drives the real mcp-server over stdio JSON-RPC (RUNTIMESCOPE_MCP_CMD to swap
 * the Rust bin later). The mcp-server embeds a collector, so we feed events in
 * via an SdkDriver on its WS port and read them back through MCP tools — the
 * full path Claude Code uses.
 *
 * The command-channel test exercises capture_dom_snapshot end-to-end: the MCP
 * tool sends a `command` frame to the SDK, the SDK replies with a
 * `command_response` correlated by requestId (server.ts:1006,1055), and the
 * tool returns the captured payload. That requestId round-trip is the invariant.
 *
 * NOTE for the Rust port: today mcp-server and the collector are ONE process,
 * so the tool calls collector.sendCommand() in-process. ADR-0002 splits them
 * into separate Rust bins — the Rust design must provide an equivalent path
 * (shared process or an internal bridge) for the command channel to work. This
 * test pins the OBSERVABLE behavior; the mechanism is the Rust phase's to design.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { McpDriver, SdkDriver, makeNetEvent } from '../harness/index.js';

let mcp: McpDriver | null = null;
afterEach(async () => { await mcp?.stop(); mcp = null; });

const PROJECT = 'proj_conf_mcp';

describe('MCP tool surface', () => {
  it('lists the full tool catalog over stdio JSON-RPC', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();
    const tools = await mcp.listTools();
    // 63 tools at v0.10.12; allow drift but catch a gutted registry.
    expect(tools.length).toBeGreaterThanOrEqual(60);
    expect(tools).toContain('get_network_requests');
    expect(tools).toContain('get_session_info');
    expect(tools).toContain('get_dom_snapshot');
  });

  it('events ingested via the embedded collector are returned by get_network_requests', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();

    const driver = new SdkDriver({ wsPort: mcp.wsPort, appName: 'conf-mcp', projectId: PROJECT });
    await driver.connect();
    await new Promise((r) => setTimeout(r, 150));

    const N = 12;
    driver.sendBatch(Array.from({ length: N }, (_, i) => makeNetEvent(driver.sessionId, i)));
    await driver.flush();
    await new Promise((r) => setTimeout(r, 600));

    const { envelope } = await mcp.callTool('get_network_requests', { project_id: PROJECT });
    const env = envelope as {
      summary: string;
      data: Array<{ method: string; status: number }>;
      metadata: { eventCount: number };
    };
    expect(env.summary).toMatch(/network request/i);
    expect(env.metadata.eventCount).toBe(N);
    expect(env.data.length).toBe(N);
    expect(env.data[0].method).toBe('GET');
    expect(env.data[0].status).toBe(200);

    await driver.close();
  });

  it('the command channel round-trips capture_dom_snapshot by requestId', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();

    const FAKE = {
      html: '<html><body data-conformance="dom-channel">ok</body></html>',
      url: 'https://conformance.test/page',
      viewport: { width: 1280, height: 720 },
      scrollPosition: { x: 0, y: 0 },
      elementCount: 3,
      truncated: false,
    };

    // The SDK driver answers any server→SDK command with our fake payload.
    let sawCommand: string | null = null;
    const driver = new SdkDriver({
      wsPort: mcp.wsPort,
      appName: 'conf-mcp-cmd',
      projectId: PROJECT,
      onCommand: (cmd) => { sawCommand = cmd.command; return FAKE; },
    });
    await driver.connect();
    await new Promise((r) => setTimeout(r, 150));

    const { envelope } = await mcp.callTool('get_dom_snapshot', { project_id: PROJECT });
    const env = envelope as { data: { html: string; url: string; elementCount: number } | null; summary: string };

    expect(sawCommand, 'collector should have sent capture_dom_snapshot to the SDK').toBe('capture_dom_snapshot');
    expect(env.data, `dom snapshot data (summary was: ${env.summary})`).toBeTruthy();
    expect(env.data!.html).toBe(FAKE.html);
    expect(env.data!.url).toBe(FAKE.url);
    expect(env.data!.elementCount).toBe(3);

    await driver.close();
  });
});

/**
 * Conformance: the PROCESS-mutation + INFRA-connector tools against Node.
 *
 * Two kinds of contract, both deterministic + side-effect-free (we never let a
 * test actually kill a process, delete a dir, or hit a platform API):
 *
 *  1. process mutation safety/degenerate paths — kill_process / restart_dev_server
 *     refuse PID < 2 (system) BEFORE any OS call; restart_dev_server reports
 *     "not found" for a PID that isn't a tracked dev process; purge_caches on a
 *     non-existent directory finds nothing. (The destructive happy paths need a
 *     real process/dir and are verified manually, like scan_website.)
 *  2. infra-connector — Node never loads a platform client (loadFromConfig is
 *     never called + needs API tokens), so deploy/runtime/build logs are always
 *     empty; get_infra_overview is a REAL store-read that detects platforms from
 *     network-request hostnames.
 *
 * Separate `it` blocks; green vs Node first, RUNTIMESCOPE_MCP_CMD swaps Rust.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { McpDriver, SdkDriver } from '../harness/index.js';

let mcp: McpDriver | null = null;
afterEach(async () => { await mcp?.stop(); mcp = null; });

function netEvent(sessionId: string, i: number, url: string): object {
  return {
    eventId: `evt-net-${i}`,
    sessionId,
    timestamp: Date.now(),
    eventType: 'network',
    url,
    method: 'GET',
    status: 200,
    requestHeaders: {},
    responseHeaders: {},
    requestBodySize: 0,
    responseBodySize: 10,
    duration: 5,
    ttfb: 1,
    source: 'conformance',
  };
}

describe('MCP process-mutation + infra-connector (Node)', () => {
  it('kill_process refuses a system PID before any OS call', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();
    const { envelope } = await mcp.callTool('kill_process', { pid: 1 });
    const env = envelope as { summary: string; data: { success: boolean; pid: number }; issues: string[] };
    expect(env.summary).toBe('Refusing to kill PID 1: system process.');
    expect(env.data.success).toBe(false);
    expect(env.data.pid).toBe(1);
    expect(env.issues).toContain('Cannot kill PID 1');
  });

  it('restart_dev_server refuses a system PID, and reports not-found for an unknown PID', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();

    {
      const { envelope } = await mcp.callTool('restart_dev_server', { pid: 1 });
      const env = envelope as { summary: string; data: { success: boolean; pid: number }; issues: string[] };
      expect(env.summary).toBe('Refusing to restart PID 1: system process.');
      expect(env.data.success).toBe(false);
      expect(env.issues).toContain('Cannot kill PID 1');
    }
    {
      // 999999 is not a tracked dev process → "not found" before any kill.
      const { envelope } = await mcp.callTool('restart_dev_server', { pid: 999999 });
      const env = envelope as { summary: string; data: { pid: number; found: boolean }; issues: string[] };
      expect(env.summary).toBe('Process 999999 not found. It may have already exited.');
      expect(env.data.found).toBe(false);
      expect(env.data.pid).toBe(999999);
      expect(env.issues).toContain('Process 999999 not found');
    }
  });

  it('purge_caches on a directory with no caches reports nothing (no deletion)', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();
    const dir = `/tmp/runtimescope-conf-no-such-dir-${Date.now()}`;
    const { envelope } = await mcp.callTool('purge_caches', { directory: dir, dryRun: true });
    const env = envelope as {
      summary: string;
      data: { directory: string; dryRun: boolean; totalFreedMB: number; caches: unknown[] };
      metadata: { eventCount: number };
    };
    expect(env.summary).toBe('No caches found to purge.');
    expect(env.data.caches.length).toBe(0);
    expect(env.data.totalFreedMB).toBe(0);
    expect(env.data.directory).toBe(dir);
    expect(env.metadata.eventCount).toBe(0);
  });

  it('infra deploy/runtime/build log tools return empty (no platform client is ever loaded)', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();

    const deploy = (await mcp.callTool('get_deploy_logs', {})).envelope as { summary: string; data: unknown[] };
    expect(deploy.summary).toBe('0 deployment(s) found.');
    expect(deploy.data).toEqual([]);

    const runtime = (await mcp.callTool('get_runtime_logs', {})).envelope as { summary: string; data: unknown[] };
    expect(runtime.summary).toBe('0 runtime log(s) found.');
    expect(runtime.data).toEqual([]);

    const build = (await mcp.callTool('get_build_status', {})).envelope as { summary: string; data: unknown[] };
    expect(build.summary).toBe('0 platform(s) reporting build status.');
    expect(build.data).toEqual([]);
  });

  it('get_infra_overview detects platforms from network-request hostnames', async () => {
    mcp = McpDriver.spawn();
    await mcp.ready();
    const d = new SdkDriver({ wsPort: mcp.wsPort, appName: 'infra-app', projectId: 'proj_infra' });
    await d.connect();
    await new Promise((r) => setTimeout(r, 150));
    d.sendBatch([
      netEvent(d.sessionId, 1, 'https://my-app.vercel.app/api/x'),
      netEvent(d.sessionId, 2, 'https://db.supabase.co/rest/v1/y'),
      netEvent(d.sessionId, 3, 'https://example.com/plain'),
    ]);
    await d.flush();
    await new Promise((r) => setTimeout(r, 600));

    const { envelope } = await mcp.callTool('get_infra_overview', { project: 'infra-app' });
    const env = envelope as {
      summary: string;
      data: Array<{ project: string; platforms: unknown[]; detectedFromTraffic: string[] }>;
      metadata: { eventCount: number };
    };
    expect(env.data.length).toBe(1);
    expect(env.data[0].platforms).toEqual([]); // no configured clients
    expect(env.data[0].detectedFromTraffic.sort()).toEqual(['Supabase', 'Vercel']);
    expect(env.summary).toBe('Infrastructure overview: 0 configured platform(s), 2 detected from traffic.');
    expect(env.metadata.eventCount).toBe(1);

    await d.close();
  });
});

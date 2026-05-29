/**
 * Conformance harness: spawn the MCP server and speak stdio JSON-RPC to it.
 *
 * The MCP server is a SUPERSET of the standalone collector — it embeds a
 * CollectorServer (WS + HTTP) on the same RUNTIMESCOPE_PORT/HTTP_PORT and adds
 * the MCP tool surface over stdio. So this driver gives us both halves: an
 * embedded collector to feed events into (via an SdkDriver on `wsPort`) and the
 * MCP JSON-RPC channel to query them back out.
 *
 * Swap the binary under test with RUNTIMESCOPE_MCP_CMD — matching the Rust
 * crate split (collector-server is one bin via RUNTIMESCOPE_COLLECTOR_CMD; the
 * Rust mcp-server is another, swapped here). Default is the Node mcp-server.
 *
 * MCP stdio framing is newline-delimited JSON-RPC 2.0 (not LSP Content-Length).
 * The server logs to stderr; stdout carries only protocol messages.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function resolveMcpCmd(): { cmd: string; args: string[] } {
  const override = process.env.RUNTIMESCOPE_MCP_CMD?.trim();
  if (override) {
    const parts = override.split(/\s+/);
    return { cmd: parts[0], args: parts.slice(1) };
  }
  const distPath = join(
    new URL('.', import.meta.url).pathname,
    '..', '..', '..',
    'packages', 'mcp-server', 'dist', 'index.js',
  );
  return { cmd: 'node', args: [distPath] };
}

// MCP servers spawned by conformance use a distinct port band from the
// stress/bench collectors (47xxx) to avoid collisions when suites overlap.
let nextPort = 48000 + Math.floor(Math.random() * 500) * 4;

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpToolResult {
  /** The parsed JSON envelope the tool returned (from content[0].text). */
  envelope: unknown;
  /** Raw MCP result object, for assertions on isError / content shape. */
  raw: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
}

export class McpDriver {
  wsPort: number;
  httpPort: number;
  rootDir: string;
  proc: ChildProcess;
  private buf = '';
  private pending = new Map<number, { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private logLines: string[] = [];
  private exited = false;
  private stderrWaiters: Array<{ re: RegExp; resolve: () => void }> = [];

  private onStderr(s: string): void {
    this.logLines.push(s);
    const joined = this.logLines.join('');
    this.stderrWaiters = this.stderrWaiters.filter((w) => {
      if (w.re.test(joined)) { w.resolve(); return false; }
      return true;
    });
  }

  /** Resolve once the accumulated stderr matches `re` (or reject on timeout). */
  private waitForLog(re: RegExp, ms: number): Promise<void> {
    if (re.test(this.logLines.join(''))) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stderrWaiters = this.stderrWaiters.filter((w) => w.resolve !== wrapped);
        reject(new Error(`Timed out waiting for mcp-server log /${re.source}/.\n--- stderr ---\n${this.logLines.join('').slice(-1500)}`));
      }, ms);
      const wrapped = () => { clearTimeout(timer); resolve(); };
      this.stderrWaiters.push({ re, resolve: wrapped });
    });
  }

  private constructor(wsPort: number, httpPort: number, rootDir: string, proc: ChildProcess) {
    this.wsPort = wsPort;
    this.httpPort = httpPort;
    this.rootDir = rootDir;
    this.proc = proc;
  }

  static spawn(): McpDriver {
    const wsPort = nextPort;
    const httpPort = nextPort + 1;
    nextPort += 4;
    const rootDir = mkdtempSync(join(tmpdir(), 'rs-conf-mcp-'));
    const { cmd, args } = resolveMcpCmd();
    const proc = spawn(cmd, args, {
      env: {
        ...process.env,
        HOME: rootDir,
        RUNTIMESCOPE_PORT: String(wsPort),
        RUNTIMESCOPE_HTTP_PORT: String(httpPort),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const d = new McpDriver(wsPort, httpPort, rootDir, proc);
    proc.stdout!.on('data', (b: Buffer) => d.onStdout(b.toString()));
    proc.stderr!.on('data', (b: Buffer) => d.onStderr(b.toString()));
    proc.on('exit', () => { d.exited = true; });
    return d;
  }

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // non-JSON line on stdout — ignore
      }
      if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
        this.pending.get(msg.id)!.resolve(msg);
        this.pending.delete(msg.id);
      }
    }
  }

  private send(method: string, params?: unknown, expectReply = true): Promise<JsonRpcResponse> {
    const id = this.nextId++;
    const frame = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    if (!expectReply) {
      this.proc.stdin!.write(frame);
      return Promise.resolve({ jsonrpc: '2.0', id });
    }
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out.\n--- mcp stderr ---\n${this.logLines.join('').slice(-1500)}`));
      }, 15_000);
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.proc.stdin!.write(frame);
    });
  }

  private notify(method: string, params?: unknown): void {
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  /** initialize handshake + wait for the embedded collector's /readyz. */
  async ready(): Promise<void> {
    // The mcp-server calls process.stdin.resume() at startup (parent-death
    // watchdog) but only attaches the MCP transport's stdin reader as its LAST
    // step — after booting the collector + registering all tools. Anything we
    // write before that is consumed by the flowing stdin and lost. Wait for the
    // "running on stdio" marker so our initialize actually reaches the transport.
    await this.waitForLog(/MCP server running on stdio/, 20_000);

    const res = await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'rs-conformance', version: '0.0.0' },
    });
    if (res.error) throw new Error(`MCP initialize failed: ${res.error.message}`);
    this.notify('notifications/initialized');

    // Embedded collector serves /readyz on httpPort.
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${this.httpPort}/readyz`, { signal: AbortSignal.timeout(500) });
        if (r.ok && ((await r.json()) as { status?: string }).status === 'ready') return;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`MCP-embedded collector never reached /readyz.\n--- mcp stderr ---\n${this.logLines.join('').slice(-1500)}`);
  }

  async listTools(): Promise<string[]> {
    const res = await this.send('tools/list', {});
    if (res.error) throw new Error(`tools/list failed: ${res.error.message}`);
    const tools = (res.result as { tools?: Array<{ name: string }> }).tools ?? [];
    return tools.map((t) => t.name);
  }

  /** Call a tool; parse its text content as JSON (the standard envelope). */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    const res = await this.send('tools/call', { name, arguments: args });
    if (res.error) throw new Error(`tools/call ${name} failed: ${res.error.message}`);
    const raw = res.result as McpToolResult['raw'];
    const text = raw.content?.find((c) => c.type === 'text')?.text;
    let envelope: unknown = undefined;
    if (text) {
      try { envelope = JSON.parse(text); } catch { envelope = text; }
    }
    return { envelope, raw };
  }

  async stop(): Promise<void> {
    if (!this.exited && !this.proc.killed) {
      this.proc.kill('SIGTERM');
      const forced = setTimeout(() => this.proc.kill('SIGKILL'), 2000);
      await new Promise<void>((r) => this.proc.on('exit', () => r()));
      clearTimeout(forced);
    }
    try { if (existsSync(this.rootDir)) rmSync(this.rootDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

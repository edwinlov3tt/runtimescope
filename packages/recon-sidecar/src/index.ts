import { createInterface } from 'node:readline';
import { ReconEngine, type ScanOptions } from './engine.js';
import { log } from './log.js';

/**
 * RuntimeScope recon sidecar.
 *
 * A lazy, standalone Node process that the Rust mcp-server spawns when a
 * browser tool is invoked. It speaks a newline-delimited JSON protocol over
 * stdio:
 *
 *   stdin  ← {"id":<n>, "method":"<name>", "params":{...}}\n
 *   stdout → {"id":<n>, "result":{...}}\n   (success)
 *   stdout → {"id":<n>, "error":{"message":"..."}}\n   (failure)
 *
 * stdout carries ONLY protocol responses. All diagnostics go to stderr.
 * See README.md for the full contract.
 */

const SIDECAR_VERSION = '0.11.0';

interface Request {
  id: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

// Lazily constructed — no browser, no Playwright, no Chromium until first use.
let engine: ReconEngine | null = null;
function getEngine(): ReconEngine {
  if (!engine) engine = new ReconEngine();
  return engine;
}

function writeResponse(payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function str(params: Record<string, unknown> | undefined, key: string): string {
  const v = params?.[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`Missing or invalid required string param "${key}"`);
  }
  return v;
}

function optStr(params: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = params?.[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function optNum(params: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = params?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function optStrArray(params: Record<string, unknown> | undefined, key: string): string[] | undefined {
  const v = params?.[key];
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  return undefined;
}

// Shared navigation options accepted by every browser method.
function scanOptions(params: Record<string, unknown> | undefined): ScanOptions {
  const opts: ScanOptions = {};
  const w = optNum(params, 'viewport_width');
  const h = optNum(params, 'viewport_height');
  const waitFor = optStr(params, 'wait_for');
  const timeout = optNum(params, 'timeout');
  if (w !== undefined) opts.viewportWidth = w;
  if (h !== undefined) opts.viewportHeight = h;
  if (waitFor === 'load' || waitFor === 'networkidle' || waitFor === 'domcontentloaded') opts.waitFor = waitFor;
  if (timeout !== undefined) opts.timeout = timeout;
  return opts;
}

async function dispatch(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
  switch (method) {
    case 'ping':
      return {
        ok: true,
        version: SIDECAR_VERSION,
        lastScannedUrl: engine?.getLastScannedUrl() ?? null,
      };

    case 'shutdown': {
      if (engine) await engine.shutdown();
      // Acknowledge, then exit after the response is flushed.
      setImmediate(() => process.exit(0));
      return { ok: true };
    }

    case 'scan_website': {
      const url = str(params, 'url');
      return getEngine().scan(url, scanOptions(params));
    }

    case 'computed_styles': {
      const url = str(params, 'url');
      const selector = str(params, 'selector');
      const properties = optStrArray(params, 'properties');
      return getEngine().computedStyles(url, selector, properties, scanOptions(params));
    }

    case 'element_snapshot': {
      const url = str(params, 'url');
      const selector = str(params, 'selector');
      const depth = optNum(params, 'depth') ?? 5;
      return getEngine().elementSnapshot(url, selector, depth, scanOptions(params));
    }

    case 'layout_tree': {
      const url = str(params, 'url');
      const maxDepth = optNum(params, 'max_depth') ?? 6;
      return getEngine().layoutTree(url, maxDepth, scanOptions(params));
    }

    case 'design_tokens':
      return getEngine().designTokens(str(params, 'url'), scanOptions(params));

    case 'accessibility':
      return getEngine().accessibility(str(params, 'url'), scanOptions(params));

    case 'fonts':
      return getEngine().fonts(str(params, 'url'), scanOptions(params));

    case 'assets':
      return getEngine().assets(str(params, 'url'), scanOptions(params));

    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

async function handleLine(line: string): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return;

  let req: Request;
  try {
    req = JSON.parse(trimmed) as Request;
  } catch (err) {
    writeResponse({ id: null, error: { message: `Invalid JSON: ${(err as Error).message}` } });
    return;
  }

  if (typeof req.method !== 'string') {
    writeResponse({ id: req.id ?? null, error: { message: 'Request missing "method"' } });
    return;
  }

  const id = req.id ?? null;
  try {
    const result = await dispatch(req.method, req.params);
    writeResponse({ id, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    writeResponse({ id, error: { message } });
  }
}

function main(): void {
  process.stdin.setEncoding('utf-8');
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  // Track in-flight handlers so we can drain them before exiting — important
  // for one-shot pipes (`echo … | node dist/index.js`) where stdin closes
  // immediately after the request line.
  const inflight = new Set<Promise<void>>();

  rl.on('line', (line) => {
    // Handlers run concurrently; responses carry `id` for correlation.
    const p = handleLine(line).finally(() => inflight.delete(p));
    inflight.add(p);
  });

  rl.on('close', () => {
    // stdin closed (parent went away) — drain in-flight requests, tear down
    // the browser, then exit.
    log.error('stdin closed, draining and shutting down');
    void Promise.allSettled([...inflight])
      .then(() => (engine ? engine.shutdown() : Promise.resolve()))
      .finally(() => process.exit(0));
  });

  log.error(`recon-sidecar ${SIDECAR_VERSION} ready (lazy — no browser until first request)`);
}

main();

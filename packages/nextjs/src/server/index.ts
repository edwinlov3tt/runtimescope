/**
 * @runtimescope/nextjs/server — server-side SDK for Next.js apps.
 *
 * Use this in `instrumentation.ts`, route handlers, server components,
 * or server actions. Re-exports the Node.js SDK as-is.
 */
export { RuntimeScope, parseDsn, buildDsn } from '@runtimescope/server-sdk';
export type { ParsedDsn, ServerSdkConfig } from '@runtimescope/server-sdk';

import { RuntimeScope, parseDsn } from '@runtimescope/server-sdk';

/**
 * Initialize RuntimeScope in a Next.js server runtime.
 *
 * Reads DSN from `RUNTIMESCOPE_DSN` env var if no DSN is passed.
 * Automatically skips initialization when running in the Edge runtime
 * (use `@runtimescope/nextjs/edge` there instead).
 *
 * @example
 * // instrumentation.ts
 * import { initServer } from '@runtimescope/nextjs/server';
 *
 * export function register() {
 *   if (process.env.NEXT_RUNTIME === 'nodejs') {
 *     initServer();
 *   }
 * }
 */
export function initServer(
  config: Parameters<typeof RuntimeScope.connect>[0] = {},
): void {
  // Edge runtime doesn't have `process` the same way — skip
  if (typeof process === 'undefined') return;
  if (process.env.NEXT_RUNTIME && process.env.NEXT_RUNTIME !== 'nodejs') return;

  RuntimeScope.connect(config);
}

/**
 * Drop-in `register()` export for `instrumentation.ts`.
 * Reads DSN from env, auto-detects runtime, wires up all defaults.
 * Also pings the collector's HTTP health endpoint (dev only) and warns
 * if the collector isn't running, so the developer (and Claude Code)
 * sees a clear message at boot.
 *
 * @example
 * // instrumentation.ts
 * export { register } from '@runtimescope/nextjs/server';
 */
export function register(): void {
  if (typeof process === 'undefined') return;
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  RuntimeScope.connect({
    captureConsole: true,
    captureHttp: true,
    captureErrors: true,
    capturePerformance: true,
  });

  // Only perform the health-check warning in dev — production servers
  // shouldn't spam stderr, and the SDK auto-disable handles the no-DSN case.
  if (process.env.NODE_ENV === 'production') return;

  const dsn = process.env.RUNTIMESCOPE_DSN;
  if (!dsn) return; // nothing to warn about

  let httpPort = 6768;
  try {
    httpPort = parseDsn(dsn).httpEndpoint.split(':').pop()
      ? parseInt(parseDsn(dsn).httpEndpoint.split(':').pop() as string, 10)
      : 6768;
  } catch {
    /* malformed DSN already logged by SDK */
  }

  // Fire-and-forget the health check so register() stays synchronous
  void checkCollectorHealth(httpPort);
}

async function checkCollectorHealth(port: number): Promise<void> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) return;
  } catch {
    /* fall through to the warning */
  }

  const isTTY = !!process.stderr?.isTTY;
  const YELLOW = isTTY ? '\x1b[33m' : '';
  const CYAN = isTTY ? '\x1b[36m' : '';
  const DIM = isTTY ? '\x1b[2m' : '';
  const RESET = isTTY ? '\x1b[0m' : '';

  const lines = [
    '',
    `${YELLOW}⚠ RuntimeScope collector not reachable on :${port}${RESET}`,
    '',
    `  Next.js is instrumented, but the collector is not running.`,
    `  Start it in a separate terminal:`,
    '',
    `    ${CYAN}npx runtimescope start${RESET}`,
    '',
    `  ${DIM}Or ask Claude: "start the runtimescope collector"${RESET}`,
    '',
  ];
  // eslint-disable-next-line no-console
  console.warn(lines.join('\n'));
}

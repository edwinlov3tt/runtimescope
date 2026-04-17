/**
 * @runtimescope/nextjs/server — server-side SDK for Next.js apps.
 *
 * Use this in `instrumentation.ts`, route handlers, server components,
 * or server actions. Re-exports the Node.js SDK as-is.
 */
export { RuntimeScope, parseDsn, buildDsn } from '@runtimescope/server-sdk';
export type { ParsedDsn, ServerSdkConfig } from '@runtimescope/server-sdk';

import { RuntimeScope } from '@runtimescope/server-sdk';

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
 *
 * @example
 * // instrumentation.ts
 * export { register } from '@runtimescope/nextjs/server';
 */
export function register(): void {
  if (typeof process === 'undefined') return;
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    RuntimeScope.connect({
      captureConsole: true,
      captureHttp: true,
      captureErrors: true,
      capturePerformance: true,
    });
  }
}

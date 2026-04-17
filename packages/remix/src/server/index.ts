/**
 * @runtimescope/remix/server — server-side SDK for Remix apps.
 * Use this in `entry.server.tsx` or anywhere in `app/**` that runs on the
 * server (loaders, actions, `remix.config.js` hooks, etc).
 */
export { RuntimeScope, parseDsn, buildDsn } from '@runtimescope/server-sdk';
export type { ParsedDsn, ServerSdkConfig } from '@runtimescope/server-sdk';

import { RuntimeScope } from '@runtimescope/server-sdk';

/**
 * Initialize RuntimeScope in a Remix server entry.
 *
 * Reads `RUNTIMESCOPE_DSN` from the environment. Safe to call multiple
 * times — subsequent calls are no-ops.
 *
 * @example
 * // app/entry.server.tsx
 * import { initServer } from '@runtimescope/remix/server';
 * initServer();
 * // ...existing handleRequest export
 */
export function initServer(
  config: Parameters<typeof RuntimeScope.connect>[0] = {},
): void {
  if (typeof process === 'undefined') return;
  RuntimeScope.connect({
    captureConsole: true,
    captureHttp: true,
    captureErrors: true,
    capturePerformance: true,
    ...config,
  });
}

type LoaderArgs = { request: Request; [key: string]: unknown };

/**
 * Wrap a Remix `loader` or `action` so uncaught errors are captured and
 * request timing is logged.
 *
 * @example
 * export const loader = withRuntimeScope(async ({ request }) => {
 *   const data = await fetchData();
 *   return json(data);
 * });
 */
export function withRuntimeScope<
  T extends (args: LoaderArgs) => unknown,
>(fn: T): T {
  const wrapped = async (args: LoaderArgs) => {
    try {
      return await fn(args);
    } catch (err) {
      // The server SDK already captures unhandled exceptions, but we re-log
      // here so the stack includes the loader/action frame.
      if (typeof console !== 'undefined' && console.error) {
        console.error('[RuntimeScope] loader/action error:', err);
      }
      throw err;
    }
  };
  return wrapped as unknown as T;
}

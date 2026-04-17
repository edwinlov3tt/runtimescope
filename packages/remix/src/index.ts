/**
 * @runtimescope/remix — framework package for Remix.
 *
 * Subpath imports:
 * - `@runtimescope/remix/client` — for `entry.client.tsx`
 * - `@runtimescope/remix/server` — for `entry.server.tsx`, loaders, actions
 *
 * The root entry exports only shared utilities.
 */
export { parseDsn, buildDsn } from '@runtimescope/sdk';
export type { ParsedDsn } from '@runtimescope/sdk';

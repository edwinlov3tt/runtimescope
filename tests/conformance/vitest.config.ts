import { defineConfig } from 'vitest/config';

/**
 * Conformance suite — kept OUT of the workspace (vitest.workspace.ts) on
 * purpose: these specs spawn real collector / mcp-server processes, so they're
 * slow and must run sequentially to avoid port + resource contention. They are
 * the executable wire-protocol contract (ADR-0006): they pass against the Node
 * collector today and become the Rust port's acceptance gate via
 * RUNTIMESCOPE_COLLECTOR_CMD / RUNTIMESCOPE_MCP_CMD.
 *
 * Run: `npm run conformance` (= vitest run --config tests/conformance/vitest.config.ts)
 */
export default defineConfig({
  test: {
    include: ['specs/**/*.conformance.test.ts'],
    root: new URL('.', import.meta.url).pathname,
    pool: 'forks',
    // One process at a time: collectors bind real ports and we kill/restart
    // them mid-test. Parallelism here buys flakiness, not speed.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

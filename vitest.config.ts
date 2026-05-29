import { defineConfig, configDefaults } from 'vitest/config';

/**
 * Root test config for `npm test`.
 *
 * Vitest 4 no longer loads `vitest.workspace.ts`, so the default `vitest run`
 * globs the whole repo for *.test.ts. That's the intended behavior for the unit
 * suite (collector + mcp-server + SDK package tests). But the conformance suite
 * spawns real collector/mcp-server processes and must NOT run as part of
 * `npm test` — it has its own config and `npm run conformance` entry. Exclude it
 * here (the stress/bench harnesses aren't *.test.ts, so they're never matched).
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'tests/conformance/**'],
    pool: 'forks', // native-module (better-sqlite3) compatibility
  },
});

import { defineConfig } from 'tsup';

export default defineConfig([
  // SDK re-exports (ESM + CJS)
  {
    entry: {
      index: 'src/index.ts',
      server: 'src/server.ts',
    },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'es2020',
    external: ['@runtimescope/sdk', '@runtimescope/server-sdk'],
  },
  // CLI binary (ESM, bundled)
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    sourcemap: true,
    target: 'node20',
    banner: { js: '#!/usr/bin/env node' },
  },
]);

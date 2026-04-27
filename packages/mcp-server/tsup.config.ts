import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  banner: {
    js: '#!/usr/bin/env node',
  },
  // `@runtimescope/extension` is a private monorepo package — never published
  // to npm. Bundle its used exports (TechnologyDatabase, detect, plus the
  // type-only imports) into the mcp-server's dist so `npx -y @runtimescope/
  // mcp-server@latest` works without needing the extension to exist in the
  // npm registry. Without this, npm install errors with 404.
  noExternal: ['@runtimescope/extension'],
});

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  sourcemap: true,
  clean: true,
  target: 'node20',
  // The sidecar is launched directly as `node dist/index.js`; the shebang also
  // lets it run via the `runtimescope-recon-sidecar` bin.
  banner: {
    js: '#!/usr/bin/env node',
  },
  // `@runtimescope/extension` is a private monorepo package (tech-stack
  // detection engine) — never published to npm. Bundle its used exports
  // (TechnologyDatabase, detect, types) into dist so the sidecar carries the
  // detection logic itself. The 2.5 MB technology DATA files are loaded at
  // runtime (see src/detection.ts) rather than inlined into the bundle.
  noExternal: ['@runtimescope/extension'],
  // `playwright` stays external — it ships as a real runtime dependency that
  // supplies the headless Chromium binary.
  external: ['playwright'],
});

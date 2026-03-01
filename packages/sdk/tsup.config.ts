import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs', 'iife'],
  dts: true,
  sourcemap: true,
  clean: true,
  minify: true,
  globalName: 'RuntimeScope',
  target: 'es2020',
  // Collapse the IIFE namespace so RuntimeScope.init() works directly
  // (without this, tsup creates RuntimeScope = { RuntimeScope: class, default: class })
  footer: {
    js: 'if(typeof RuntimeScope!=="undefined"&&RuntimeScope.RuntimeScope){RuntimeScope=RuntimeScope.RuntimeScope;}',
  },
});

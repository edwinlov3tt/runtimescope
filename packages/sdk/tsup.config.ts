import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'iife'],
  dts: true,
  sourcemap: true,
  clean: true,
  minify: true,
  globalName: 'RuntimeScope',
  target: 'es2020',
});

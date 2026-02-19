import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/detect/index.ts'],
  format: ['esm'],
  dts: true,
  target: 'es2020',
  outDir: 'dist',
  clean: true,
});

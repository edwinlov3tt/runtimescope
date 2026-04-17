import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    'client/index': 'src/client/index.ts',
    'server/index': 'src/server/index.ts',
    'edge/index': 'src/edge/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2020',
  // Next.js apps can include this — don't bundle deps
  external: [
    '@runtimescope/sdk',
    '@runtimescope/server-sdk',
    '@runtimescope/workers-sdk',
    'react',
    'react-dom',
    'next',
  ],
});

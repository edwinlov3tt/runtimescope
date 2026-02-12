import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  external: ['@prisma/client', 'drizzle-orm', 'knex', 'pg', 'mysql2', 'better-sqlite3'],
});

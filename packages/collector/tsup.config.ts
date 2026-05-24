import { defineConfig } from 'tsup';
import { cpSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export default defineConfig({
  entry: ['src/index.ts', 'src/standalone.ts', 'src/dashboard.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
  external: ['better-sqlite3', 'pg', 'mysql2', 'mysql2/promise'],
  // After tsup writes dist/, copy the built dashboard bundle (HTML + JS +
  // CSS) into dist/dashboard-assets/ so it ships inside the @runtimescope/
  // collector npm package. The HTTP server serves it from /dashboard.
  // The dashboard package builds independently — this just copies the
  // result so a separate `npm run build -w packages/dashboard` is enough.
  // If the dashboard hasn't been built yet, this no-ops with a warning;
  // the collector still works (dashboard route 404s until next build).
  onSuccess: async () => {
    const dashboardDist = join(__dirname, '..', 'dashboard', 'dist');
    const targetDir = join(__dirname, 'dist', 'dashboard-assets');
    if (!existsSync(dashboardDist)) {
      console.warn(`[tsup] dashboard not built — /dashboard route will 404 until you run \`npm run build -w packages/dashboard\``);
      return;
    }
    if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
    cpSync(dashboardDist, targetDir, { recursive: true });
    console.log(`[tsup] copied dashboard assets to ${targetDir}`);
  },
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { runtimescope } from '@runtimescope/vite';

export default defineConfig({
  plugins: [
    react(),
    runtimescope({
      dsn:
        process.env.VITE_RUNTIMESCOPE_DSN ??
        'runtimescope://proj_playground_demo@localhost:6768/playground-web',
      autostart: false, // collector already up on :6768
      httpPort: parseInt(process.env.RUNTIMESCOPE_HTTP_PORT ?? '6768', 10),
      sdkConfig: {
        captureRenders: true,
        capturePerformance: true,
        captureClicks: true,
        captureNavigation: true,
        // Demo the new feature: collapse identical console.* spam in DevTools.
        // The collector still receives every event for the dashboard.
        dedupeConsole: true,
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:5174',
        changeOrigin: true,
      },
    },
  },
});

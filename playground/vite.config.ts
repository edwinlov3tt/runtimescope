import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { runtimescope } from '@runtimescope/vite';

export default defineConfig({
  plugins: [
    react(),
    runtimescope({
      dsn: 'runtimescope://proj_playground_demo@localhost:6768/playground-web',
      autostart: true,
      sdkConfig: {
        captureRenders: true,
        capturePerformance: true,
        captureClicks: true,
        captureNavigation: true,
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

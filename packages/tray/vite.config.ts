import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri opens the webview at a fixed dev port; the Rust shell expects 1420.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: '127.0.0.1',
  },
  build: {
    target: 'es2020',
    sourcemap: false,
  },
});

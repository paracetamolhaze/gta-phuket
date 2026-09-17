import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * Multi-page build. Each surface is its own HTML entry so the Twitch extension
 * bundle can be zipped on its own without dragging in the admin app.
 *
 *   viewer.html   -> Twitch video-overlay / mobile extension
 *   streamer.html -> phone PWA that pushes GPS
 *   obs.html      -> transparent 1920x1080 OBS browser source
 *   admin.html    -> /admin/live
 *   dev.html      -> local Twitch player simulator
 */
export default defineConfig(({ mode }) => ({
  // Pinned so the config works no matter which directory vite is invoked from
  // (the container runs it from the workspace root).
  root: __dirname,
  // The single .env lives at the repo root, next to docker-compose.yml.
  envDir: resolve(__dirname, '..'),
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    proxy: {
      '/api': { target: process.env.VITE_PROXY_TARGET ?? 'http://localhost:4000', changeOrigin: true },
      '/socket.io': {
        target: process.env.VITE_PROXY_TARGET ?? 'http://localhost:4000',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: mode !== 'production',
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        viewer: resolve(__dirname, 'viewer.html'),
        streamer: resolve(__dirname, 'streamer.html'),
        obs: resolve(__dirname, 'obs.html'),
        admin: resolve(__dirname, 'admin.html'),
        dev: resolve(__dirname, 'dev.html'),
      },
    },
  },
}));

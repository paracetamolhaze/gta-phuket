import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Multi-page build. Each surface is its own HTML entry so the Twitch extension
 * bundle can be zipped on its own without dragging in the admin app.
 *
 *   video_overlay.html -> Twitch Video - Fullscreen extension
 *   mobile.html        -> Twitch Mobile extension
 *   config.html        -> Twitch broadcaster Config surface
 *   streamer.html      -> phone PWA that pushes GPS
 *   obs.html           -> transparent 1920x1080 OBS browser source
 *   admin.html         -> /admin/live
 *   dev.html           -> local Twitch player simulator
 *
 * The first three are the only ones that ever reach Twitch.
 */

const PORT = Number(process.env.WEB_PORT ?? 8080);
const apiTarget = process.env.VITE_PROXY_TARGET ?? 'http://localhost:4000';

/** Set when building the bundle Caddy serves on the public hostname. */
const publicBuild = process.env.PUBLIC_BUILD === 'true';

/**
 * Twitch Local Test loads the extension from an https:// Testing Base URI and
 * refuses anything else, so the dev server has to speak TLS.
 *
 * Certificates are looked for in this order:
 *
 *   1. ./certs — what `scripts/setup-certs.*` writes with mkcert. mkcert
 *      installs its own CA locally, so the browser trusts the result. This is
 *      the only kind Twitch Local Test can use: a browser will not frame a page
 *      whose certificate it distrusts, and there is no "proceed anyway" for an
 *      iframe.
 *   2. DEV_CERT_DIR — a throwaway self-signed pair the container entrypoint
 *      mints when (1) is missing, so the dev server still answers on
 *      https://localhost:8080 rather than silently changing scheme.
 */
function httpsConfig(): { key: Buffer; cert: Buffer } | undefined {
  const certDirs = [
    resolve(__dirname, '..', 'certs'),
    ...(process.env.DEV_CERT_DIR ? [resolve(process.env.DEV_CERT_DIR)] : []),
  ];

  for (const dir of certDirs) {
    const cert = resolve(dir, 'localhost.pem');
    const key = resolve(dir, 'localhost-key.pem');
    if (existsSync(cert) && existsSync(key)) {
      return { key: readFileSync(key), cert: readFileSync(cert) };
    }
  }

  console.warn(
    `\n[gta-phuket] no certificate found — serving plain HTTP on ${PORT}.\n` +
      '            Twitch Local Test needs a trusted https://localhost:8080/.\n' +
      '            Run scripts/setup-certs.ps1 (Windows) or scripts/setup-certs.sh.\n',
  );
  return undefined;
}

/**
 * Every HTML entry. The Twitch player simulator is left out of the public
 * build: it mints extension tokens and fakes redemptions, and must not be
 * reachable from the internet. Caddy blocks its path as well.
 */
function entryPoints(): Record<string, string> {
  const entries: Record<string, string> = {
    index: resolve(__dirname, 'index.html'),
    privacy: resolve(__dirname, 'privacy.html'),
    video_overlay: resolve(__dirname, 'video_overlay.html'),
    mobile: resolve(__dirname, 'mobile.html'),
    config: resolve(__dirname, 'config.html'),
    streamer: resolve(__dirname, 'streamer.html'),
    obs: resolve(__dirname, 'obs.html'),
    admin: resolve(__dirname, 'admin.html'),
  };
  if (!publicBuild) entries.dev = resolve(__dirname, 'dev.html');
  return entries;
}

export default defineConfig(({ mode, command }) => ({
  // Twitch serves an uploaded extension from a hashed path, not from the domain
  // root, so every asset reference in the bundle has to be relative. In dev the
  // server owns the root, where '/' is correct.
  base: command === 'build' ? './' : '/',
  root: __dirname,
  // The single .env lives at the repo root, next to docker-compose.yml.
  envDir: resolve(__dirname, '..'),
  plugins: [react()],
  resolve: {
    alias: [
      {
        // Twitch's extension CSP forbids blob: workers (they fall under its
        // eval ban), and the default mapbox-gl build starts its worker from
        // URL.createObjectURL(new Blob([...])). The CSP distribution is the
        // same library with the worker split into a real file, loaded from
        // mapboxgl.workerUrl — see web/src/shared/mapbox.ts.
        //
        // Anchored so that 'mapbox-gl/dist/mapbox-gl.css' still resolves.
        find: /^mapbox-gl$/,
        replacement: 'mapbox-gl/dist/mapbox-gl-csp.js',
      },
    ],
  },
  optimizeDeps: {
    // The CSP build is UMD; pre-bundling it keeps dev and build on the same
    // interop path instead of only discovering problems in the build.
    include: ['mapbox-gl/dist/mapbox-gl-csp.js'],
  },
  server: {
    host: '0.0.0.0',
    port: PORT,
    strictPort: true,
    https: httpsConfig(),
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/socket.io': { target: apiTarget, ws: true, changeOrigin: true },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: PORT,
    strictPort: true,
    https: httpsConfig(),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The extension packer walks this to find exactly which chunks and assets
    // each Twitch entry needs — including files referenced from JavaScript
    // rather than from the HTML, such as the Mapbox CSP worker.
    manifest: true,
    sourcemap: mode !== 'production',
    rollupOptions: {
      input: entryPoints(),
    },
  },
}));

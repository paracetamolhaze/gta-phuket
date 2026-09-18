import { defineConfig, type Connect, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
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
    terms: resolve(__dirname, 'terms.html'),
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

const TWITCH_HELPER_SRC = 'https://extension-files.twitch.tv/helper/v1/twitch-ext.min.js';
const TWITCH_HELPER_TAG = `<script src="${TWITCH_HELPER_SRC}"></script>`;

/** Twitch entry -> the surface name the boot script reports. */
const TWITCH_ENTRIES = new Map([
  ['video_overlay.html', 'video_overlay'],
  ['mobile.html', 'mobile'],
  ['config.html', 'config'],
]);

/**
 * The SMOKE_TEST button, as plain markup so it exists before any script of
 * ours has run. React adopts it later — see the raw-trigger effect in
 * web/src/viewer/App.tsx.
 */
const RAW_TRIGGER_TAG =
  '<button type="button" id="gtamap-raw-trigger" class="gtamap-raw-trigger" data-state="html">' +
  'EXTENSION LOADED</button>';

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

interface TwitchPageFlags {
  smoke: boolean;
  dev: boolean;
  apiBase: string;
}

/**
 * Shapes the three Twitch pages (docs/EXTENSION_DIAGNOSTICS.md, section 1), in
 * the dev server and in the build alike:
 *
 *   <head>
 *     Twitch helper                    first script, always
 *     <meta name="gtamap-boot" …>      surface, API base, SMOKE_TEST, DEV_MODE
 *     <script src="gtamap-boot.js">    second script: self-reporting diagnostics
 *     <link href="gtamap-raw.css">     video_overlay + SMOKE_TEST only
 *     …everything Vite emitted
 *   <body>
 *     <button id="gtamap-raw-trigger"> video_overlay + SMOKE_TEST only
 *
 * The helper has to come first: it answers the supervisor's handshake, and
 * Twitch reports "Extension Helper Library Not Loaded" when anything runs ahead
 * of it. The HTML sources put it first, but Vite adds its own scripts on top —
 * in dev /@vite/client and the React refresh preamble, in a build the hoisted
 * entry module — so this runs last (`order: 'post'`) and rebuilds the top of
 * <head> after all of that. A Twitch entry without the helper fails the build.
 *
 * The boot script and the raw stylesheet live in public/ and keep their names,
 * so the build appends a per-build `?v=` to keep a rebuilt page from picking
 * up a stale cached copy.
 */
function twitchPages(): Plugin {
  let flags: TwitchPageFlags = { smoke: false, dev: false, apiBase: '' };
  let buildId = Date.now().toString(36);

  return {
    name: 'gta-phuket:twitch-pages',
    configResolved(config) {
      // Vite's resolved env: the repo-root .env (envDir) overlaid with any
      // VITE_* already in process.env, which is how compose passes them.
      const env = config.env as Record<string, string | boolean | undefined>;
      flags = {
        smoke: env.VITE_SMOKE_TEST === 'true',
        dev: env.VITE_DEV_MODE === 'true',
        apiBase: String(env.VITE_API_BASE ?? '').replace(/\/+$/, ''),
      };
    },
    buildStart() {
      buildId = Date.now().toString(36);
    },
    configureServer(server) {
      // Registered directly, not in a returned post hook, so it sees every
      // request before Vite's own middlewares answer it.
      const sink = extLogSink(process.env.EXT_LOG_INGEST);
      if (sink) server.middlewares.use(extRequestLogger(sink));
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const page = ctx.filename.replace(/\\/g, '/').split('/').pop() ?? '';
        const surface = TWITCH_ENTRIES.get(page);
        if (!surface) return html;
        if (!html.includes(TWITCH_HELPER_TAG)) {
          throw new Error(`${page}: the Twitch helper script tag is missing`);
        }

        // The dev server owns the root; a build is served from Twitch's hashed
        // sub-path, where only relative URLs work.
        const served = ctx.server ? { prefix: '/', version: 'dev' } : { prefix: './', version: buildId };
        const raw = surface === 'video_overlay' && flags.smoke;
        const asset = (name: string): string => escapeAttr(`${served.prefix}${name}?v=${served.version}`);

        const head = [
          TWITCH_HELPER_TAG,
          `<meta name="gtamap-boot" data-surface="${escapeAttr(surface)}" ` +
            `data-api-base="${escapeAttr(flags.apiBase)}" data-smoke="${flags.smoke}" data-dev="${flags.dev}">`,
          `<script src="${asset('gtamap-boot.js')}"></script>`,
          ...(raw ? [`<link rel="stylesheet" href="${asset('gtamap-raw.css')}">`] : []),
        ].join('\n    ');

        // Straight after <head>, ahead of everything Vite prepended there. The
        // charset <meta> stays well inside the first 1024 bytes, which is all
        // the HTML spec asks of it.
        let out = html.split(TWITCH_HELPER_TAG).join('').replace(/\n[ \t]*\n/g, '\n');
        out = out.replace(/<head(?:\s[^>]*)?>/i, (open) => `${open}\n    ${head}`);
        if (raw) out = out.replace(/<body(?:\s[^>]*)?>/i, (open) => `${open}\n    ${RAW_TRIGGER_TAG}`);
        return out;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Dev-server request log
//
// The ingress Caddy tells the API about every request Twitch makes for the
// extension pages (docs/EXTENSION_DIAGNOSTICS.md, section 4). Twitch Local Test
// against https://localhost:8080 bypasses Caddy, so the dev server sends the
// same newline-delimited Caddy access-log JSON itself, marked
// "source":"devserver", to EXT_LOG_INGEST (host:port; unset = off).
// ---------------------------------------------------------------------------

const EXT_LOG_PATHS = new Set([
  '/video_overlay.html',
  '/video_overlay',
  '/mobile.html',
  '/mobile',
  '/config.html',
  '/config',
  '/gtamap-boot.js',
  '/gtamap-raw.css',
]);

/** The only query parameters that are ever logged: the ones Twitch appends. */
const EXT_LOG_PARAMS = ['anchor', 'platform', 'mode', 'state', 'language', 'locale', 'popout'];

/** node's lower-case header name -> Caddy's canonical one. Nothing else is sent. */
const EXT_LOG_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['referer', 'Referer'],
  ['sec-fetch-dest', 'Sec-Fetch-Dest'],
  ['sec-fetch-site', 'Sec-Fetch-Site'],
  ['user-agent', 'User-Agent'],
];

/**
 * A best-effort line writer. It never throws, never blocks a response, and
 * never piles up: it connects on first use and again on the first line after a
 * drop (at most every few seconds), keeps a handful of lines while a
 * connection is being made, and drops lines while there is none.
 */
function extLogSink(target: string | undefined): ((line: string) => void) | null {
  if (!target) return null;
  const colon = target.lastIndexOf(':');
  const host = target.slice(0, colon);
  const port = Number(target.slice(colon + 1));
  if (colon <= 0 || !Number.isInteger(port) || port <= 0 || port > 65535) {
    console.warn(`[gta-phuket] EXT_LOG_INGEST="${target}" is not host:port — extension request log off.`);
    return null;
  }

  const RETRY_MS = 3000;
  const MAX_WAITING = 50;
  const MAX_BUFFERED = 1 << 20;

  let socket: Socket | null = null;
  let connected = false;
  let retryAt = 0;
  let waiting: string[] = [];

  const connect = (): void => {
    const s = createConnection({ host, port });
    socket = s;
    s.unref();
    s.setNoDelay(true);
    // An unreachable host would otherwise hang for the OS connect timeout.
    s.setTimeout(2000, () => s.destroy());
    s.on('connect', () => {
      s.setTimeout(0);
      connected = true;
      const lines = waiting;
      waiting = [];
      for (const line of lines) s.write(line);
    });
    // Handled by 'close', which always follows; without a listener an error
    // event would crash the dev server.
    s.on('error', () => undefined);
    s.on('close', () => {
      if (socket !== s) return;
      socket = null;
      connected = false;
      waiting = [];
      retryAt = Date.now() + RETRY_MS;
    });
  };

  return (line: string): void => {
    try {
      if (socket && connected) {
        if (socket.writableLength < MAX_BUFFERED) socket.write(line);
        return;
      }
      if (!socket) {
        if (Date.now() < retryAt) return;
        connect();
      }
      if (waiting.length < MAX_WAITING) waiting.push(line);
    } catch {
      /* best effort: the request log must never affect serving */
    }
  };
}

function extRequestLogger(send: (line: string) => void): Connect.NextHandleFunction {
  return (req, res, next) => {
    try {
      const url = new URL(req.url ?? '/', 'http://devserver.invalid');
      if (EXT_LOG_PATHS.has(url.pathname)) {
        const started = Date.now();
        const method = req.method ?? 'GET';
        const kept = new URLSearchParams();
        for (const key of EXT_LOG_PARAMS) {
          const value = url.searchParams.get(key);
          if (value !== null) kept.set(key, value.slice(0, 64));
        }
        const query = kept.toString();
        const headers: Record<string, string[]> = {};
        for (const [from, to] of EXT_LOG_HEADERS) {
          const raw = req.headers[from];
          const value = Array.isArray(raw) ? raw[0] : raw;
          if (!value) continue;
          // A Referer is reduced to origin + path here already; the API does
          // the same again.
          headers[to] = [(from === 'referer' ? value.replace(/[?#][\s\S]*$/, '') : value).slice(0, 300)];
        }

        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          try {
            const line = {
              ts: started / 1000,
              source: 'devserver',
              request: { method, uri: url.pathname + (query ? `?${query}` : ''), headers },
              status: res.statusCode,
              duration: (Date.now() - started) / 1000,
            };
            send(`${JSON.stringify(line)}\n`);
          } catch {
            /* best effort */
          }
        };
        res.once('finish', finish);
        res.once('close', finish);
      }
    } catch {
      /* never let logging get in the way of serving */
    }
    next();
  };
}

export default defineConfig(({ mode, command }) => ({
  // Twitch serves an uploaded extension from a hashed path, not from the domain
  // root, so every asset reference in the bundle has to be relative. In dev the
  // server owns the root, where '/' is correct.
  base: command === 'build' ? './' : '/',
  root: __dirname,
  // The single .env lives at the repo root, next to docker-compose.yml.
  envDir: resolve(__dirname, '..'),
  plugins: [react(), twitchPages()],
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
    // Twitch review requires human-readable JavaScript, so the extension
    // release build (web/scripts/ext-release.mjs sets EXT_RELEASE) ships our
    // code unminified. Every other build keeps Vite's default.
    minify: process.env.EXT_RELEASE === 'true' ? false : 'esbuild',
    sourcemap: mode !== 'production',
    rollupOptions: {
      input: entryPoints(),
    },
  },
}));

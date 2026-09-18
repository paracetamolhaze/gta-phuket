#!/usr/bin/env node
/**
 * Builds the Twitch review zip, the same way every time.
 *
 *   npm run ext:build -w web        (from the repo root)
 *   npm run ext:build               (from web/)
 *
 * Three steps, each in its own process, and the first failure stops the run:
 *
 *   1. vite build        with an explicit environment (below), so whatever the
 *                        calling shell or .env says about DEV_MODE, SMOKE_TEST
 *                        or the API base cannot leak into a review bundle
 *   2. build-extension   stage web/extension-build and write
 *                        web/twitch-extension.zip, read back
 *   3. check --final     web/scripts/check-extension-csp.mjs --final
 *
 * The environment of step 1:
 *
 *   NODE_ENV=production, PUBLIC_BUILD=true    public build: no dev.html
 *   EXT_RELEASE=true                          unminified output (vite.config.ts)
 *   VITE_DEV_MODE=false, VITE_SMOKE_TEST=false
 *   VITE_API_BASE      EXT_API_BASE, else https://gudinigta6.duckdns.org
 *   VITE_MAPBOX_PUBLIC_TOKEN / VITE_MAPBOX_STYLE_URL
 *                      the VITE_* name, else the plain MAPBOX_* name that
 *                      docker-compose maps, from the environment or the
 *                      repo-root .env, read through Vite's own loadEnv
 *
 * The token is a public pk.* token (the API hands the same one to every
 * viewer), but it is still never printed: this log is pasted into chats.
 *
 * Twitch review wants human-readable JavaScript, and a library that is not
 * readable sourced separately "so that reviewers may know the source of any
 * obfuscation" (Extension Guidelines). Our code is therefore emitted
 * unminified, and each vendor library gets a chunk of its own,
 * vendor-<library>-<hash>.js, holding the vendor's published production build
 * (re-printed by the bundler, not altered). The file list is in
 * TWITCH_REVIEW.md, section 8.
 *
 * A zip that fails the final check is deleted: whatever is called
 * twitch-extension.zip has passed it.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const selfPath = fileURLToPath(import.meta.url);
const webRoot = resolve(dirname(selfPath), '..');
const repoRoot = resolve(webRoot, '..');
const zipPath = join(webRoot, 'twitch-extension.zip');

/** The public backend the review build talks to unless EXT_API_BASE says otherwise. */
const DEFAULT_API_BASE = 'https://gudinigta6.duckdns.org';
const DEFAULT_STYLE_URL = 'mapbox://styles/mapbox/dark-v11';
/** Public support contact, only used by privacy.html in dist (never zipped). */
const DEFAULT_CONTACT = 'twitchacc11112@outlook.com';

// Captured before Vite's loadEnv runs: it may add VITE_USER_NODE_ENV to
// process.env, and the child build should start from the caller's own env.
const inherited = { ...process.env };

// ---------------------------------------------------------------------------
// Vendor chunks
// ---------------------------------------------------------------------------

/**
 * node_modules package → vendor chunk. Packages that always travel together
 * share one chunk; anything else gets a chunk named after itself.
 */
const VENDOR_GROUPS = new Map([
  ['react', 'react'],
  ['react-dom', 'react'],
  ['scheduler', 'react'],
  ['mapbox-gl', 'mapbox-gl'],
  ['socket.io-client', 'socket.io'],
  ['socket.io-parser', 'socket.io'],
  ['engine.io-client', 'socket.io'],
  ['engine.io-parser', 'socket.io'],
  ['@socket.io/component-emitter', 'socket.io'],
]);

/** Rollup `manualChunks`: every module from node_modules goes to a vendor chunk. */
function vendorChunk(id) {
  // Covers real paths and the commonjs plugin's virtual "\0…?commonjs-…" ids.
  const m = /[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/?]+)/.exec(id);
  if (!m) return undefined;
  const pkg = m[1].replace(/\\/g, '/');
  const group = VENDOR_GROUPS.get(pkg) ?? pkg.replace(/^@/, '').replace(/[^\w.-]+/g, '-');
  return `vendor-${group}`;
}

// ---------------------------------------------------------------------------
// Child mode: the Vite build itself
// ---------------------------------------------------------------------------

/**
 * Runs in the child process started by step 1, whose environment is exactly
 * the one composed below. Vite's JS API instead of its CLI, because the CLI
 * cannot add `manualChunks`, and the vendor split is only for this build.
 */
async function viteBuild() {
  const { build } = await import('vite');
  await build({
    configFile: join(webRoot, 'vite.config.ts'),
    root: webRoot,
    mode: 'production',
    build: {
      rollupOptions: {
        output: { manualChunks: vendorChunk },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Parent mode
// ---------------------------------------------------------------------------

function fail(message) {
  console.error(`\next:build FAILED — ${message}\n`);
  process.exit(1);
}

/** EXT_API_BASE or the public backend, as a bare https origin. */
function resolveApiBase() {
  const raw = (inherited.EXT_API_BASE ?? '').trim() || DEFAULT_API_BASE;
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`EXT_API_BASE="${raw}" is not a URL.`);
  }
  if (url.protocol !== 'https:') {
    fail(`EXT_API_BASE must be https:// (Twitch serves the extension over https), got "${raw}".`);
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    fail(`EXT_API_BASE must be an origin only, like ${DEFAULT_API_BASE}, got "${raw}".`);
  }
  return url.origin;
}

/**
 * The public values the extension bundle compiles in, from the environment or
 * the repo-root .env. Vite's loadEnv reads the files and lets the environment
 * win; the exact key names are passed as prefixes, so nothing else in .env
 * (least of all a secret) is ever loaded into this process.
 */
async function publicValues() {
  const { loadEnv } = await import('vite');
  const env = loadEnv('production', repoRoot, [
    'VITE_MAPBOX_PUBLIC_TOKEN',
    'MAPBOX_PUBLIC_TOKEN',
    'VITE_MAPBOX_STYLE_URL',
    'MAPBOX_STYLE_URL',
    'VITE_PUBLIC_ORIGIN',
    'PUBLIC_WEB_URL',
    'VITE_PRIVACY_CONTACT',
    'PRIVACY_CONTACT',
  ]);
  const pick = (...keys) => keys.map((k) => (env[k] ?? '').trim()).find(Boolean) ?? '';
  return {
    mapboxToken: pick('VITE_MAPBOX_PUBLIC_TOKEN', 'MAPBOX_PUBLIC_TOKEN'),
    styleUrl: pick('VITE_MAPBOX_STYLE_URL', 'MAPBOX_STYLE_URL') || DEFAULT_STYLE_URL,
    publicOrigin: pick('VITE_PUBLIC_ORIGIN', 'PUBLIC_WEB_URL'),
    privacyContact: pick('VITE_PRIVACY_CONTACT', 'PRIVACY_CONTACT'),
  };
}

/** Runs one step in its own Node process; resolves to an error text, or null on success. */
function run(label, args, env) {
  console.log(`\n── ${label} ${'─'.repeat(Math.max(4, 66 - label.length))}\n`);
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, args, { cwd: webRoot, env, stdio: 'inherit', shell: false });
    child.on('error', (err) => resolveRun(`${label}: could not start (${err.message})`));
    child.on('exit', (code, signal) => {
      resolveRun(code === 0 ? null : `${label} exited with ${signal ? `signal ${signal}` : `code ${code}`}.`);
    });
  });
}

async function main() {
  const apiBase = resolveApiBase();
  const values = await publicValues();

  const env = {
    ...inherited,
    NODE_ENV: 'production',
    PUBLIC_BUILD: 'true',
    EXT_RELEASE: 'true',
    VITE_DEV_MODE: 'false',
    VITE_SMOKE_TEST: 'false',
    VITE_API_BASE: apiBase,
    // Set even when empty: an explicit value beats .env inside Vite, so the
    // bundle carries exactly what this run decided on.
    VITE_MAPBOX_PUBLIC_TOKEN: values.mapboxToken,
    VITE_MAPBOX_STYLE_URL: values.styleUrl,
    // privacy.html only; it is built into dist but never goes into the zip.
    VITE_PUBLIC_ORIGIN: values.publicOrigin || apiBase,
    VITE_PRIVACY_CONTACT: values.privacyContact || DEFAULT_CONTACT,
  };
  // Dev-server only; meaningless (and a stray connection) during a build.
  delete env.EXT_LOG_INGEST;
  delete env.VITE_USER_NODE_ENV;

  console.log('IRL Waypoint — Twitch review build');
  console.log(`  API base          : ${apiBase}`);
  console.log('  DEV_MODE          : false');
  console.log('  SMOKE_TEST        : false');
  console.log('  JavaScript        : unminified (EXT_RELEASE), vendor libraries in vendor-* chunks');
  console.log(
    `  Mapbox token      : ${values.mapboxToken ? 'compiled in (value not shown)' : 'none compiled in'}`,
  );
  if (!values.mapboxToken) {
    console.warn(
      '  WARNING: no VITE_MAPBOX_PUBLIC_TOKEN / MAPBOX_PUBLIC_TOKEN found. The map still\n' +
        '           works with the token GET /api/ext/state serves, but has no fallback.',
    );
  }

  const built = await run('vite build', [selfPath, '--vite-build'], env);
  if (built) fail(built);
  const packed = await run('pack', [join(webRoot, 'scripts', 'build-extension.mjs')], env);
  if (packed) fail(packed);
  const checked = await run('final check', [join(webRoot, 'scripts', 'check-extension-csp.mjs'), '--final'], env);
  if (checked) {
    // Whatever is called twitch-extension.zip has passed the final check: a
    // rejected archive left under that name is one upload away from review.
    // The staged files stay in web/extension-build for a look.
    await rm(zipPath, { force: true });
    fail(`${checked} ${relative(process.cwd(), zipPath) || zipPath} was removed; web/extension-build is kept.`);
  }

  const zip = await readFile(zipPath);
  const size = (await stat(zipPath)).size;
  const sha256 = createHash('sha256').update(zip).digest('hex');
  console.log('\nReady for upload (Twitch Console → Files → Upload Version Assets):');
  console.log(`  ${relative(process.cwd(), zipPath) || zipPath}`);
  console.log(`  ${(size / 1024 / 1024).toFixed(2)} MB, sha256 ${sha256}`);
}

if (process.argv.includes('--vite-build')) {
  viteBuild().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

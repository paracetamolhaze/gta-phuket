#!/usr/bin/env node
/**
 * Packages the Twitch extension bundle.
 *
 *   npm run ext:zip -w web
 *
 * Twitch hosts extension front-end files itself: you upload a zip whose ROOT
 * contains the HTML entry points. Only the three Twitch surfaces belong in it —
 * the admin console, the OBS source and the streamer PWA stay on your own
 * server and must never be handed to viewers.
 *
 * The file list comes from Vite's build manifest rather than from scraping the
 * HTML, because some files are referenced from JavaScript and never appear in a
 * tag: the Mapbox CSP worker is loaded through
 * `new URL('mapbox-gl-csp-worker-*.js', import.meta.url)`, and leaving it out
 * would produce a zip that looks complete and shows a blank map.
 *
 * Build it with the public API base compiled in, or the hosted bundle will call
 * its own Twitch-hosted origin:
 *
 *   VITE_API_BASE=https://api.example.com \
 *   VITE_MAPBOX_PUBLIC_TOKEN=pk.xxx \
 *   npm run build -w web && npm run ext:zip -w web
 */
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile, cp } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(webRoot, 'dist');
const stage = join(webRoot, 'extension-build');
const zipPath = join(webRoot, 'twitch-extension.zip');

/** The pages Twitch is configured to serve. Keep in sync with the console. */
const ENTRIES = ['video_overlay.html', 'mobile.html', 'config.html'];

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Walk one manifest entry and everything it imports, collecting every file the
 * browser will end up asking for.
 */
function collect(manifest, key, seen = new Set(), out = new Set()) {
  if (seen.has(key)) return out;
  seen.add(key);

  const entry = manifest[key];
  if (!entry) return out;

  if (entry.file) out.add(entry.file);
  for (const css of entry.css ?? []) out.add(css);
  for (const asset of entry.assets ?? []) out.add(asset);
  for (const imported of entry.imports ?? []) collect(manifest, imported, seen, out);
  // Dynamic imports would be fetched later, at runtime, so they ship too.
  for (const imported of entry.dynamicImports ?? []) collect(manifest, imported, seen, out);

  return out;
}

async function main() {
  const manifestPath = join(dist, '.vite', 'manifest.json');
  if (!(await exists(manifestPath))) {
    console.error('dist/.vite/manifest.json is missing. Run `npm run build -w web` first.');
    process.exit(1);
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

  for (const entry of ENTRIES) {
    if (!manifest[entry]) {
      console.error(`${entry} is not in the build manifest. Is it still a Vite input?`);
      process.exit(1);
    }
  }

  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });

  const files = new Set();
  for (const entry of ENTRIES) collect(manifest, entry, new Set(), files);

  for (const file of files) {
    const from = join(dist, file);
    if (!(await exists(from))) {
      console.error(`manifest lists ${file} but it is not in dist/`);
      process.exit(1);
    }
    const to = join(stage, file);
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to);
  }

  // The HTML itself is not listed as its own output file in the manifest.
  // Vite already emits relative asset URLs because of `base: './'`, so the
  // markup is copied as-is; that is what lets the same zip work on
  // https://localhost:8080/ and on Twitch's hashed CDN path.
  for (const entry of ENTRIES) {
    const html = await readFile(join(dist, entry), 'utf8');
    if (/(?:src|href)="\//.test(html)) {
      console.error(
        `${entry} contains absolute asset URLs. Twitch serves the zip from a ` +
          'sub-path, so the build must keep base: "./".',
      );
      process.exit(1);
    }
    await writeFile(join(stage, entry), html, 'utf8');
  }

  // Files the HTML references that are not Vite output: the diagnostics boot
  // script and the SMOKE_TEST stylesheet live in public/ and land in the dist
  // root as-is, so the manifest knows nothing about them. A page that loads
  // ./gtamap-boot.js from a zip without it would report nothing at all.
  const extra = new Set();
  for (const entry of ENTRIES) {
    const html = await readFile(join(dist, entry), 'utf8');
    for (const m of html.matchAll(/\s(?:src|href)="\.\/([^"]*)"/g)) {
      const ref = (m[1] ?? '').replace(/[?#].*$/, '');
      if (!ref || ref.startsWith('assets/')) continue;
      if (ref.split('/').includes('..')) {
        console.error(`${entry} references ./${ref}, which points outside the bundle.`);
        process.exit(1);
      }
      const from = join(dist, ref);
      if (!(await exists(from))) {
        console.error(`${entry} references ./${ref}, but dist/${ref} does not exist.`);
        process.exit(1);
      }
      extra.add(ref);
    }
  }
  for (const ref of extra) {
    const to = join(stage, ref);
    await mkdir(dirname(to), { recursive: true });
    await cp(join(dist, ref), to);
  }

  await rm(zipPath, { force: true });

  // No zip dependency: use whatever the platform provides.
  try {
    if (process.platform === 'win32') {
      execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Compress-Archive -Path '${join(stage, '*')}' -DestinationPath '${zipPath}' -Force`,
        ],
        { stdio: 'inherit' },
      );
    } else {
      execFileSync('zip', ['-r', '-q', zipPath, '.'], { cwd: stage, stdio: 'inherit' });
    }
  } catch (err) {
    console.error(
      `\nCould not create the zip automatically (${err.message}).\n` +
        `Zip the CONTENTS of ${stage} yourself — the HTML files must sit at the archive root.\n`,
    );
    process.exit(1);
  }

  const size = (await stat(zipPath)).size;
  console.log(
    `\nTwitch extension bundle: ${relative(process.cwd(), zipPath)} ` +
      `(${(size / 1024 / 1024).toFixed(2)} MB, ${files.size + ENTRIES.length + extra.size} files)`,
  );
  console.log('  Video - Fullscreen Path : video_overlay.html');
  console.log('  Mobile Path             : mobile.html');
  console.log('  Config Path             : config.html');

  if (!process.env.VITE_API_BASE) {
    console.warn(
      '\nWARNING: VITE_API_BASE was not set at build time.\n' +
        'The hosted bundle will call its own Twitch-hosted origin and fail.\n' +
        'Rebuild with VITE_API_BASE=https://your-api.example.com',
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

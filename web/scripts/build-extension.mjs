#!/usr/bin/env node
/**
 * Packages the Twitch extension bundle.
 *
 *   npm run ext:zip -w web
 *
 * Twitch hosts extension front-end files itself: you upload a zip whose ROOT
 * contains the HTML entry points. Only the viewer surface belongs in it — the
 * admin console, the OBS source and the streamer PWA stay on your own server.
 *
 * The bundle must call your backend cross-origin, so build it with
 * VITE_API_BASE pointing at the public HTTPS URL of the API, e.g.
 *
 *   VITE_API_BASE=https://api.example.com \
 *   VITE_MAPBOX_PUBLIC_TOKEN=pk.xxx \
 *   npm run build -w web && npm run ext:zip -w web
 */
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile, cp } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(webRoot, 'dist');
const stage = join(webRoot, 'extension-build');
const zipPath = join(webRoot, 'twitch-extension.zip');

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Assets referenced by viewer.html, walked transitively through the manifest. */
async function collectAssets(html) {
  const refs = new Set();
  for (const match of html.matchAll(/(?:src|href)="\/([^"]+)"/g)) {
    if (match[1]) refs.add(match[1]);
  }
  return refs;
}

async function main() {
  if (!(await exists(join(dist, 'viewer.html')))) {
    console.error('dist/viewer.html is missing. Run `npm run build -w web` first.');
    process.exit(1);
  }

  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });

  const html = await readFile(join(dist, 'viewer.html'), 'utf8');

  // Twitch serves the zip contents from the archive root, so viewer.html must
  // reference its assets relatively, not from "/".
  const rewritten = html.replace(/(src|href)="\//g, '$1="');
  await writeFile(join(stage, 'viewer.html'), rewritten, 'utf8');

  const refs = await collectAssets(html);
  for (const ref of refs) {
    const from = join(dist, ref);
    if (!(await exists(from))) continue;
    const to = join(stage, ref);
    await mkdir(dirname(to), { recursive: true });
    await cp(from, to, { recursive: true });
  }

  // Only what viewer.html actually references ships. The dist folder also holds
  // the admin console, the dev player and the OBS source, and none of those
  // belong in a bundle Twitch serves to every viewer.
  //
  // The <script>, <link rel="modulepreload"> and <link rel="stylesheet"> tags
  // Vite writes are the complete transitive set for this entry: the viewer uses
  // no dynamic import(), so nothing else is fetched at runtime from our origin.
  const shipped = [...refs].filter((ref) => ref.startsWith('assets/'));
  const skipped = (await readdir(join(dist, 'assets')).catch(() => [])).filter(
    (name) => !shipped.includes(`assets/${name}`),
  );
  console.log(`Bundled ${shipped.length} asset(s); left out ${skipped.length} from other surfaces.`);

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
        `Zip the CONTENTS of ${stage} yourself — viewer.html must sit at the archive root.\n`,
    );
    process.exit(1);
  }

  const size = (await stat(zipPath)).size;
  console.log(`\nTwitch extension bundle: ${relative(process.cwd(), zipPath)} (${(size / 1024 / 1024).toFixed(2)} MB)`);
  console.log('Upload it under Extension -> Files -> Asset Hosting.');
  console.log('Set the Video Overlay path to "viewer.html" (and the Mobile path too, if enabled).');
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

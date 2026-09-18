/**
 * Builds the extension pages for the screenshot harness into a scratch folder
 * (tools/ui-shots/out/build — never web/dist, never the release zip) and turns
 * that copy into something a local Chrome can drive:
 *
 *   - VITE_API_BASE points at the isolated demo API (127.0.0.1:4100)
 *   - VITE_DEV_MODE / VITE_SMOKE_TEST off, PUBLIC_BUILD on: the review build's flags
 *   - in the scratch copy only, the Twitch helper <script> is swapped for
 *     ./fake-helper.js, which signs an extension JWT with the test secret
 *   - the harness "player" page (video + OBS minimap + overlay iframe) is copied in
 *
 *   node tools/ui-shots/build.mjs
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
export const BUILD_DIR = join(HERE, 'out', 'build');

const TWITCH_HELPER_TAG = '<script src="https://extension-files.twitch.tv/helper/v1/twitch-ext.min.js"></script>';
const FAKE_HELPER_TAG = '<script src="./fake-helper.js"></script>';
const TWITCH_PAGES = ['video_overlay.html', 'mobile.html', 'panel.html', 'config.html'];
const HARNESS_FILES = ['fake-helper.js', 'harness-player.html', 'harness-player.css', 'harness-player.js'];

export function build() {
  const vite = join(REPO, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(vite)) throw new Error(`vite not found at ${vite} (npm install at the repo root)`);

  console.log(`[ui-build] vite build -> ${BUILD_DIR}`);
  const started = Date.now();
  const res = spawnSync(
    process.execPath,
    [vite, 'build', '--config', join(REPO, 'web', 'vite.config.ts'), '--outDir', BUILD_DIR, '--emptyOutDir', '--logLevel', 'warn'],
    {
      cwd: REPO,
      stdio: 'inherit',
      windowsHide: true,
      env: {
        ...process.env,
        VITE_API_BASE: 'http://127.0.0.1:4100',
        VITE_DEV_MODE: 'false',
        VITE_SMOKE_TEST: 'false',
        PUBLIC_BUILD: 'true',
        EXT_RELEASE: 'false',
      },
    },
  );
  if (res.status !== 0) throw new Error(`vite build failed (${res.status ?? res.signal})`);

  for (const page of TWITCH_PAGES) {
    const file = join(BUILD_DIR, page);
    const html = readFileSync(file, 'utf8');
    const parts = html.split(TWITCH_HELPER_TAG);
    if (parts.length !== 2) throw new Error(`${page}: expected exactly one Twitch helper tag, found ${parts.length - 1}`);
    writeFileSync(file, parts.join(FAKE_HELPER_TAG));
  }
  for (const name of HARNESS_FILES) copyFileSync(join(HERE, name), join(BUILD_DIR, name));

  console.log(`[ui-build] done in ${((Date.now() - started) / 1000).toFixed(1)} s (helper swapped in ${TWITCH_PAGES.length} pages)`);
  return BUILD_DIR;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    build();
  } catch (err) {
    console.error(`[ui-build] ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

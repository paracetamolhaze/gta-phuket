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
import { mkdir, readFile, readdir, rm, stat, writeFile, cp } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(webRoot, 'dist');
const stage = join(webRoot, 'extension-build');
const zipPath = join(webRoot, 'twitch-extension.zip');

/** The pages Twitch is configured to serve. Keep in sync with the console. */
const ENTRIES = ['video_overlay.html', 'mobile.html', 'config.html', 'panel.html'];

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Trailing `//# sourceMappingURL=…` / `/*# sourceMappingURL=… *\/` comments.
 * No .map file ever goes into the zip, so such a comment can only point at a
 * 404. Vite drops them from what it bundles, but a file it copies as an asset
 * keeps its own: the Mapbox CSP worker ends with one.
 */
const SOURCE_MAP_COMMENT = /(?:^|\r?\n)[ \t]*(?:\/\/[#@][ \t]*sourceMappingURL=[^\r\n]*|\/\*[#@][ \t]*sourceMappingURL=[^*]*\*\/)[ \t]*(?=\r?\n|$)/g;
let sourceMapCommentsDropped = 0;

/** cp, except that script and style files lose their source map comment. */
async function copyStaged(from, to) {
  if (/\.(?:m?js|css)$/i.test(from)) {
    const text = await readFile(from, 'utf8');
    const stripped = text.replace(SOURCE_MAP_COMMENT, '');
    if (stripped !== text) {
      sourceMapCommentsDropped += 1;
      await writeFile(to, stripped, 'utf8');
      return;
    }
  }
  // Byte for byte otherwise: vendor files ship exactly as published.
  await cp(from, to);
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
    await copyStaged(from, to);
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
    await copyStaged(join(dist, ref), to);
  }

  await rm(zipPath, { force: true });

  // Written here rather than by the platform's zip tool: Windows PowerShell's
  // Compress-Archive stores entry names with backslashes (`assets\x.js`), which
  // the ZIP spec forbids and which Twitch's CDN serves as flat files named
  // literally `assets\x.js` — every `./assets/…` URL in the HTML then 404s and
  // the extension never starts.
  const staged = (await walk(stage)).map((full) => ({
    full,
    name: relative(stage, full).split(sep).join('/'),
  }));
  await writeZip(zipPath, staged);

  // Never hand over an archive we have not read back.
  const names = await zipEntryNames(zipPath);
  const expected = staged.map((f) => f.name).sort();
  const backslashed = names.filter((n) => n.includes('\\'));
  if (backslashed.length || names.slice().sort().join('\n') !== expected.join('\n')) {
    console.error(
      `\nThe written zip does not match the staged bundle` +
        (backslashed.length ? ` (backslash paths: ${backslashed.join(', ')})` : '') +
        '. Refusing to use it.',
    );
    await rm(zipPath, { force: true });
    process.exit(1);
  }

  const size = (await stat(zipPath)).size;
  console.log(
    `\nTwitch extension bundle: ${relative(process.cwd(), zipPath)} ` +
      `(${(size / 1024 / 1024).toFixed(2)} MB, ${names.length} files, all paths use "/")`,
  );
  if (sourceMapCommentsDropped) {
    console.log(`  (dropped the source map comment from ${sourceMapCommentsDropped} file(s); no .map is shipped)`);
  }
  console.log('  Video - Fullscreen Path : video_overlay.html');
  console.log('  Mobile Path             : mobile.html');
  console.log('  Config Path             : config.html');
  console.log('  Panel Viewer Path       : panel.html');

  // The API base is compiled into the bundle, so the bundle is what to ask —
  // not this script's own environment, which is usually a different process.
  const overlay = await readFile(join(stage, 'video_overlay.html'), 'utf8');
  const apiBase = /<meta name="gtamap-boot"[^>]*\sdata-api-base="([^"]*)"/.exec(overlay)?.[1] ?? '';
  if (!apiBase) {
    console.warn(
      '\nWARNING: the bundle was built without VITE_API_BASE.\n' +
        'The hosted bundle will call its own Twitch-hosted origin and fail.\n' +
        'Rebuild with VITE_API_BASE=https://your-api.example.com',
    );
  } else {
    console.log(`  API base (compiled in)  : ${apiBase}`);
  }
}

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Minimal ZIP writer (APPNOTE 6.3): deflate or store, UTF-8 names, one fixed
// timestamp so an unchanged bundle produces an identical archive.
// ---------------------------------------------------------------------------

// zlib.crc32 exists from Node 20.15 / 22.2; package.json allows any Node 20.
let crcTable = null;
function crc32(data) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(data) >>> 0;
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1; // 2020-01-01
const UTF8_NAMES = 0x0800;

async function writeZip(target, entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { full, name } of entries.slice().sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const data = await readFile(full);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(data);
    const nameBytes = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(UTF8_NAMES, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);

    chunks.push(local, nameBytes, body);
    central.push(header, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }

  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);

  await writeFile(target, Buffer.concat([...chunks, ...central, end]));
}

/** Entry names exactly as stored in the central directory. */
async function zipEntryNames(file) {
  const buf = await readFile(file);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('zip has no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error('corrupt central directory');
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    names.push(buf.subarray(at + 46, at + 46 + nameLength).toString('utf8'));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

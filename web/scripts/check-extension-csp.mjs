#!/usr/bin/env node
/**
 * Fails the build when the Twitch extension bundle contains something the
 * extension CSP will reject once it is hosted.
 *
 *   npm run ext:check -w web        (run after ext:zip)
 *   node scripts/check-extension-csp.mjs --final
 *                                   (the review gate; npm run ext:build runs it)
 *
 * This exists because none of these problems are visible locally: a plain page
 * has no CSP, so a blob: worker or an eval() works perfectly on
 * https://localhost:8080 and only dies after upload, as a blank map with a
 * console error nobody is watching.
 *
 * Checked against the staged bundle in web/extension-build, which is exactly
 * what goes into the zip.
 *
 * --final adds what only matters for the zip that goes to Twitch review:
 *
 *   - nothing is staged but the three pages, gtamap-boot.js and assets/*
 *     (gtamap-raw.css only in a SMOKE_TEST build, which --final refuses anyway)
 *   - no *.map files and no sourceMappingURL comments
 *   - no http(s)/ws(s) URL pointing at localhost or 127.x — URLs, not the word:
 *     socket.io's own "localhost" fallback hostname is fine
 *   - no "/api/dev" reference (the local simulator's endpoints)
 *   - no admin / streamer / obs / dev (or any other non-Twitch) entry chunk
 *   - every page's boot meta says data-dev="false" and data-smoke="false", its
 *     API base is an https origin, and there is no raw smoke button
 *   - web/twitch-extension.zip has the files at its root (no wrapping folder),
 *     forward-slash names, and exactly the staged files, byte for byte
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stage = join(webRoot, 'extension-build');
const zipPath = join(webRoot, 'twitch-extension.zip');
const manifestPath = join(webRoot, 'dist', '.vite', 'manifest.json');

const FINAL = process.argv.slice(2).includes('--final');

/** The pages Twitch is configured to serve. Keep in sync with build-extension.mjs. */
const ENTRIES = ['video_overlay.html', 'mobile.html', 'config.html'];

/**
 * Hosts Twitch allows without an allowlist entry. Everything else found in a
 * <script src> is a finding, because the extension CSP only permits scripts
 * from the extension's own origin plus Twitch's own helper.
 */
const ALLOWED_SCRIPT_HOSTS = ['extension-files.twitch.tv'];
const TWITCH_HELPER_SRC = 'https://extension-files.twitch.tv/helper/v1/twitch-ext.min.js';

const JS_RULES = [
  {
    id: 'blob-worker',
    // `new Worker(URL.createObjectURL(new Blob([...])))` — the default
    // mapbox-gl build does this, and Twitch's CSP denies it.
    pattern: /createObjectURL\s*\(\s*new\s+Blob/,
    message: 'builds a script from a Blob URL (Twitch CSP denies blob: workers)',
  },
  {
    id: 'blob-worker-indirect',
    pattern: /new\s+Worker\s*\(\s*["'`]blob:/,
    message: 'constructs a Worker from a blob: URL',
  },
  {
    id: 'eval',
    // Word-boundary so `.evaluate(`, `safeEval` and similar do not trip it.
    pattern: /(?<![.\w$])eval\s*\(/,
    message: 'calls eval() (forbidden by the Twitch extension CSP)',
  },
  {
    id: 'new-function',
    pattern: /new\s+Function\s*\(/,
    message: 'calls new Function() (an eval by another name)',
  },
  {
    id: 'document-write',
    pattern: /document\s*\.\s*write\s*\(/,
    message: 'calls document.write()',
  },
];

const HTML_RULES = [
  {
    id: 'inline-script',
    // A <script> with no src and a non-empty body.
    pattern: /<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i,
    message: 'contains an inline <script> (no nonce is available under Twitch CSP)',
  },
  {
    id: 'inline-handler',
    pattern: /<[^>]+\son(?:click|load|error|submit|change|mouseover)\s*=/i,
    message: 'contains an inline event handler attribute',
  },
  {
    id: 'absolute-asset',
    pattern: /(?:src|href)="\/(?!\/)/,
    message: 'references an asset from the domain root (Twitch serves from a sub-path)',
  },
];

// ---------------------------------------------------------------------------
// --final rules
// ---------------------------------------------------------------------------

/** Text files every --final content rule reads. */
const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.html', '.css']);

const FINAL_TEXT_RULES = [
  {
    id: 'source-map-comment',
    // The comment form only: a library that merely mentions the word (a
    // source-map parser, say) is not pointing the browser at anything.
    pattern: /(?:\/\/|\/\*)[#@][ \t]*sourceMappingURL[ \t]*=/,
    message: 'carries a sourceMappingURL comment (no .map file ships in the zip)',
  },
  {
    id: 'localhost-url',
    // A URL whose host is loopback. The lookahead keeps "localhost.example"
    // out, and the bare word (engine.io's default hostname) never matches.
    pattern:
      /\b(?:https?|wss?):\/\/(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\])(?![\w.-])/i,
    message: 'contains a URL pointing at localhost / 127.0.0.1',
  },
  {
    id: 'dev-api',
    pattern: /\/api\/dev(?![\w-])/,
    message: 'references /api/dev (the local simulator, 404 on the public backend)',
  },
];

/** Where a staged file may live. Anything else is not the extension's. */
function stagedFileAllowed(rel, smoke) {
  if (ENTRIES.includes(rel) || rel === 'gtamap-boot.js') return true;
  if (rel === 'gtamap-raw.css') return smoke;
  return /^assets\/[^/]+$/.test(rel) && !rel.endsWith('.map');
}

/** Entry chunk names of the surfaces that must never reach viewers. */
const FOREIGN_ENTRY_CHUNK = /^assets\/(?:admin|streamer|obs|dev)-[\w-]{8}\.(?:js|css)$/;

/** `<meta name="gtamap-boot" …>`, as a map of its data-* attributes. */
function bootMeta(html) {
  const tag = /<meta\s[^>]*name="gtamap-boot"[^>]*>/i.exec(html);
  if (!tag) return null;
  const attrs = {};
  for (const m of tag[0].matchAll(/\sdata-([\w-]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
  return { attrs, index: tag.index };
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

// ---------------------------------------------------------------------------
// ZIP reading (central directory only; what build-extension.mjs writes)
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

/** Entries exactly as the central directory records them. */
function zipEntries(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('no end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) {
      throw new Error('corrupt central directory');
    }
    const crc = buf.readUInt32LE(at + 16);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    entries.push({ name: buf.subarray(at + 46, at + 46 + nameLength).toString('utf8'), crc, size });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function checkZip(stagedRels, findings) {
  let buf;
  try {
    buf = await readFile(zipPath);
  } catch {
    findings.push({ rel: 'twitch-extension.zip', rule: 'zip-missing', message: 'the zip does not exist', line: 0 });
    return 0;
  }

  let entries;
  try {
    entries = zipEntries(buf);
  } catch (err) {
    findings.push({ rel: 'twitch-extension.zip', rule: 'zip-corrupt', message: String(err.message), line: 0 });
    return 0;
  }

  const zipFinding = (rule, message) => findings.push({ rel: 'twitch-extension.zip', rule, message, line: 0 });
  const names = entries.map((e) => e.name);

  const badNames = names.filter(
    (n) => n.includes('\\') || n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').includes('..'),
  );
  if (badNames.length) {
    zipFinding('zip-path', `entry names must be relative with "/" separators: ${badNames.join(', ')}`);
  }
  const dirs = names.filter((n) => n.endsWith('/'));
  if (dirs.length) zipFinding('zip-path', `directory entries are not expected: ${dirs.join(', ')}`);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length) zipFinding('zip-path', `duplicate entries: ${[...new Set(dupes)].join(', ')}`);

  // Twitch looks for the viewer paths at the root of the archive. A zip of the
  // folder instead of its contents puts them under "extension-build/…".
  const missingRoot = ENTRIES.filter((page) => !names.includes(page));
  if (missingRoot.length) {
    const nested = names.filter((n) => ENTRIES.includes(n.split('/').pop() ?? ''));
    zipFinding(
      'zip-root',
      `${missingRoot.join(', ')} not at the zip root` + (nested.length ? ` (found: ${nested.join(', ')})` : ''),
    );
  }

  const inZip = new Set(names);
  const inStage = new Set(stagedRels);
  const onlyZip = names.filter((n) => !inStage.has(n));
  const onlyStage = stagedRels.filter((n) => !inZip.has(n));
  if (onlyZip.length) zipFinding('zip-contents', `in the zip but not staged: ${onlyZip.join(', ')}`);
  if (onlyStage.length) zipFinding('zip-contents', `staged but not in the zip: ${onlyStage.join(', ')}`);

  // Same names are not enough: a zip left over from an older build has them too.
  const stale = [];
  for (const entry of entries) {
    if (!inStage.has(entry.name)) continue;
    const data = await readFile(join(stage, ...entry.name.split('/')));
    if (data.length !== entry.size || crc32(data) !== entry.crc) stale.push(entry.name);
  }
  if (stale.length) {
    zipFinding('zip-stale', `differs from the staged file: ${stale.join(', ')} — run npm run ext:zip again`);
  }
  return entries.length;
}

// ---------------------------------------------------------------------------

async function walk(dir, out = []) {
  for (const name of await readdir(dir)) {
    const full = join(dir, name);
    const info = await stat(full);
    if (info.isDirectory()) await walk(full, out);
    else out.push(full);
  }
  return out;
}

async function main() {
  let files;
  try {
    files = await walk(stage);
  } catch {
    console.error(
      `extension-build/ is missing. Run:\n` +
        `  npm run build -w web && npm run ext:zip -w web`,
    );
    process.exit(1);
  }

  const findings = [];
  let workerShipped = false;
  let scanned = 0;
  const rels = files.map((file) => relative(stage, file).replace(/\\/g, '/'));
  const pages = new Map();

  for (const file of files) {
    const rel = relative(stage, file).replace(/\\/g, '/');
    const ext = extname(file);
    if (!TEXT_EXTENSIONS.has(ext)) continue;
    // Without --final only scripts and pages are read, exactly as before.
    if (!FINAL && ext === '.css') continue;

    const text = await readFile(file, 'utf8');
    scanned += 1;

    if (/mapbox-gl-csp-worker/.test(rel) && ext !== '.css') workerShipped = true;

    if (FINAL) {
      for (const rule of FINAL_TEXT_RULES) {
        const match = rule.pattern.exec(text);
        if (!match) continue;
        findings.push({ rel, rule: rule.id, message: rule.message, line: lineOf(text, match.index) });
      }
    }
    if (ext === '.css') continue;

    const rules = ext === '.html' ? HTML_RULES : JS_RULES;
    for (const rule of rules) {
      const match = rule.pattern.exec(text);
      if (!match) continue;
      findings.push({ rel, rule: rule.id, message: rule.message, line: lineOf(text, match.index) });
    }

    if (ext === '.html') {
      pages.set(rel, text);

      // Twitch reports "Extension Helper Library Not Loaded" when anything runs
      // ahead of its helper, so on a Twitch page it must be the first script.
      const firstScript = /<script\b[^>]*>/i.exec(text);
      const firstSrc = firstScript && /\ssrc="([^"]+)"/i.exec(firstScript[0]);
      if (!firstSrc || firstSrc[1] !== TWITCH_HELPER_SRC) {
        findings.push({
          rel,
          rule: 'helper-not-first',
          message: `the first <script> must be ${TWITCH_HELPER_SRC}`,
          line: firstScript ? lineOf(text, firstScript.index) : 0,
        });
      }

      // The diagnostics boot script comes straight after the helper, as a
      // classic script from our own origin: it registers the helper callbacks
      // and reports everything that happens after it, so nothing of ours may
      // run before it — and a module would run after the whole document.
      const scripts = [...text.matchAll(/<script\b[^>]*>/gi)];
      const second = scripts[1];
      const secondSrc = second && /\ssrc="([^"]+)"/i.exec(second[0]);
      if (
        !second ||
        !secondSrc ||
        !/^\.\/gtamap-boot\.js(?:\?[^"#]*)?$/.test(secondSrc[1] ?? '') ||
        /\stype="module"/i.test(second[0])
      ) {
        findings.push({
          rel,
          rule: 'boot-not-second',
          message: 'the second <script> must be the classic ./gtamap-boot.js',
          line: second ? lineOf(text, second.index) : 0,
        });
      }

      // Every relative reference has to be in the zip, including the files
      // that come from public/ rather than from the Vite manifest.
      for (const m of text.matchAll(/\s(?:src|href)="\.\/([^"]*)"/g)) {
        const ref = (m[1] ?? '').replace(/[?#].*$/, '');
        if (!ref || files.includes(join(stage, ref))) continue;
        findings.push({
          rel,
          rule: 'missing-file',
          message: `references ./${ref}, which is not in the bundle`,
          line: lineOf(text, m.index),
        });
      }

      for (const m of text.matchAll(/<script[^>]*\ssrc="([^"]+)"/gi)) {
        const src = m[1] ?? '';
        if (!/^https?:\/\//i.test(src)) continue;
        const host = new URL(src).host;
        if (ALLOWED_SCRIPT_HOSTS.includes(host)) continue;
        findings.push({
          rel,
          rule: 'external-script',
          message: `loads a script from ${host}, which the CSP will block`,
          line: lineOf(text, m.index),
        });
      }
    }
  }

  // The map silently dies without the worker, so a missing one is a failure,
  // not a warning.
  if (!workerShipped) {
    findings.push({
      rel: 'extension-build/',
      rule: 'missing-worker',
      message: 'the Mapbox CSP worker is not in the bundle — the map will never start',
      line: 0,
    });
  }

  let zipCount = 0;
  if (FINAL) zipCount = await finalChecks(rels, pages, findings);

  const mode = FINAL ? 'Final check' : 'CSP check';
  if (findings.length) {
    console.error(`\n${mode} FAILED — ${findings.length} finding(s) in ${scanned} file(s):\n`);
    for (const f of findings) {
      console.error(`  ${f.rel}${f.line ? `:${f.line}` : ''}\n    [${f.rule}] ${f.message}`);
    }
    console.error('');
    process.exit(1);
  }

  console.log(
    `CSP check passed: ${scanned} file(s), no blob workers, no eval, ` +
      `no inline scripts, helper first and boot script second, Mapbox CSP worker present.`,
  );
  if (FINAL) {
    console.log(
      `Final check passed: ${rels.length} staged file(s) = ${zipCount} zip entries at the root with "/" names, ` +
        'only extension files, no source maps, no localhost URLs, no /api/dev, no admin/streamer/obs/dev chunks, ' +
        'DEV_MODE and SMOKE_TEST off, no raw smoke button.',
    );
  }
}

/** Everything --final adds on top of the CSP rules. Returns the zip's entry count. */
async function finalChecks(rels, pages, findings) {
  for (const page of ENTRIES) {
    if (!rels.includes(page)) {
      findings.push({ rel: page, rule: 'page-missing', message: 'is not in the bundle', line: 0 });
    }
  }
  if (!rels.includes('gtamap-boot.js')) {
    findings.push({ rel: 'gtamap-boot.js', rule: 'page-missing', message: 'is not in the bundle', line: 0 });
  }

  // Build flags, from the pages themselves: they are what Twitch will serve.
  let smoke = false;
  for (const page of ENTRIES) {
    const html = pages.get(page);
    if (html === undefined) continue;
    const meta = bootMeta(html);
    if (!meta) {
      findings.push({ rel: page, rule: 'boot-meta', message: 'has no <meta name="gtamap-boot">', line: 0 });
      continue;
    }
    const line = lineOf(html, meta.index);
    const { attrs } = meta;
    if (attrs.smoke !== 'false') {
      if (attrs.smoke === 'true') smoke = true;
      findings.push({ rel: page, rule: 'smoke-on', message: `data-smoke="${attrs.smoke ?? ''}" (must be "false")`, line });
    }
    if (attrs.dev !== 'false') {
      findings.push({ rel: page, rule: 'dev-on', message: `data-dev="${attrs.dev ?? ''}" (must be "false")`, line });
    }
    // Twitch serves the files from its own CDN origin, so an empty API base
    // would send every call there.
    const base = attrs['api-base'] ?? '';
    if (!/^https:\/\/[^/?#\s]+$/.test(base)) {
      findings.push({
        rel: page,
        rule: 'api-base',
        message: `data-api-base="${base}" (must be the https:// origin of the backend)`,
        line,
      });
    }
    const raw = /id="gtamap-raw-trigger"|gtamap-raw\.css/.exec(html);
    if (raw) {
      findings.push({
        rel: page,
        rule: 'raw-button',
        message: 'carries the SMOKE_TEST raw button or its stylesheet',
        line: lineOf(html, raw.index),
      });
    }
  }

  for (const rel of rels) {
    if (rel.endsWith('.map')) {
      findings.push({ rel, rule: 'source-map-file', message: 'is a source map (never shipped)', line: 0 });
    } else if (!stagedFileAllowed(rel, smoke)) {
      findings.push({
        rel,
        rule: 'foreign-file',
        message: 'is not an extension file (only the three pages, gtamap-boot.js and assets/*)',
        line: 0,
      });
    }
    if (FOREIGN_ENTRY_CHUNK.test(rel)) {
      findings.push({ rel, rule: 'foreign-entry', message: 'is the entry chunk of a non-Twitch page', line: 0 });
    }
  }

  // The manifest names every entry's own files precisely, whatever they are
  // called; the name pattern above only catches the obvious ones.
  let manifest = null;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    findings.push({
      rel: 'dist/.vite/manifest.json',
      rule: 'manifest-missing',
      message: 'cannot be read, so the staged files cannot be matched to their entries',
      line: 0,
    });
  }
  if (manifest) {
    const staged = new Set(rels);
    for (const [key, entry] of Object.entries(manifest)) {
      if (!entry || !entry.isEntry || ENTRIES.includes(key)) continue;
      for (const file of [entry.file, ...(entry.css ?? [])]) {
        if (file && staged.has(file)) {
          findings.push({ rel: file, rule: 'foreign-entry', message: `is the entry of ${key}`, line: 0 });
        }
      }
    }
  }

  return checkZip(rels, findings);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

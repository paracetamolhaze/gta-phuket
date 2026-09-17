#!/usr/bin/env node
/**
 * Fails the build when the Twitch extension bundle contains something the
 * extension CSP will reject once it is hosted.
 *
 *   npm run ext:check -w web        (run after ext:zip)
 *
 * This exists because none of these problems are visible locally: a plain page
 * has no CSP, so a blob: worker or an eval() works perfectly on
 * https://localhost:8080 and only dies after upload, as a blank map with a
 * console error nobody is watching.
 *
 * Checked against the staged bundle in web/extension-build, which is exactly
 * what goes into the zip.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stage = join(webRoot, 'extension-build');

/**
 * Hosts Twitch allows without an allowlist entry. Everything else found in a
 * <script src> is a finding, because the extension CSP only permits scripts
 * from the extension's own origin plus Twitch's own helper.
 */
const ALLOWED_SCRIPT_HOSTS = ['extension-files.twitch.tv'];

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

  for (const file of files) {
    const rel = relative(stage, file).replace(/\\/g, '/');
    const ext = extname(file);
    if (ext !== '.js' && ext !== '.html' && ext !== '.mjs') continue;

    const text = await readFile(file, 'utf8');
    scanned += 1;

    if (/mapbox-gl-csp-worker/.test(rel)) workerShipped = true;

    const rules = ext === '.html' ? HTML_RULES : JS_RULES;
    for (const rule of rules) {
      const match = rule.pattern.exec(text);
      if (!match) continue;
      const line = text.slice(0, match.index).split('\n').length;
      findings.push({ rel, rule: rule.id, message: rule.message, line });
    }

    if (ext === '.html') {
      for (const m of text.matchAll(/<script[^>]*\ssrc="([^"]+)"/gi)) {
        const src = m[1] ?? '';
        if (!/^https?:\/\//i.test(src)) continue;
        const host = new URL(src).host;
        if (ALLOWED_SCRIPT_HOSTS.includes(host)) continue;
        findings.push({
          rel,
          rule: 'external-script',
          message: `loads a script from ${host}, which the CSP will block`,
          line: text.slice(0, m.index).split('\n').length,
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

  if (findings.length) {
    console.error(`\nCSP check FAILED — ${findings.length} finding(s) in ${scanned} file(s):\n`);
    for (const f of findings) {
      console.error(`  ${f.rel}${f.line ? `:${f.line}` : ''}\n    [${f.rule}] ${f.message}`);
    }
    console.error('');
    process.exit(1);
  }

  console.log(
    `CSP check passed: ${scanned} file(s), no blob workers, no eval, ` +
      `no inline scripts, Mapbox CSP worker present.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { pickTwitchParams, redactString, urlToOriginPath } from './sanitize.js';
import type { RequestLogEntry } from './schema.js';

/**
 * Reading one line of the ingress access log (docs/EXTENSION_DIAGNOSTICS.md §4).
 *
 * The request log is the one source that depends on nothing in the page: if
 * Twitch asked for /video_overlay.html, this sees it even when not a single
 * script in the iframe ran. Only requests that say something about the
 * extension are kept, and only the fields that answer "did Twitch load it,
 * from where, as what" — no IP, no other headers, no other query parameters.
 *
 * Pure; ./ingest.ts owns the socket.
 */

export const MAX_LINE_BYTES = 64 * 1024;

/** The pages of each Twitch surface, under both the file name and the friendly URL. */
export const SURFACE_PAGES = {
  video_overlay: ['/video_overlay.html', '/video_overlay'],
  mobile: ['/mobile.html', '/mobile'],
  config: ['/config.html', '/config'],
} as const satisfies Record<string, readonly string[]>;

/** Every Twitch page. */
export const TWITCH_PAGES: ReadonlySet<string> = new Set(Object.values(SURFACE_PAGES).flat());

/** The two non-hashed files every Twitch page loads first. */
const BOOT_FILES: ReadonlySet<string> = new Set(['/gtamap-boot.js', '/gtamap-raw.css']);

/** Sec-Fetch-* values are short lowercase tokens; anything else is not one. */
const FETCH_TOKEN_RE = /^[a-z-]{1,32}$/;

/** A day either way: further off is a broken clock or a forgery. */
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Caddy logs headers as canonical names with arrays of values; the dev server
 * may send plain strings. Case-insensitive either way.
 */
function header(headers: Json, name: string): string | null {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) continue;
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
    return null;
  }
  return null;
}

function fetchToken(v: string | null): string | null {
  return v && FETCH_TOKEN_RE.test(v) ? v : null;
}

/** Caddy writes epoch seconds as a float; accept ms and ISO strings too. */
function parseTs(v: unknown, now: number): Date {
  let ms: number | null = null;
  if (typeof v === 'number' && Number.isFinite(v)) {
    ms = v > 1e12 ? v : v * 1000;
  } else if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) ms = n > 1e12 ? n : n * 1000;
    else {
      const parsed = Date.parse(v);
      if (!Number.isNaN(parsed)) ms = parsed;
    }
  }
  // The row is still worth having; it just gets the time it reached us.
  if (ms === null || Math.abs(ms - now) > MAX_CLOCK_SKEW_MS) ms = now;
  return new Date(Math.round(ms));
}

function pathnameOf(originPath: string): string | null {
  try {
    return new URL(originPath).pathname;
  } catch {
    return null;
  }
}

/**
 * One JSON access-log line to a request-log entry, or null when the line is
 * malformed or the request is not about the extension.
 */
export function parseAccessLogLine(line: string, now = Date.now()): RequestLogEntry | null {
  if (line.length > MAX_LINE_BYTES || Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) return null;

  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(obj) || !isRecord(obj.request)) return null;
  const req = obj.request;
  if (typeof req.uri !== 'string' || !req.uri) return null;

  let url: URL;
  try {
    // A throwaway base: only the path and the query are read.
    url = new URL(req.uri, 'http://ingress.invalid');
  } catch {
    return null;
  }
  const pathname = url.pathname;
  const headers = isRecord(req.headers) ? req.headers : {};
  const rawReferer = header(headers, 'Referer');
  const referer = rawReferer ? urlToOriginPath(rawReferer) : null;

  let kept = TWITCH_PAGES.has(pathname) || BOOT_FILES.has(pathname);
  if (!kept && pathname.startsWith('/assets/') && referer) {
    // A hashed asset only matters when a Twitch page asked for it: that is
    // the proof the bundle itself was fetched, and with which status.
    const from = pathnameOf(referer);
    kept = from !== null && TWITCH_PAGES.has(from);
  }
  if (!kept) return null;

  // The pathname is scrubbed on its own (an /assets/ name is the client's
  // choice); the query is rebuilt from the whitelist, so it needs nothing more.
  const params = new URLSearchParams(pickTwitchParams((name) => url.searchParams.get(name)));
  const query = params.toString();
  const safePathname = redactString(pathname, 200);
  const path = (query ? `${safePathname}?${query}` : safePathname).slice(0, 600);

  const status =
    typeof obj.status === 'number' && Number.isInteger(obj.status) && obj.status >= 0 && obj.status < 1000
      ? obj.status
      : null;
  const method =
    typeof req.method === 'string' && /^[A-Za-z]{1,10}$/.test(req.method) ? req.method.toUpperCase() : 'GET';
  const userAgent = header(headers, 'User-Agent');

  return {
    ts: parseTs(obj.ts, now),
    source: obj.source === 'devserver' ? 'devserver' : 'ingress',
    method,
    path,
    status,
    referer: referer ? redactString(referer) : null,
    secFetchDest: fetchToken(header(headers, 'Sec-Fetch-Dest')),
    secFetchSite: fetchToken(header(headers, 'Sec-Fetch-Site')),
    userAgent: userAgent ? redactString(userAgent) : null,
  };
}

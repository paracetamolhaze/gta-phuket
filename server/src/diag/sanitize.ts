import { z } from 'zod';
import {
  DIAG_EVENT_NAMES,
  DIAG_SURFACES,
  DOC_VISIBILITIES,
  LIMITS,
  TWITCH_PARAMS,
  VIEWER_KINDS,
  type CleanBatch,
  type CleanEvent,
  type DiagSnapshot,
  type TwitchParam,
} from './schema.js';

/**
 * Validation and redaction for the diagnostics the extension page reports.
 *
 * POST /api/diag/ext is unauthenticated on purpose — it has to work before
 * Twitch has authorised anyone — so every byte of it is attacker-controlled.
 * The page is also running next to real Twitch credentials, and a careless
 * error message can carry one. So the rules are: the structure is validated
 * strictly, and every free-form value is bounded and scrubbed of anything that
 * looks like a credential before it gets anywhere near the database.
 *
 * Everything here is pure, so it can be tested without Postgres or Redis.
 */

/** Keys whose value is never kept, whatever it looks like. */
const SECRET_KEY_RE = /token|jwt|secret|password|cookie|authorization|helix/i;
/** The viewer is reduced to a kind; their ids never leave the page. */
const USER_ID_KEY_RE = /^(opaque_?)?user_?id$/i;
/** Keys that would reach Object.prototype through a plain assignment. */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const CHANNEL_ID_KEY_RE = /^channel_?id$/i;
const CHANNEL_ID_RE = /^\d{1,20}$/;

const URL_RE = /\b(?:https?|wss?):\/\/[^\s"'<>`()[\]{}]+/gi;
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?/g;
const BEARER_RE = /\bBearer\s+[^\s"',;]+/gi;
// Twitch user access tokens are 30 alphanumerics. "OAuth failed" must survive.
const OAUTH_RE = /\bOAuth\s+[A-Za-z0-9]{20,}/g;
// token=…, "helixToken":"…", secret: … — the name is enough to condemn the value.
const SECRET_PAIR_RE =
  /\b([A-Za-z_]*(?:token|jwt|secret|password|authorization|helix)[A-Za-z_]*)("?\s*[=:]\s*"?)[^\s"&,;]+/gi;
// A query string or fragment that survived URL stripping, e.g. "/api/x?token=…".
const QUERY_RE = /[?#][^\s"'<>`]*=[^\s"'<>`]*/g;
// Half of a surrogate pair on its own. JSON.stringify writes it as a \udXXX
// escape, and Postgres rejects that escape in jsonb — failing the whole batch
// INSERT, and with it every other event of the batch.
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Lone surrogates become U+FFFD, so the string is valid in jsonb. */
export function wellFormed(s: string): string {
  return s.replace(LONE_SURROGATE_RE, '�');
}

/** At most `max` UTF-16 units, never cutting a surrogate pair in half. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = s.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * `origin + path` of an absolute URL: no userinfo, no query, no fragment.
 * Null when it is not an absolute URL at all.
 */
export function urlToOriginPath(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.origin === 'null') return null;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

/**
 * Bound a string and remove anything credential-shaped from it: URLs lose
 * their query and fragment, JWTs and bearer tokens are replaced, and any
 * `name=value` whose name says secret loses its value.
 */
export function redactString(input: string, max: number = LIMITS.string): string {
  // Nothing legitimate is anywhere near this long, and the patterns below
  // should not run over 32 KB of text somebody else chose.
  let s = wellFormed(input.length > max * 4 ? input.slice(0, max * 4) : input);
  s = s.replace(URL_RE, (m) => urlToOriginPath(m) ?? m.replace(/[?#][\s\S]*$/, ''));
  s = s.replace(JWT_RE, '[jwt]');
  s = s.replace(BEARER_RE, 'Bearer [redacted]');
  s = s.replace(OAUTH_RE, 'OAuth [redacted]');
  s = s.replace(SECRET_PAIR_RE, '$1$2[redacted]');
  s = s.replace(QUERY_RE, '');
  return truncate(s, max);
}

/**
 * An origin as the page reported it (location.origin, the referrer's origin,
 * location.ancestorOrigins): `scheme://host[:port]`, or the literal "null" of
 * an opaque (sandboxed) origin. Anything that is not one is dropped rather
 * than stored: the page only ever sends origins here.
 */
export function toOrigin(value: string): string | null {
  const v = value.trim();
  if (v === 'null') return 'null';
  try {
    const url = new URL(v);
    if (url.origin !== 'null') return truncate(url.origin, LIMITS.string);
    // Non-special schemes (capacitor:// in the Twitch mobile app) have an
    // opaque origin in WHATWG terms; scheme + host is still what was reported.
    return url.host ? truncate(wellFormed(`${url.protocol}//${url.host}`), LIMITS.string) : null;
  } catch {
    return null;
  }
}

/** A Twitch channel id is digits; anything else is not worth keeping. */
export function toChannelId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  if (typeof value === 'string' && CHANNEL_ID_RE.test(value)) return value;
  return null;
}

function isKeptKey(key: string): boolean {
  return !UNSAFE_KEYS.has(key) && !SECRET_KEY_RE.test(key) && !USER_ID_KEY_RE.test(key);
}

/**
 * Deep-clean one free-form value. `depth` is the depth of the value itself:
 * an event's `data` object is 1, so objects nested deeper than LIMITS.depth
 * are cut off. Returns undefined for values JSON cannot hold.
 */
export function cleanValue(value: unknown, depth = 1): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
      return redactString(value);
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'boolean':
      return value;
    case 'object':
      break;
    default:
      return undefined;
  }
  if (depth > LIMITS.depth) return '[…]';
  if (Array.isArray(value)) {
    return value.slice(0, LIMITS.array).map((item) => {
      const cleaned = cleanValue(item, depth + 1);
      return cleaned === undefined ? null : cleaned;
    });
  }
  return cleanObject(value as Record<string, unknown>, depth);
}

/** Deep-clean an object: secret and identity keys dropped, sizes bounded. */
export function cleanObject(obj: Record<string, unknown>, depth = 1): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let kept = 0;
  for (const [rawKey, raw] of Object.entries(obj)) {
    if (kept >= LIMITS.keys) break;
    if (!isKeptKey(rawKey)) continue;
    // Keys land in jsonb as well, so they get the same surrogate treatment.
    const key = wellFormed(truncate(rawKey, 64));
    const cleaned = CHANNEL_ID_KEY_RE.test(key) ? toChannelId(raw) : cleanValue(raw, depth + 1);
    if (cleaned === undefined) continue;
    out[key] = cleaned;
    kept += 1;
  }
  return out;
}

/** Only the Twitch query parameters from TWITCH_PARAMS, short strings only. */
export function pickTwitchParams(
  get: (name: TwitchParam) => unknown,
): Partial<Record<TwitchParam, string>> {
  const out: Partial<Record<TwitchParam, string>> = {};
  for (const name of TWITCH_PARAMS) {
    const value = get(name);
    if (typeof value === 'string' && value) out[name] = redactString(value, 64);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wire schema
// ---------------------------------------------------------------------------

const finite = z.number().finite();
const optBool = z.boolean().optional().catch(undefined);
const optNullableBool = z.boolean().nullable().optional().catch(undefined);
const optNullableString = z.string().nullable().optional().catch(undefined);

/**
 * A snapshot field of the wrong type is dropped rather than failing the batch:
 * one odd value from a half-broken page should not cost the events around it,
 * which are exactly the ones worth reading.
 */
const snapSchema = z.object({
  stage: z.enum(['boot', 'app']).optional().catch(undefined),
  viewport: z
    .object({ w: finite, h: finite, dpr: finite.optional().catch(undefined) })
    .optional()
    .catch(undefined),
  docVisibility: z.enum(DOC_VISIBILITIES).optional().catch(undefined),
  twitchVisible: optNullableBool,
  highlighted: optNullableBool,
  helperPresent: optBool,
  helperVersion: optNullableString,
  authorized: optBool,
  channelId: z.unknown().optional(),
  viewerKind: z.enum(VIEWER_KINDS).optional().catch(undefined),
  framed: optBool,
  pageOrigin: optNullableString,
  referrerOrigin: optNullableString,
  ancestorOrigins: z.array(z.unknown()).optional().catch(undefined),
  params: z.record(z.unknown()).optional().catch(undefined),
  smoke: optBool,
  dev: optBool,
  triggerVisible: optNullableBool,
});

const eventSchema = z.object({
  event: z.enum(DIAG_EVENT_NAMES),
  t: finite.optional().catch(undefined),
  seq: z.number().int().min(0).max(1_000_000_000).optional().catch(undefined),
  snap: snapSchema.optional().catch(undefined),
  data: z.record(z.unknown()).optional().catch(undefined),
});

const batchSchema = z.object({
  v: z.literal(1),
  session: z.string().regex(/^[A-Za-z0-9_-]{8,40}$/),
  surface: z.enum(DIAG_SURFACES),
  events: z.array(eventSchema).min(1).max(LIMITS.eventsPerBatch),
});

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function cleanNullableString(v: string | null | undefined): string | null | undefined {
  if (v === undefined || v === null) return v;
  return redactString(v);
}

function cleanSnap(snap: z.infer<typeof snapSchema> | undefined): Partial<DiagSnapshot> {
  const out: Partial<DiagSnapshot> = {};
  if (!snap) return out;

  if (snap.stage) out.stage = snap.stage;
  if (snap.viewport) {
    out.viewport = {
      w: Math.round(clamp(snap.viewport.w, 0, 100_000)),
      h: Math.round(clamp(snap.viewport.h, 0, 100_000)),
      dpr: Math.round(clamp(snap.viewport.dpr ?? 1, 0, 16) * 100) / 100,
    };
  }
  if (snap.docVisibility) out.docVisibility = snap.docVisibility;
  if (snap.twitchVisible !== undefined) out.twitchVisible = snap.twitchVisible;
  if (snap.highlighted !== undefined) out.highlighted = snap.highlighted;
  if (snap.helperPresent !== undefined) out.helperPresent = snap.helperPresent;
  const helperVersion = cleanNullableString(snap.helperVersion);
  if (helperVersion !== undefined) out.helperVersion = helperVersion === null ? null : truncate(helperVersion, 40);
  if (snap.authorized !== undefined) out.authorized = snap.authorized;
  if (snap.channelId !== undefined) out.channelId = toChannelId(snap.channelId);
  if (snap.viewerKind) out.viewerKind = snap.viewerKind;
  if (snap.framed !== undefined) out.framed = snap.framed;
  // Origins go through toOrigin, not the generic URL reduction: that one keeps
  // the path, and turns "https://x" into "https://x/".
  if (snap.pageOrigin !== undefined) out.pageOrigin = snap.pageOrigin === null ? null : toOrigin(snap.pageOrigin);
  if (snap.referrerOrigin !== undefined) {
    out.referrerOrigin = snap.referrerOrigin === null ? null : toOrigin(snap.referrerOrigin);
  }
  if (snap.ancestorOrigins) {
    out.ancestorOrigins = snap.ancestorOrigins
      .filter((o): o is string => typeof o === 'string')
      .slice(0, LIMITS.ancestorOrigins)
      .map(toOrigin)
      .filter((o): o is string => o !== null);
  }
  if (snap.params) {
    const params = snap.params;
    out.params = pickTwitchParams((name) => params[name]);
  }
  if (snap.smoke !== undefined) out.smoke = snap.smoke;
  if (snap.dev !== undefined) out.dev = snap.dev;
  if (snap.triggerVisible !== undefined) out.triggerVisible = snap.triggerVisible;
  return out;
}

// 2020-01-01 .. 2100-01-01: a client clock outside this is noise, not a time.
const MIN_CLIENT_TS = 1_577_836_800_000;
const MAX_CLIENT_TS = 4_102_444_800_000;

function cleanEvent(ev: z.infer<typeof eventSchema>): CleanEvent {
  const t = ev.t;
  return {
    event: ev.event,
    clientTs: t !== undefined && t >= MIN_CLIENT_TS && t <= MAX_CLIENT_TS ? new Date(Math.round(t)) : null,
    seq: ev.seq ?? null,
    snap: cleanSnap(ev.snap),
    data: ev.data ? cleanObject(ev.data) : {},
  };
}

export type DiagBatchResult = { ok: true; batch: CleanBatch } | { ok: false; error: string };

/**
 * Parse a POST body — a JSON string (text/plain) or an already parsed object
 * (application/json) — into a batch that is safe to store.
 */
export function parseDiagBatch(body: unknown): DiagBatchResult {
  let raw = body;
  if (typeof raw === 'string') {
    if (Buffer.byteLength(raw, 'utf8') > LIMITS.bodyBytes) {
      return { ok: false, error: 'batch too large' };
    }
    try {
      raw = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'batch is not JSON' };
    }
  }

  const parsed = batchSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || 'batch'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: truncate(issues, LIMITS.string) };
  }

  return {
    ok: true,
    batch: {
      session: parsed.data.session,
      surface: parsed.data.surface,
      events: parsed.data.events.map(cleanEvent),
    },
  };
}

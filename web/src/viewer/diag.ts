/**
 * App-side access to the extension diagnostics.
 *
 * The boot script (web/public/gtamap-boot.js) runs before this bundle, owns the
 * transport and the page-level hooks, and is the only code allowed to register
 * the Twitch helper callbacks. It is reached through window.__GTAMAP_BOOT__.
 *
 * When it is not there — the file failed to load, or a page that never had it —
 * a small local stand-in with the same interface and the same wire format takes
 * over, so the app's own facts (bundle loaded, trigger rendered, map opened)
 * still reach the backend. The stand-in has no helper bridge: `wired` is false
 * and `twitch.on()` subscribes to nothing.
 *
 * Contract: docs/EXTENSION_DIAGNOSTICS.md, sections 2 and 3. Nothing here may
 * carry a token, a secret, a query string or a user id.
 */

import { API_BASE } from '../shared/api';
import type { ExtAuth, ExtContext } from './twitch';

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export type DiagEventName =
  | 'html_loaded'
  | 'app_bundle_loaded'
  | 'app_bundle_missing'
  | 'twitch_helper_present'
  | 'onAuthorized_fired'
  | 'onContext_first'
  | 'onVisibilityChanged'
  | 'onHighlightChanged'
  | 'document_visibility'
  | 'viewport_resize'
  | 'trigger_rendered'
  | 'trigger_check'
  | 'raw_button_upgraded'
  | 'map_opened'
  | 'runtime_error'
  | 'unhandled_rejection'
  | 'resource_error'
  | 'csp_violation'
  | 'twitch_ext_error'
  | 'page_hide';

export type DiagSurface = 'video_overlay' | 'mobile' | 'config' | 'unknown';

/** What the backend is told about the viewer instead of who they are. */
export type DiagViewerKind = 'anonymous' | 'logged_in' | 'identified' | 'unknown';

export interface DiagSnapshot {
  stage: 'boot' | 'app';
  viewport: { w: number; h: number; dpr: number };
  docVisibility: DocumentVisibilityState | 'prerender' | 'unloaded';
  twitchVisible: boolean | null;
  highlighted: boolean | null;
  helperPresent: boolean;
  helperVersion: string | null;
  authorized: boolean;
  channelId: string | null;
  viewerKind: DiagViewerKind;
  framed: boolean;
  pageOrigin: string | null;
  referrerOrigin: string | null;
  ancestorOrigins: string[];
  params: {
    anchor?: string;
    platform?: string;
    mode?: string;
    state?: string;
    language?: string;
    locale?: string;
    popout?: string;
  };
  smoke: boolean;
  dev: boolean;
  triggerVisible: boolean | null;
}

export interface TriggerInfo {
  which: 'react' | 'raw';
  rendered: boolean;
  rect: { x: number; y: number; w: number; h: number };
  display: string;
  visibility: string;
  /** Effective: the element's own opacity times every ancestor's. */
  opacity: number;
  pointerEvents: string;
  zIndex: string;
  inViewport: boolean;
  hitTest: 'self' | 'covered' | 'outside' | 'n/a';
  visible: boolean;
}

interface DiagEvent {
  event: DiagEventName;
  t: number;
  seq: number;
  snap: DiagSnapshot;
  data?: Record<string, unknown>;
}

type Unsubscribe = () => void;

/** Fan-out of the Twitch helper callbacks the boot script registered. */
export interface BootTwitch {
  on(kind: 'authorized', cb: (auth: ExtAuth) => void): Unsubscribe;
  on(kind: 'context', cb: (ctx: Partial<ExtContext>, changed: string[]) => void): Unsubscribe;
  on(kind: 'visibility', cb: (visible: boolean, ctx: Partial<ExtContext> | null) => void): Unsubscribe;
  on(kind: 'highlight', cb: (highlighted: boolean) => void): Unsubscribe;
  on(kind: 'error', cb: (err: unknown) => void): Unsubscribe;
}

export interface GtamapBoot {
  version: 1;
  session: string;
  surface: DiagSurface;
  apiBase: string;
  smoke: boolean;
  dev: boolean;
  send(event: DiagEventName, data?: Record<string, unknown>): void;
  setSnap(partial: Partial<DiagSnapshot>): void;
  snapshot(): DiagSnapshot;
  markAppLoaded(): void;
  measureTrigger(el: Element | null, which: 'react' | 'raw'): TriggerInfo;
  /** True when the boot script registered the Twitch helper callbacks. */
  wired: boolean;
  twitch: BootTwitch;
}

declare global {
  interface Window {
    __GTAMAP_BOOT__?: GtamapBoot;
  }
}

// ---------------------------------------------------------------------------
// Local stand-in
// ---------------------------------------------------------------------------

const EVENT_NAMES: ReadonlySet<string> = new Set<DiagEventName>([
  'html_loaded',
  'app_bundle_loaded',
  'app_bundle_missing',
  'twitch_helper_present',
  'onAuthorized_fired',
  'onContext_first',
  'onVisibilityChanged',
  'onHighlightChanged',
  'document_visibility',
  'viewport_resize',
  'trigger_rendered',
  'trigger_check',
  'raw_button_upgraded',
  'map_opened',
  'runtime_error',
  'unhandled_rejection',
  'resource_error',
  'csp_violation',
  'twitch_ext_error',
  'page_hide',
]);

/** Same set and window as the boot script: bursts collapse to their latest value. */
const THROTTLED: ReadonlySet<string> = new Set<DiagEventName>([
  'onHighlightChanged',
  'viewport_resize',
  'document_visibility',
  'trigger_check',
  'onVisibilityChanged',
]);

const THROTTLE_MS = 1500;
const FLUSH_MS = 250;
const MAX_BATCH_EVENTS = 25;
const MAX_SESSION_EVENTS = 400;
const MAX_STRING = 300;
const SURFACES: readonly DiagSurface[] = ['video_overlay', 'mobile', 'config'];
const PARAM_KEYS = ['anchor', 'platform', 'mode', 'state', 'language', 'locale', 'popout'] as const;
const SECRET_KEY = /token|jwt|secret|password|cookie|authorization|helix/i;

function stripUrl(url: string): string {
  return url.replace(/[?#][\s\S]*$/, '');
}

/** At most `max` characters, never cutting a surrogate pair (jsonb refuses a lone half). */
function cut(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '')}…`;
}

/** Tokens, Authorization values and query strings never survive this. */
function scrub(value: string): string {
  let s = value;
  s = s.replace(/eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]*/g, '[jwt]');
  s = s.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]');
  s = s.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()]+/gi, (url) => stripUrl(url));
  s = s.replace(/(\/[^\s?#"'<>()]*)[?#][^\s"'<>()]*/g, '$1');
  return cut(s, MAX_STRING);
}

/** Small plain data only; keys that look like secrets are dropped. */
function clean(value: unknown, depth: number): unknown {
  if (value === null) return null;
  if (typeof value === 'string') return scrub(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'object' || depth > 4) return undefined;
  if (Array.isArray(value)) {
    const list: unknown[] = [];
    for (const item of value) {
      if (list.length >= 10) break;
      const cleaned = clean(item, depth + 1);
      if (cleaned !== undefined) list.push(cleaned);
    }
    return list;
  }
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (count >= 40) break;
    if (SECRET_KEY.test(key)) continue;
    const cleaned = clean(item, depth + 1);
    if (cleaned === undefined) continue;
    out[key] = cleaned;
    count += 1;
  }
  return out;
}

function randomSession(): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const bytes = new Uint8Array(22);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (const byte of bytes) out += abc.charAt(byte & 63);
  return out;
}

function originOf(url: string): string | null {
  try {
    return url ? new URL(url, window.location.href).origin : null;
  } catch {
    return null;
  }
}

function isFramed(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

/** The page's meta if it survived; otherwise the page name. */
function localSurface(): DiagSurface {
  const fromMeta = document.querySelector('meta[name="gtamap-boot"]')?.getAttribute('data-surface') ?? '';
  const fromPath = (window.location.pathname.split('/').pop() ?? '').replace(/\.html$/, '');
  const found = SURFACES.find((s) => s === fromMeta) ?? SURFACES.find((s) => s === fromPath);
  return found ?? 'unknown';
}

function localParams(): DiagSnapshot['params'] {
  const out: DiagSnapshot['params'] = {};
  const query = new URLSearchParams(window.location.search);
  for (const key of PARAM_KEYS) {
    const value = query.get(key);
    if (value && /^[A-Za-z0-9_.-]{1,40}$/.test(value)) out[key] = value;
  }
  return out;
}

function viewportNow(): DiagSnapshot['viewport'] {
  return {
    w: Math.round(window.innerWidth || 0),
    h: Math.round(window.innerHeight || 0),
    dpr: Math.round((window.devicePixelRatio || 1) * 100) / 100,
  };
}

function effectiveOpacity(el: Element): number {
  let opacity = 1;
  let node: Element | null = el;
  for (let i = 0; node && i < 64; i += 1) {
    const value = parseFloat(window.getComputedStyle(node).opacity);
    if (!Number.isNaN(value)) opacity *= value;
    node = node.parentElement;
  }
  return Math.round(opacity * 100) / 100;
}

/** The boot script's measureTrigger, for when the boot script is absent. */
function measureLocally(el: Element | null, which: 'react' | 'raw'): TriggerInfo {
  const info: TriggerInfo = {
    which,
    rendered: false,
    rect: { x: 0, y: 0, w: 0, h: 0 },
    display: '',
    visibility: '',
    opacity: 0,
    pointerEvents: '',
    zIndex: '',
    inViewport: false,
    hitTest: 'n/a',
    visible: false,
  };
  try {
    if (!el || !el.isConnected) return info;
    info.rendered = true;
    const r = el.getBoundingClientRect();
    info.rect = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    const style = window.getComputedStyle(el);
    info.display = style.display;
    info.visibility = style.visibility;
    info.pointerEvents = style.pointerEvents;
    info.zIndex = style.zIndex;
    info.opacity = effectiveOpacity(el);
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    info.inViewport = r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
    if (!info.inViewport) {
      info.hitTest = 'outside';
    } else {
      const cx = (Math.max(r.left, 0) + Math.min(r.right, vw)) / 2;
      const cy = (Math.max(r.top, 0) + Math.min(r.bottom, vh)) / 2;
      const hit = document.elementFromPoint(cx, cy);
      info.hitTest = !hit ? 'n/a' : hit === el || el.contains(hit) ? 'self' : 'covered';
    }
    info.visible =
      info.rect.w > 0 &&
      info.rect.h > 0 &&
      info.display !== 'none' &&
      info.visibility !== 'hidden' &&
      info.opacity > 0.05 &&
      info.inViewport;
  } catch {
    /* whatever was measured so far */
  }
  return info;
}

function createLocalBoot(): GtamapBoot {
  const session = randomSession();
  const surface = localSurface();
  const smoke = (import.meta.env.VITE_SMOKE_TEST as string | undefined) === 'true';
  const dev = (import.meta.env.VITE_DEV_MODE as string | undefined) === 'true';
  const ext = window.Twitch?.ext;

  const snap: DiagSnapshot = {
    stage: 'boot',
    viewport: viewportNow(),
    docVisibility: document.visibilityState,
    twitchVisible: null,
    highlighted: null,
    helperPresent: !!ext,
    helperVersion: typeof ext?.version === 'string' ? cut(scrub(ext.version), 64) : null,
    authorized: false,
    channelId: null,
    viewerKind: 'unknown',
    framed: isFramed(),
    pageOrigin: window.location.origin,
    referrerOrigin: originOf(document.referrer),
    ancestorOrigins: Array.from(window.location.ancestorOrigins ?? []).slice(0, 5),
    params: localParams(),
    smoke,
    dev,
    triggerVisible: null,
  };

  const snapshot = (): DiagSnapshot => ({
    ...snap,
    viewport: viewportNow(),
    docVisibility: document.visibilityState,
    ancestorOrigins: [...snap.ancestorOrigins],
    params: { ...snap.params },
  });

  const queue: DiagEvent[] = [];
  let seq = 0;
  let accepted = 0;
  let flushTimer: number | undefined;
  const lastSentAt = new Map<string, number>();
  const pending = new Map<string, Omit<DiagEvent, 'seq'>>();
  const pendingTimers = new Map<string, number>();

  const post = (body: string, beacon: boolean): void => {
    const url = `${API_BASE}/api/diag/ext`;
    try {
      if (!beacon && typeof fetch === 'function') {
        // text/plain + no-cors: a CORS simple request, no preflight.
        void fetch(url, {
          method: 'POST',
          mode: 'no-cors',
          credentials: 'omit',
          keepalive: true,
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
          body,
        }).catch(() => undefined);
        return;
      }
      navigator.sendBeacon?.(url, body);
    } catch {
      /* diagnostics are best effort */
    }
  };

  const flush = (beacon = false): void => {
    window.clearTimeout(flushTimer);
    flushTimer = undefined;
    while (queue.length) {
      const events = queue.splice(0, MAX_BATCH_EVENTS);
      post(JSON.stringify({ v: 1, session, surface, events }), beacon);
    }
  };

  const enqueue = (item: Omit<DiagEvent, 'seq'>): void => {
    if (accepted >= MAX_SESSION_EVENTS) return;
    accepted += 1;
    seq += 1;
    queue.push({ ...item, seq });
    flushTimer ??= window.setTimeout(() => flush(), FLUSH_MS);
  };

  const release = (name: string): void => {
    pendingTimers.delete(name);
    const item = pending.get(name);
    pending.delete(name);
    if (!item) return;
    lastSentAt.set(name, Date.now());
    enqueue(item);
  };

  const send = (event: DiagEventName, data?: Record<string, unknown>): void => {
    if (!EVENT_NAMES.has(event) || accepted >= MAX_SESSION_EVENTS) return;
    const cleaned = clean(data ?? {}, 1);
    const item: Omit<DiagEvent, 'seq'> = {
      event,
      t: Date.now(),
      snap: snapshot(),
      data: cleaned && typeof cleaned === 'object' ? (cleaned as Record<string, unknown>) : {},
    };
    if (!THROTTLED.has(event)) {
      enqueue(item);
      return;
    }
    const since = Date.now() - (lastSentAt.get(event) ?? 0);
    if (since >= THROTTLE_MS && !pendingTimers.has(event)) {
      lastSentAt.set(event, Date.now());
      enqueue(item);
      return;
    }
    pending.set(event, item);
    if (!pendingTimers.has(event)) {
      pendingTimers.set(event, window.setTimeout(() => release(event), Math.max(0, THROTTLE_MS - since)));
    }
  };

  window.addEventListener('pagehide', () => {
    try {
      send('page_hide', {});
      for (const [name, timer] of [...pendingTimers]) {
        window.clearTimeout(timer);
        release(name);
      }
      flush(true);
    } catch {
      /* best effort */
    }
  });

  const noSubscription: BootTwitch['on'] = () => () => undefined;

  return {
    version: 1,
    session,
    surface,
    apiBase: API_BASE,
    smoke,
    dev,
    send: (event, data) => {
      try {
        send(event, data);
      } catch {
        /* best effort */
      }
    },
    setSnap: (partial) => {
      if (partial.stage === 'boot' || partial.stage === 'app') snap.stage = partial.stage;
      if (typeof partial.authorized === 'boolean') snap.authorized = partial.authorized;
      if ('channelId' in partial) snap.channelId = diagChannelId(partial.channelId);
      if (partial.viewerKind) snap.viewerKind = partial.viewerKind;
      if (partial.twitchVisible !== undefined) snap.twitchVisible = partial.twitchVisible;
      if (partial.highlighted !== undefined) snap.highlighted = partial.highlighted;
      if (partial.triggerVisible !== undefined) snap.triggerVisible = partial.triggerVisible;
    },
    snapshot,
    markAppLoaded: () => {
      snap.stage = 'app';
    },
    measureTrigger: measureLocally,
    wired: false,
    twitch: { on: noSubscription },
  };
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

let localBoot: GtamapBoot | null = null;

/** The boot script's object, or the local stand-in when it never ran. */
export function bootBridge(): GtamapBoot {
  const boot = typeof window === 'undefined' ? undefined : window.__GTAMAP_BOOT__;
  if (boot && boot.version === 1 && typeof boot.send === 'function' && typeof boot.twitch?.on === 'function') {
    return boot;
  }
  localBoot ??= createLocalBoot();
  return localBoot;
}

export function diagEvent(event: DiagEventName, data?: Record<string, unknown>): void {
  try {
    bootBridge().send(event, data);
  } catch {
    /* diagnostics must never break the app */
  }
}

export function setDiagSnap(partial: Partial<DiagSnapshot>): void {
  try {
    bootBridge().setSnap(partial);
  } catch {
    /* diagnostics must never break the app */
  }
}

export function markAppLoaded(): void {
  try {
    bootBridge().markAppLoaded();
  } catch {
    /* diagnostics must never break the app */
  }
}

export function measureTrigger(el: Element | null, which: 'react' | 'raw'): TriggerInfo {
  try {
    return bootBridge().measureTrigger(el, which);
  } catch {
    return measureLocally(el, which);
  }
}

/** Below this, in either direction, the iframe cannot show a button (as on the server). */
const MIN_IFRAME_PX = 50;

/**
 * Whether the page is in front of the viewer, judged exactly as the backend
 * will judge the snapshot sent with the next event: document visible, Twitch
 * not hiding the extension, a real size. The backend only trusts a trigger
 * measurement taken in that state, so the app reports the first one it gets
 * even when nothing about the button changed.
 */
export function diagPageOnScreen(): boolean {
  try {
    const snap = bootBridge().snapshot();
    return (
      snap.docVisibility === 'visible' &&
      snap.twitchVisible !== false &&
      snap.viewport.w >= MIN_IFRAME_PX &&
      snap.viewport.h >= MIN_IFRAME_PX
    );
  } catch {
    return false;
  }
}

/**
 * True when the trigger appeared, disappeared, or moved or resized by `px` or
 * more since `before` — the only changes worth a trigger_check event.
 */
export function triggerMoved(before: TriggerInfo, after: TriggerInfo, px = 4): boolean {
  if (before.visible !== after.visible) return true;
  const a = before.rect;
  const b = after.rect;
  return Math.abs(a.x - b.x) >= px || Math.abs(a.y - b.y) >= px || Math.abs(a.w - b.w) >= px || Math.abs(a.h - b.h) >= px;
}

/** SMOKE_TEST as the page was built: the boot meta, else the bundle's own flag. */
export function isSmokeTest(): boolean {
  try {
    return bootBridge().smoke;
  } catch {
    return (import.meta.env.VITE_SMOKE_TEST as string | undefined) === 'true';
  }
}

/** Digits only, or nothing: a channel id is the one id the backend may see. */
export function diagChannelId(value: unknown): string | null {
  return typeof value === 'string' && /^\d{1,20}$/.test(value) ? value : null;
}

/**
 * identified = a numeric Twitch id is known (identity shared); otherwise the
 * opaque id says anonymous (A…) or logged in without sharing (U…). The id
 * itself is never reported.
 */
export function diagViewerKind(userId: string | null | undefined): DiagViewerKind {
  const sharedId = typeof window === 'undefined' ? null : window.Twitch?.ext?.viewer?.id;
  if (typeof sharedId === 'string' && /^\d+$/.test(sharedId)) return 'identified';
  if (!userId) return 'unknown';
  if (/^\d+$/.test(userId)) return 'identified';
  if (userId.startsWith('A')) return 'anonymous';
  if (userId.startsWith('U')) return 'logged_in';
  return 'unknown';
}

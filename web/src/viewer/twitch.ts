/**
 * Thin typed wrapper around the Twitch extension helper.
 *
 * The helper is loaded by each Twitch HTML entry from extension-files.twitch.tv
 * exists when we really run inside a Twitch iframe. Everything below always
 * checks `window.Twitch?.ext` first; the dev fallback (local /dev player
 * simulator) is used only when that object is absent.
 */

import { ApiClient } from '../shared/api';

// ---------------------------------------------------------------------------
// window.Twitch typings (declared here on purpose — no @types package)
// ---------------------------------------------------------------------------

export interface ExtAuth {
  /** Signed JWT sent as `Authorization: Bearer` on every /api/ext call. */
  token: string;
  /** Real numeric id once linked, otherwise an opaque `U…` / `A…` id. */
  userId: string;
  channelId: string;
  clientId: string;
  helixToken: string;
}

export interface ExtContext {
  arePlayerControlsVisible?: boolean;
  bitrate?: number;
  displayResolution?: string;
  isFullScreen?: boolean;
  isMuted?: boolean;
  isPaused?: boolean;
  isTheatreMode?: boolean;
  mode?: string;
  playbackMode?: string;
  theme?: 'light' | 'dark';
  videoResolution?: string;
}

interface TwitchExtActions {
  requestIdShare?: () => void;
  followChannel?: (channelName: string) => void;
  onFollow?: (cb: (didFollow: boolean, channelName: string) => void) => void;
}

interface TwitchExtViewer {
  id?: string | null;
  opaqueId?: string;
  isLinked?: boolean;
  role?: string;
}

interface TwitchExtApi {
  onAuthorized: (cb: (auth: ExtAuth) => void) => void;
  onContext?: (cb: (ctx: Partial<ExtContext>, changed: string[]) => void) => void;
  onError?: (cb: (err: unknown) => void) => void;
  onVisibilityChanged?: (cb: (isVisible: boolean, ctx?: Partial<ExtContext>) => void) => void;
  /** Fires when Twitch highlights the extension, e.g. on hovering its icon. */
  onHighlightChanged?: (cb: (isHighlighted: boolean) => void) => void;
  actions?: TwitchExtActions;
  viewer?: TwitchExtViewer;
}

declare global {
  interface Window {
    Twitch?: { ext?: TwitchExtApi };
  }
}

// ---------------------------------------------------------------------------
// Iframe query params. Twitch appends platform / anchor / mode / state.
// ---------------------------------------------------------------------------

export type ExtPlatform = 'web' | 'mobile' | 'other';

export interface ExtParams {
  /** `mobile` inside the Twitch mobile app. */
  platform: ExtPlatform;
  /** `video_overlay`, `component`, `panel`, … */
  anchor: string | null;
  mode: string | null;
  /** Dev simulator only: which fake viewer id to mint a token for. */
  devUser: string;
}

const DEFAULT_DEV_USER = '100000001';

function readParams(): ExtParams {
  const empty: ExtParams = { platform: 'web', anchor: null, mode: null, devUser: DEFAULT_DEV_USER };
  if (typeof window === 'undefined') return empty;
  const q = new URLSearchParams(window.location.search);
  const rawPlatform = (q.get('platform') ?? '').toLowerCase();
  const platform: ExtPlatform = rawPlatform === 'mobile' ? 'mobile' : rawPlatform === 'web' ? 'web' : rawPlatform ? 'other' : 'web';
  return {
    platform,
    anchor: q.get('anchor'),
    mode: q.get('mode'),
    devUser: q.get('devUser') ?? DEFAULT_DEV_USER,
  };
}

export const extParams: ExtParams = readParams();

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

type Unsubscribe = () => void;

const DEV_MODE_FLAG = (import.meta.env.VITE_DEV_MODE as string | undefined) === 'true';

let installed = false;
let latestAuth: ExtAuth | null = null;
let latestContext: Partial<ExtContext> = {};
let latestVisible = true;

const authListeners = new Set<(auth: ExtAuth) => void>();
const contextListeners = new Set<(ctx: Partial<ExtContext>) => void>();
const errorListeners = new Set<(err: unknown) => void>();
const visibilityListeners = new Set<(visible: boolean) => void>();

function emitAuth(auth: ExtAuth): void {
  latestAuth = auth;
  lastError = null;
  for (const cb of authListeners) cb(auth);
  logDiagnostics('onAuthorized');
  publishDiagnostics();
}

function emitError(err: unknown): void {
  // Keep only a short, safe description: this is surfaced in the UI and logged.
  lastError = err instanceof Error ? err.message : String(err ?? 'unknown error');
  lastError = lastError.slice(0, 200);
  // eslint-disable-next-line no-console
  console.warn(`[GTAMAP] extension error: ${lastError}`);
  for (const cb of errorListeners) cb(err);
  publishDiagnostics();
}

export function hasTwitchHelper(): boolean {
  return typeof window !== 'undefined' && !!window.Twitch?.ext;
}

/**
 * True while we are standing in for Twitch rather than running inside it.
 *
 * Every Twitch entry loads the helper script unconditionally, so its mere
 * presence proves nothing: opened directly, or embedded in the local /dev
 * player, it defines `window.Twitch.ext` and then never authorises anybody,
 * leaving the page stuck forever.
 *
 * Two signals, both of which a real Twitch embed fails:
 *   - `?devUser=` in the query string. Twitch never adds it, and a production
 *     bundle is built with VITE_DEV_MODE=false, so it cannot fire in the wild.
 *   - no helper at all (the page opened as a plain document).
 */
export function isDevFallback(): boolean {
  if (DEV_MODE_FLAG && extParams.devUser) return true;
  return !hasTwitchHelper();
}

// ---------------------------------------------------------------------------
// Dev fallback: mint a JWT from the backend exactly like Twitch would hand us one
// ---------------------------------------------------------------------------

interface DevTokenResponse {
  token?: string;
  jwt?: string;
  channelId?: string;
  userId?: string;
  clientId?: string;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const json = decodeURIComponent(
      atob(padded)
        .split('')
        .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
        .join(''),
    );
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function claimString(claims: Record<string, unknown> | null, key: string): string | null {
  const value = claims?.[key];
  return typeof value === 'string' && value ? value : null;
}

const devApi = new ApiClient();

/** Role the dev fallback mints with; set once by start(). Ignored on real Twitch. */
let devRole: DevRole = 'viewer';

export type DevRole = 'viewer' | 'broadcaster';

/**
 * `role` matters for config.html: the broadcaster status endpoint refuses
 * anything but a broadcaster token, exactly as it will on real Twitch.
 */
async function mintDevToken(userId: string, role: DevRole = 'viewer'): Promise<ExtAuth> {
  const res = await devApi.post<DevTokenResponse>('/api/dev/ext-token', {
    userId,
    linked: true,
    role,
  });
  const token = res.token ?? res.jwt;
  if (!token) throw new Error('Dev token endpoint returned no token');
  const claims = decodeJwtPayload(token);
  return {
    token,
    userId: claimString(claims, 'user_id') ?? res.userId ?? userId,
    channelId: claimString(claims, 'channel_id') ?? res.channelId ?? '',
    clientId: res.clientId ?? 'dev-client',
    helixToken: '',
  };
}


// ---------------------------------------------------------------------------
// Diagnostics
//
// "The extension menu shows up but nothing is on the player" has at least six
// different causes, and from the outside they look identical. This records the
// few facts that tell them apart — and never a token, because this is read off
// a screen and pasted into chat.
// ---------------------------------------------------------------------------

export type ViewerKind = 'linked' | 'opaque' | 'anonymous' | 'unknown';

export interface ExtDiagnostics {
  /** React actually mounted. Set by the app, not by this module. */
  domMounted: boolean;
  /** window.Twitch.ext exists — the helper script loaded. */
  helperLoaded: boolean;
  /** We are standing in for Twitch rather than running inside it. */
  devFallback: boolean;
  /** onAuthorized has fired at least once. */
  authorized: boolean;
  channelId: string | null;
  viewerKind: ViewerKind;
  visible: boolean;
  highlighted: boolean;
  /** Safe message only; never the error object or anything signed. */
  lastError: string | null;
  platform: ExtPlatform;
  anchor: string | null;
}

let domMounted = false;
let latestHighlighted = false;
let lastError: string | null = null;

const highlightListeners = new Set<(highlighted: boolean) => void>();
const diagListeners = new Set<(d: ExtDiagnostics) => void>();

/** Called once by the app so the badge can prove React came up. */
export function markDomMounted(): void {
  domMounted = true;
  publishDiagnostics();
}

function viewerKind(): ViewerKind {
  const auth = latestAuth;
  if (!auth) return 'unknown';
  if (/^\d+$/.test(auth.userId)) return 'linked';
  if (auth.userId.startsWith('A')) return 'anonymous';
  return 'opaque';
}

export function diagnostics(): ExtDiagnostics {
  return {
    domMounted,
    helperLoaded: hasTwitchHelper(),
    devFallback: isDevFallback(),
    authorized: latestAuth !== null,
    channelId: latestAuth?.channelId ?? null,
    viewerKind: viewerKind(),
    visible: latestVisible,
    highlighted: latestHighlighted,
    lastError,
    platform: extParams.platform,
    anchor: extParams.anchor,
  };
}

function publishDiagnostics(): void {
  const snapshot = diagnostics();
  for (const cb of diagListeners) cb(snapshot);
}

export function onDiagnostics(cb: (d: ExtDiagnostics) => void): Unsubscribe {
  diagListeners.add(cb);
  cb(diagnostics());
  return () => diagListeners.delete(cb);
}

export function onHighlightChanged(cb: (highlighted: boolean) => void): Unsubscribe {
  highlightListeners.add(cb);
  cb(latestHighlighted);
  return () => highlightListeners.delete(cb);
}

export function isHighlighted(): boolean {
  return latestHighlighted;
}

/** One line per fact, so a screenshot of the console answers "did it load". */
export function logDiagnostics(reason: string): void {
  const d = diagnostics();
  // eslint-disable-next-line no-console
  console.info(
    `[GTAMAP] ${reason} | mounted=${d.domMounted} helper=${d.helperLoaded} ` +
      `devFallback=${d.devFallback} authorized=${d.authorized} channel=${d.channelId ?? '-'} ` +
      `viewer=${d.viewerKind} visible=${d.visible} highlighted=${d.highlighted} ` +
      `platform=${d.platform} anchor=${d.anchor ?? '-'}` +
      (d.lastError ? ` error=${d.lastError}` : ''),
  );
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

/**
 * Idempotent. Wires the real helper, or falls back to the dev token endpoint.
 *
 * `devRole` only affects the fallback; inside real Twitch the role comes from
 * the JWT Twitch signs, and nothing here can influence it.
 */
export function start(role: DevRole = 'viewer'): void {
  if (installed) return;
  installed = true;
  devRole = role;

  const ext =
    typeof window === 'undefined' || isDevFallback() ? undefined : window.Twitch?.ext;

  if (ext) {
    ext.onAuthorized((auth) => emitAuth(auth));
    ext.onContext?.((ctx) => {
      latestContext = { ...latestContext, ...ctx };
      for (const cb of contextListeners) cb(latestContext);
    });
    ext.onError?.((err) => emitError(err));
    ext.onVisibilityChanged?.((visible, ctx) => {
      latestVisible = visible;
      if (ctx) latestContext = { ...latestContext, ...ctx };
      for (const cb of visibilityListeners) cb(visible);
      logDiagnostics(`onVisibilityChanged(${visible})`);
      publishDiagnostics();
    });
    ext.onHighlightChanged?.((highlighted) => {
      // Twitch highlights the extension when the viewer hovers its icon. The
      // trigger gets louder for that moment; it does not depend on it.
      latestHighlighted = highlighted;
      for (const cb of highlightListeners) cb(highlighted);
      publishDiagnostics();
    });

    logDiagnostics('twitch helper wired');

    // Belt and braces: if the helper is present but never authorises us (a
    // hosted-test misconfiguration, or the page opened outside Twitch with a
    // dev build), fall back rather than showing an empty overlay forever.
    if (DEV_MODE_FLAG) {
      window.setTimeout(() => {
        if (latestAuth) return;
        void mintDevToken(extParams.devUser, devRole)
          .then((auth) => emitAuth(auth))
          .catch((err: unknown) => emitError(err));
      }, 3000);
    }
    return;
  }

  // No helper on the page: local dev / player simulator.
  void mintDevToken(extParams.devUser, devRole)
    .then((auth) => emitAuth(auth))
    .catch((err: unknown) => emitError(err));

  if (typeof document !== 'undefined') {
    const onVisible = (): void => {
      latestVisible = document.visibilityState !== 'hidden';
      for (const cb of visibilityListeners) cb(latestVisible);
    };
    document.addEventListener('visibilitychange', onVisible);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Fires immediately with the cached auth when it already arrived. */
export function onAuthorized(cb: (auth: ExtAuth) => void): Unsubscribe {
  start();
  authListeners.add(cb);
  if (latestAuth) cb(latestAuth);
  return () => authListeners.delete(cb);
}

export function onContext(cb: (ctx: Partial<ExtContext>) => void): Unsubscribe {
  start();
  contextListeners.add(cb);
  return () => contextListeners.delete(cb);
}

export function onError(cb: (err: unknown) => void): Unsubscribe {
  start();
  errorListeners.add(cb);
  return () => errorListeners.delete(cb);
}

export function onVisibilityChanged(cb: (visible: boolean) => void): Unsubscribe {
  start();
  visibilityListeners.add(cb);
  return () => visibilityListeners.delete(cb);
}

export function currentAuth(): ExtAuth | null {
  return latestAuth;
}

export function currentToken(): string | null {
  return latestAuth?.token ?? null;
}

export function currentContext(): Partial<ExtContext> {
  return latestContext;
}

export function isVisible(): boolean {
  return latestVisible;
}

/**
 * A linked viewer gets a real numeric Twitch id; an unlinked one gets the
 * opaque `U…` (logged in) or `A…` (anonymous) form, which cannot be matched to
 * a channel-points redemption.
 */
export function isLinked(): boolean {
  const auth = latestAuth;
  if (!auth) return false;
  if (typeof window !== 'undefined' && window.Twitch?.ext?.viewer?.isLinked === true) return true;
  return /^\d+$/.test(auth.userId);
}

/** Opens Twitch's own "share identity" dialog. No-op if the helper is absent. */
export function requestIdShare(): void {
  const actions = typeof window === 'undefined' ? undefined : window.Twitch?.ext?.actions;
  if (actions?.requestIdShare) {
    actions.requestIdShare();
    return;
  }
  if (isDevFallback()) {
    // Dev simulator: re-mint a linked token so the flow can be exercised.
    void mintDevToken(extParams.devUser, devRole)
      .then((auth) => emitAuth(auth))
      .catch((err: unknown) => emitError(err));
  }
}

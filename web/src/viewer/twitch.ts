/**
 * Thin typed wrapper around the Twitch extension helper.
 *
 * The helper is loaded by viewer.html from extension-files.twitch.tv and only
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
  for (const cb of authListeners) cb(auth);
}

function emitError(err: unknown): void {
  for (const cb of errorListeners) cb(err);
}

export function hasTwitchHelper(): boolean {
  return typeof window !== 'undefined' && !!window.Twitch?.ext;
}

/**
 * True while we are standing in for Twitch rather than running inside it.
 *
 * viewer.html loads the Twitch helper script unconditionally, so its mere
 * presence proves nothing: opened directly, or embedded in the local /dev
 * player, it defines `window.Twitch.ext` and then never authorises anybody,
 * leaving the page stuck forever.
 *
 * Two signals, both of which a real Twitch embed fails:
 *   - `?devUser=` in the query string. Twitch never adds it, and a production
 *     bundle is built with VITE_DEV_MODE=false, so it cannot fire in the wild.
 *   - no helper at all (viewer.html opened as a plain page).
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

async function mintDevToken(userId: string): Promise<ExtAuth> {
  const res = await devApi.post<DevTokenResponse>('/api/dev/ext-token', { userId, linked: true });
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
// Installation
// ---------------------------------------------------------------------------

/** Idempotent. Wires the real helper, or falls back to the dev token endpoint. */
export function start(): void {
  if (installed) return;
  installed = true;

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
    });

    // Belt and braces: if the helper is present but never authorises us (a
    // hosted-test misconfiguration, or the page opened outside Twitch with a
    // dev build), fall back rather than showing an empty overlay forever.
    if (DEV_MODE_FLAG) {
      window.setTimeout(() => {
        if (latestAuth) return;
        void mintDevToken(extParams.devUser)
          .then((auth) => emitAuth(auth))
          .catch((err: unknown) => emitError(err));
      }, 3000);
    }
    return;
  }

  // No helper on the page: local dev / player simulator.
  void mintDevToken(extParams.devUser)
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
    void mintDevToken(extParams.devUser)
      .then((auth) => emitAuth(auth))
      .catch((err: unknown) => emitError(err));
  }
}

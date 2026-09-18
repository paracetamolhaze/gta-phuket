/**
 * Wire format of the Twitch extension diagnostics (docs/EXTENSION_DIAGNOSTICS.md §3).
 *
 * The page reports on itself before it has a Twitch token, so none of this is
 * authenticated. Everything a browser sends is therefore treated as hostile:
 * the structural parts are validated strictly, and every free-form value goes
 * through ./sanitize.ts before it is stored.
 */

export const DIAG_EVENT_NAMES = [
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
] as const;

export type DiagEventName = (typeof DIAG_EVENT_NAMES)[number];

export const DIAG_SURFACES = ['video_overlay', 'mobile', 'config', 'panel', 'unknown'] as const;
export type DiagSurface = (typeof DIAG_SURFACES)[number];

export const VIEWER_KINDS = ['anonymous', 'logged_in', 'identified', 'unknown'] as const;
export type ViewerKind = (typeof VIEWER_KINDS)[number];

export const DOC_VISIBILITIES = ['visible', 'hidden', 'prerender', 'unloaded'] as const;
export type DocVisibility = (typeof DOC_VISIBILITIES)[number];

/** The only Twitch query parameters worth keeping; the rest may carry anything. */
export const TWITCH_PARAMS = ['anchor', 'platform', 'mode', 'state', 'language', 'locale', 'popout'] as const;
export type TwitchParam = (typeof TWITCH_PARAMS)[number];

/** Events that count towards the session's error total. */
export const ERROR_EVENTS: ReadonlySet<string> = new Set([
  'runtime_error',
  'unhandled_rejection',
  'resource_error',
  'twitch_ext_error',
]);

/**
 * Events whose data carries a trigger measurement. Only `which: 'react'` ones
 * (trigger_rendered / trigger_check) say anything about the map button; the
 * raw SMOKE_TEST button (html_loaded / raw_button_upgraded) is kept apart, see
 * foldState in ./session.ts.
 */
export const TRIGGER_EVENTS: ReadonlySet<string> = new Set([
  'html_loaded',
  'trigger_rendered',
  'trigger_check',
  'raw_button_upgraded',
]);

/** Below this, in either direction, the iframe cannot show a button. */
export const MIN_IFRAME_PX = 50;

export const LIMITS = {
  bodyBytes: 32 * 1024,
  eventsPerBatch: 25,
  string: 300,
  depth: 4,
  keys: 40,
  array: 10,
  ancestorOrigins: 5,
} as const;

export interface TriggerInfo {
  which: 'react' | 'raw';
  rendered: boolean;
  rect: { x: number; y: number; w: number; h: number };
  display: string;
  visibility: string;
  opacity: number;
  pointerEvents: string;
  zIndex: string;
  inViewport: boolean;
  hitTest: 'self' | 'covered' | 'outside' | 'n/a';
  visible: boolean;
}

export interface DiagSnapshot {
  stage: 'boot' | 'app';
  viewport: { w: number; h: number; dpr: number };
  docVisibility: DocVisibility;
  twitchVisible: boolean | null;
  highlighted: boolean | null;
  helperPresent: boolean;
  helperVersion: string | null;
  authorized: boolean;
  channelId: string | null;
  viewerKind: ViewerKind;
  framed: boolean;
  pageOrigin: string | null;
  referrerOrigin: string | null;
  ancestorOrigins: string[];
  params: Partial<Record<TwitchParam, string>>;
  smoke: boolean;
  dev: boolean;
  triggerVisible: boolean | null;
}

/**
 * What the server keeps per row: the snapshot as it stood after the event,
 * plus the latest measurements so a row explains itself.
 *
 * - `trigger` / `triggerVisible`: the latest React map button measurement.
 * - `onScreenTrigger`: the latest React measurement taken while the page was
 *   actually on screen (document visible, Twitch not hiding it, real size).
 *   A viewer switching tabs or closing the stream must not turn a button that
 *   was seen into one that "is hidden", so the verdict goes by this one.
 * - `rawTrigger`: the latest measurement of the raw SMOKE_TEST button. It
 *   proves the iframe is on screen, not that the map button is.
 */
export type SessionState = Partial<DiagSnapshot> & {
  trigger?: TriggerInfo;
  onScreenTrigger?: TriggerInfo;
  rawTrigger?: TriggerInfo;
};

export interface CleanEvent {
  event: DiagEventName;
  clientTs: Date | null;
  seq: number | null;
  snap: Partial<DiagSnapshot>;
  data: Record<string, unknown>;
}

export interface CleanBatch {
  session: string;
  surface: DiagSurface;
  events: CleanEvent[];
}

/** One stored ext_diag_events row, as the admin view and the verdict read it. */
export interface DiagEventRow {
  id: number;
  receivedAt: Date;
  clientTs: Date | null;
  session: string;
  surface: string;
  event: string;
  channelId: string | null;
  viewerKind: string;
  state: SessionState;
  data: Record<string, unknown>;
}

export type RequestSource = 'ingress' | 'devserver';

/** One ext_request_log row, before or after storage. */
export interface RequestLogEntry {
  ts: Date;
  source: RequestSource;
  method: string;
  path: string;
  status: number | null;
  referer: string | null;
  secFetchDest: string | null;
  secFetchSite: string | null;
  userAgent: string | null;
}

export interface RequestLogRow extends RequestLogEntry {
  id: number;
}

export type VerdictCode =
  | 'no_data'
  | 'request_only'
  | 'pending'
  | 'helper_missing'
  | 'bundle_missing'
  | 'trigger_missing'
  | 'iframe_hidden'
  | 'trigger_hidden'
  | 'ok_unauthorized'
  | 'ok';

export interface Verdict {
  code: VerdictCode;
  ok: boolean;
  text: string;
}

export interface LastIframeRequest {
  ts: string;
  path: string;
  status: number | null;
  referer: string | null;
}

export interface LastSessionSummary {
  session: string;
  surface: string;
  firstAt: string;
  lastAt: string;
  events: string[];
  htmlLoaded: boolean;
  appBundleLoaded: boolean;
  appBundleMissing: boolean;
  helperPresent: boolean | null;
  helperVersion: string | null;
  authorized: boolean;
  channelId: string | null;
  viewerKind: string;
  viewport: string | null;
  twitchVisible: boolean | null;
  docVisibility: string | null;
  triggerVisible: boolean | null;
  triggerWhich: string | null;
  trigger: string | null;
  /** The latest React measurement taken while the page was on screen. */
  onScreenTriggerVisible: boolean | null;
  onScreenTrigger: string | null;
  /** The raw SMOKE_TEST button, when the page has one. */
  rawVisible: boolean | null;
  rawTrigger: string | null;
  mapOpened: boolean;
  errorCount: number;
  cspCount: number;
  /** The newest error or CSP line of the session, as the events table shows it. */
  lastError: string | null;
  pageOrigin: string | null;
  referrerOrigin: string | null;
  twitchState: string | null;
  anchor: string | null;
}

export interface ExtDiagEventView {
  id: number;
  receivedAt: string;
  clientTs: string | null;
  session: string;
  surface: string;
  event: string;
  channelId: string | null;
  viewerKind: string;
  viewport: string | null;
  docVisibility: string | null;
  twitchVisible: boolean | null;
  helper: string;
  authorized: boolean | null;
  trigger: string | null;
  error: string | null;
  data: Record<string, unknown>;
}

export interface ExtRequestView {
  id: number;
  ts: string;
  source: RequestSource;
  method: string;
  path: string;
  status: number | null;
  referer: string | null;
  secFetchDest: string | null;
  secFetchSite: string | null;
  userAgent: string | null;
}

export interface ExtDiagnosticsResponse {
  serverTime: number;
  events: ExtDiagEventView[];
  requests: ExtRequestView[];
  summary: {
    lastIframeRequest: LastIframeRequest | null;
    lastSession: LastSessionSummary | null;
    verdict: Verdict;
  };
}

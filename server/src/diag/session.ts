import {
  DOC_VISIBILITIES,
  ERROR_EVENTS,
  MIN_IFRAME_PX,
  TRIGGER_EVENTS,
  VIEWER_KINDS,
  type DiagEventRow,
  type DocVisibility,
  type ExtDiagEventView,
  type LastSessionSummary,
  type SessionState,
  type TriggerInfo,
  type ViewerKind,
} from './schema.js';
import { toChannelId, truncate } from './sanitize.js';

/**
 * Turning stored diagnostics into what /admin shows: the running state of a
 * page load, one line per event, and the facts of the last session.
 *
 * Pure functions only; ./store.ts does the reading and writing.
 */

type Json = Record<string, unknown>;

function isRecord(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function isViewerKind(v: unknown): v is ViewerKind {
  return typeof v === 'string' && (VIEWER_KINDS as readonly string[]).includes(v);
}

function isDocVisibility(v: unknown): v is DocVisibility {
  return typeof v === 'string' && (DOC_VISIBILITIES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

/**
 * Read a TriggerInfo out of stored event data. Lenient, because it is only
 * ever shown to the owner: a missing field gets a neutral default, and
 * `visible` is recomputed by the contract's rule when the page did not say.
 */
export function parseTrigger(v: unknown): TriggerInfo | null {
  if (!isRecord(v)) return null;
  const rect = isRecord(v.rect) ? v.rect : {};
  const hitTest = v.hitTest;
  const info: TriggerInfo = {
    which: v.which === 'raw' ? 'raw' : 'react',
    rendered: typeof v.rendered === 'boolean' ? v.rendered : true,
    rect: {
      x: Math.round(num(rect.x)),
      y: Math.round(num(rect.y)),
      w: Math.round(num(rect.w)),
      h: Math.round(num(rect.h)),
    },
    display: str(v.display),
    visibility: str(v.visibility),
    opacity: num(v.opacity, 1),
    pointerEvents: str(v.pointerEvents),
    zIndex: str(v.zIndex),
    inViewport: typeof v.inViewport === 'boolean' ? v.inViewport : true,
    hitTest:
      hitTest === 'self' || hitTest === 'covered' || hitTest === 'outside' ? hitTest : 'n/a',
    visible: false,
  };
  info.visible =
    typeof v.visible === 'boolean'
      ? v.visible
      : info.rendered &&
        info.rect.w > 0 &&
        info.rect.h > 0 &&
        info.display !== 'none' &&
        info.visibility !== 'hidden' &&
        info.opacity > 0.05 &&
        info.inViewport;
  return info;
}

/** Why a trigger the page measured is not visible, in the owner's words. */
export function triggerHiddenReason(t: TriggerInfo): string {
  if (!t.rendered) return 'нет в DOM';
  if (t.display === 'none') return 'display none';
  if (t.visibility === 'hidden' || t.visibility === 'collapse') return `visibility ${t.visibility}`;
  if (t.opacity <= 0.05) return `opacity ${t.opacity}`;
  if (t.rect.w <= 0 || t.rect.h <= 0) return `размер ${t.rect.w}×${t.rect.h}`;
  if (!t.inViewport) return `за пределами iframe @ ${t.rect.x},${t.rect.y}`;
  return 'причина неизвестна';
}

/** "видна 120×48 @ 38,396 (react)" | "скрыта: display none (raw)". */
export function formatTrigger(t: TriggerInfo): string {
  if (!t.visible) return `скрыта: ${triggerHiddenReason(t)} (${t.which})`;
  const base = `видна ${t.rect.w}×${t.rect.h} @ ${t.rect.x},${t.rect.y} (${t.which})`;
  // Visible yet unclickable is its own failure: the viewer sees a button that
  // does nothing. Say so instead of reporting it as fine.
  const notes: string[] = [];
  if (t.hitTest === 'covered') notes.push('перекрыта');
  if (t.pointerEvents === 'none') notes.push('pointer-events none');
  return notes.length ? `${base}, ${notes.join(', ')}` : base;
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

/**
 * Whether the page was actually in front of the viewer in this state: the
 * document visible (not a background or closed tab), Twitch not hiding the
 * extension, and the iframe given a real size. Unknown counts as on screen.
 */
export function onScreen(state: SessionState): boolean {
  if (state.docVisibility !== undefined && state.docVisibility !== 'visible') return false;
  if (state.twitchVisible === false) return false;
  const v = state.viewport;
  return !v || (v.w >= MIN_IFRAME_PX && v.h >= MIN_IFRAME_PX);
}

/**
 * Apply one event to the running state of a page load. The page's own
 * snapshot is merged first, then whatever the event itself says, because the
 * event is the more specific (and the more recent) of the two.
 *
 * `triggerVisible` is the one snapshot field not taken from the page: it is
 * derived from the trigger measurements below, so the raw SMOKE_TEST button
 * can never stand in for the map button, whatever an older page put there.
 */
export function foldState(
  prev: SessionState,
  ev: { event: string; snap?: SessionState | null; data: Json },
): SessionState {
  const next: SessionState = { ...prev };
  if (ev.snap) {
    for (const [key, value] of Object.entries(ev.snap)) {
      if (value !== undefined && key !== 'triggerVisible') (next as Json)[key] = value;
    }
  }

  const d = ev.data;
  switch (ev.event) {
    case 'twitch_helper_present':
      if (typeof d.present === 'boolean') next.helperPresent = d.present;
      if (typeof d.version === 'string' && d.version) next.helperVersion = d.version;
      break;
    case 'app_bundle_loaded':
      next.stage = 'app';
      if (typeof d.helperPresent === 'boolean') next.helperPresent = d.helperPresent;
      if (typeof d.helperVersion === 'string' && d.helperVersion) next.helperVersion = d.helperVersion;
      break;
    case 'onAuthorized_fired': {
      next.authorized = true;
      const channelId = toChannelId(d.channelId);
      if (channelId) next.channelId = channelId;
      if (isViewerKind(d.viewerKind)) next.viewerKind = d.viewerKind;
      break;
    }
    case 'onVisibilityChanged':
      if (typeof d.visible === 'boolean') next.twitchVisible = d.visible;
      break;
    case 'onHighlightChanged':
      if (typeof d.highlighted === 'boolean') next.highlighted = d.highlighted;
      break;
    case 'document_visibility':
      if (isDocVisibility(d.state)) next.docVisibility = d.state;
      break;
    case 'viewport_resize':
      if (typeof d.w === 'number' && typeof d.h === 'number') {
        next.viewport = { w: Math.round(d.w), h: Math.round(d.h), dpr: prev.viewport?.dpr ?? 1 };
      }
      break;
    default:
      break;
  }

  if (TRIGGER_EVENTS.has(ev.event)) {
    const trigger = parseTrigger(d.trigger);
    if (trigger?.which === 'raw') {
      // "EXTENSION LOADED" proves the iframe is on screen; it is not the map
      // button, and before React adopts it a click on it does nothing.
      next.rawTrigger = trigger;
    } else if (trigger) {
      next.trigger = trigger;
      next.triggerVisible = trigger.visible;
      // The snapshot merged above is the page as it was when this was measured.
      if (onScreen(next)) next.onScreenTrigger = trigger;
    }
  }
  return next;
}

/** "1280×720", or null when the page never reported a size. */
export function formatViewport(v: SessionState['viewport'] | undefined): string | null {
  if (!v || !Number.isFinite(v.w) || !Number.isFinite(v.h)) return null;
  return `${Math.round(v.w)}×${Math.round(v.h)}`;
}

/** "1.28.0" | "есть" | "нет", or "—" before the boot script said anything. */
export function helperLabel(state: SessionState): string {
  if (state.helperPresent === false) return 'нет';
  if (state.helperVersion) return state.helperVersion;
  if (state.helperPresent === true) return 'есть';
  return '—';
}

/** The trigger line for the session state: full detail when it is current. */
function stateTrigger(state: SessionState): string | null {
  if (state.trigger && (state.triggerVisible ?? state.trigger.visible) === state.trigger.visible) {
    return formatTrigger(state.trigger);
  }
  if (state.triggerVisible === true) return 'видна';
  if (state.triggerVisible === false) return 'скрыта';
  return null;
}

function errorText(v: unknown): string | null {
  if (typeof v === 'string') return v || null;
  if (!isRecord(v)) return null;
  const message = str(v.message) || 'ошибка без текста';
  const source = str(v.source);
  if (!source) return message;
  const line = typeof v.line === 'number' ? `:${v.line}` : '';
  const col = typeof v.line === 'number' && typeof v.col === 'number' ? `:${v.col}` : '';
  return `${message} @ ${source}${line}${col}`;
}

/** The one-line error of an event, or null for events that are not errors. */
export function describeError(event: string, data: Json): string | null {
  let text: string | null = null;
  if (ERROR_EVENTS.has(event)) {
    text = errorText(data.error) ?? event;
  } else if (event === 'csp_violation') {
    const csp = isRecord(data.csp) ? data.csp : {};
    const where = str(csp.sourceFile);
    const line = typeof csp.line === 'number' ? `:${csp.line}` : '';
    text = `CSP ${str(csp.directive, '?')} заблокировал ${str(csp.blockedURI, '?')}${
      where ? ` @ ${where}${line}` : ''
    }${csp.disposition === 'report' ? ' (report-only)' : ''}`;
  } else if (event === 'app_bundle_missing') {
    const scripts = Array.isArray(data.moduleScripts)
      ? data.moduleScripts.filter((s): s is string => typeof s === 'string')
      : [];
    text = `приложение не запустилось за 10 с${scripts.length ? `: ${scripts.join(', ')}` : ''}`;
  }
  return text === null ? null : truncate(text, 300);
}

/** One row of the admin event table. */
export function presentEvent(row: DiagEventRow): ExtDiagEventView {
  const state = row.state;
  const ownTrigger = TRIGGER_EVENTS.has(row.event) ? parseTrigger(row.data.trigger) : null;
  return {
    id: row.id,
    receivedAt: row.receivedAt.toISOString(),
    clientTs: row.clientTs ? row.clientTs.toISOString() : null,
    session: row.session,
    surface: row.surface,
    event: row.event,
    channelId: row.channelId ?? state.channelId ?? null,
    viewerKind: row.viewerKind || state.viewerKind || 'unknown',
    viewport: formatViewport(state.viewport),
    docVisibility: state.docVisibility ?? null,
    twitchVisible: state.twitchVisible ?? null,
    helper: helperLabel(state),
    authorized: typeof state.authorized === 'boolean' ? state.authorized : null,
    trigger: ownTrigger ? formatTrigger(ownTrigger) : stateTrigger(state),
    error: describeError(row.event, row.data),
    data: row.data,
  };
}

/**
 * The facts of one page load. `rows` are that session's events, oldest first.
 * Folding again over rows whose state is already folded is harmless, and it
 * keeps this correct for rows written without a merged state.
 */
export function summarizeSession(rows: DiagEventRow[]): LastSessionSummary | null {
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (!first || !last) return null;

  let state: SessionState = {};
  const names: string[] = [];
  const seen = new Set<string>();
  let authorizedEvent = false;
  let mapOpened = false;
  let errorCount = 0;
  let cspCount = 0;
  let lastError: string | null = null;

  for (const row of rows) {
    state = foldState(state, { event: row.event, snap: row.state, data: row.data });
    if (!seen.has(row.event)) {
      seen.add(row.event);
      names.push(row.event);
    }
    if (row.event === 'onAuthorized_fired') authorizedEvent = true;
    if (row.event === 'map_opened') mapOpened = true;
    if (ERROR_EVENTS.has(row.event)) errorCount += 1;
    if (row.event === 'csp_violation') cspCount += 1;
    lastError = describeError(row.event, row.data) ?? lastError;
    if (!state.channelId && row.channelId) state.channelId = row.channelId;
  }

  return {
    session: last.session,
    surface: last.surface,
    firstAt: first.receivedAt.toISOString(),
    lastAt: last.receivedAt.toISOString(),
    events: names,
    htmlLoaded: seen.has('html_loaded'),
    appBundleLoaded: seen.has('app_bundle_loaded'),
    appBundleMissing: seen.has('app_bundle_missing'),
    helperPresent: state.helperPresent ?? null,
    helperVersion: state.helperVersion ?? null,
    authorized: authorizedEvent || state.authorized === true,
    channelId: state.channelId ?? null,
    viewerKind: state.viewerKind ?? 'unknown',
    viewport: formatViewport(state.viewport),
    twitchVisible: state.twitchVisible ?? null,
    docVisibility: state.docVisibility ?? null,
    triggerVisible: state.triggerVisible ?? null,
    triggerWhich: state.trigger?.which ?? null,
    trigger: stateTrigger(state),
    onScreenTriggerVisible: state.onScreenTrigger ? state.onScreenTrigger.visible : null,
    onScreenTrigger: state.onScreenTrigger ? formatTrigger(state.onScreenTrigger) : null,
    rawVisible: state.rawTrigger ? state.rawTrigger.visible : null,
    rawTrigger: state.rawTrigger ? formatTrigger(state.rawTrigger) : null,
    mapOpened,
    errorCount,
    cspCount,
    lastError,
    pageOrigin: state.pageOrigin ?? null,
    referrerOrigin: state.referrerOrigin ?? null,
    twitchState: state.params?.state ?? null,
    anchor: state.params?.anchor ?? null,
  };
}

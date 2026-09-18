import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { ApiClient } from '../shared/api';
import { ApiFailure } from '../shared/api';

const POLL_MS = 5000;
const LIMIT = 50;
/** Tooltips carry the full text; this only stops a runaway payload from becoming a 20 KB title. */
const TITLE_MAX = 1500;

/** Local copy so this module never imports a value from App (no import cycle). */
function errorText(err: unknown): string {
  if (err instanceof ApiFailure) return err.code === 'internal' ? err.message : `${err.message} · ${err.code}`;
  if (err instanceof Error) return err.message;
  return 'Неизвестная ошибка';
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException ? err.name === 'AbortError' : false;
}

// ---------------------------------------------------------------------------
// GET /api/admin/ext-diagnostics — docs/EXTENSION_DIAGNOSTICS.md §5.
// The payload is parsed field by field instead of trusted: the endpoint is new,
// and one object where a string was expected would make React throw and blank
// the whole console, which is exactly when the owner needs it.
// ---------------------------------------------------------------------------

type VerdictCode =
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

interface DiagEventRow {
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

interface ExtRequestRow {
  id: number;
  ts: string;
  source: 'ingress' | 'devserver';
  method: string;
  path: string;
  status: number | null;
  referer: string | null;
  secFetchDest: string | null;
  secFetchSite: string | null;
  userAgent: string | null;
}

interface LastIframeRequest {
  ts: string;
  path: string;
  status: number | null;
  referer: string | null;
}

interface LastSession {
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
  /** The latest map button measurement taken while the page was on screen. */
  onScreenTriggerVisible: boolean | null;
  onScreenTrigger: string | null;
  /** The raw SMOKE_TEST button ("EXTENSION LOADED"), when the page has one. */
  rawVisible: boolean | null;
  rawTrigger: string | null;
  mapOpened: boolean;
  errorCount: number;
  cspCount: number;
  lastError: string | null;
  pageOrigin: string | null;
  referrerOrigin: string | null;
  twitchState: string | null;
  anchor: string | null;
}

interface Verdict {
  /** A VerdictCode; kept open so a code from a newer server still shows up. */
  code: string;
  ok: boolean;
  text: string;
}

interface ExtDiagnosticsResponse {
  serverTime: number;
  events: DiagEventRow[];
  requests: ExtRequestRow[];
  summary: {
    lastIframeRequest: LastIframeRequest | null;
    lastSession: LastSession | null;
    /** Always present per the contract; null here only when the server omitted it. */
    verdict: Verdict | null;
  };
}

type Json = Record<string, unknown>;

function obj(v: unknown): Json | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : null;
}

function str(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function objects(v: unknown): Json[] {
  return Array.isArray(v) ? v.map(obj).filter((row): row is Json => row !== null) : [];
}

function parseEvent(r: Json, index: number): DiagEventRow {
  return {
    // Negative fallback ids never collide with real (serial) ones.
    id: num(r.id) ?? -1 - index,
    receivedAt: str(r.receivedAt) ?? '',
    clientTs: str(r.clientTs),
    session: str(r.session) ?? '',
    surface: str(r.surface) ?? 'unknown',
    event: str(r.event) ?? '?',
    channelId: str(r.channelId),
    viewerKind: str(r.viewerKind) ?? 'unknown',
    viewport: str(r.viewport),
    docVisibility: str(r.docVisibility),
    twitchVisible: bool(r.twitchVisible),
    helper: str(r.helper) ?? '—',
    authorized: bool(r.authorized),
    trigger: str(r.trigger),
    error: str(r.error),
    data: obj(r.data) ?? {},
  };
}

function parseRequest(r: Json, index: number): ExtRequestRow {
  return {
    id: num(r.id) ?? -1 - index,
    ts: str(r.ts) ?? '',
    source: r.source === 'devserver' ? 'devserver' : 'ingress',
    method: str(r.method) ?? 'GET',
    path: str(r.path) ?? '?',
    status: num(r.status),
    referer: str(r.referer),
    secFetchDest: str(r.secFetchDest),
    secFetchSite: str(r.secFetchSite),
    userAgent: str(r.userAgent),
  };
}

function parseLastIframeRequest(r: Json | null): LastIframeRequest | null {
  if (!r) return null;
  const ts = str(r.ts);
  if (!ts) return null;
  return { ts, path: str(r.path) ?? '?', status: num(r.status), referer: str(r.referer) };
}

function parseLastSession(r: Json | null): LastSession | null {
  if (!r) return null;
  const session = str(r.session);
  if (!session) return null;
  return {
    session,
    surface: str(r.surface) ?? 'unknown',
    firstAt: str(r.firstAt) ?? '',
    lastAt: str(r.lastAt) ?? '',
    events: Array.isArray(r.events) ? r.events.map(str).filter((name): name is string => name !== null) : [],
    htmlLoaded: r.htmlLoaded === true,
    appBundleLoaded: r.appBundleLoaded === true,
    appBundleMissing: r.appBundleMissing === true,
    helperPresent: bool(r.helperPresent),
    helperVersion: str(r.helperVersion),
    authorized: r.authorized === true,
    channelId: str(r.channelId),
    viewerKind: str(r.viewerKind) ?? 'unknown',
    viewport: str(r.viewport),
    twitchVisible: bool(r.twitchVisible),
    docVisibility: str(r.docVisibility),
    triggerVisible: bool(r.triggerVisible),
    triggerWhich: str(r.triggerWhich),
    trigger: str(r.trigger),
    onScreenTriggerVisible: bool(r.onScreenTriggerVisible),
    onScreenTrigger: str(r.onScreenTrigger),
    rawVisible: bool(r.rawVisible),
    rawTrigger: str(r.rawTrigger),
    mapOpened: r.mapOpened === true,
    errorCount: num(r.errorCount) ?? 0,
    cspCount: num(r.cspCount) ?? 0,
    lastError: str(r.lastError),
    pageOrigin: str(r.pageOrigin),
    referrerOrigin: str(r.referrerOrigin),
    twitchState: str(r.twitchState),
    anchor: str(r.anchor),
  };
}

function parseVerdict(r: Json | null): Verdict | null {
  if (!r) return null;
  const text = str(r.text);
  if (!text) return null;
  return { code: str(r.code) ?? '?', ok: r.ok === true, text };
}

function parseResponse(raw: unknown): ExtDiagnosticsResponse {
  const root = obj(raw) ?? {};
  const summary = obj(root.summary) ?? {};
  return {
    serverTime: num(root.serverTime) ?? Date.now(),
    events: objects(root.events).map(parseEvent),
    requests: objects(root.requests).map(parseRequest),
    summary: {
      lastIframeRequest: parseLastIframeRequest(obj(summary.lastIframeRequest)),
      lastSession: parseLastSession(obj(summary.lastSession)),
      verdict: parseVerdict(obj(summary.verdict)),
    },
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

type Tone = 'ok' | 'warn' | 'bad';

/** Not-ok verdicts that usually mean "wait" or "Twitch paused it", not "broken". */
const AMBER_VERDICTS: ReadonlySet<string> = new Set<VerdictCode>(['no_data', 'pending', 'iframe_hidden']);

/** Events that are failures by themselves, even when the server left `error` empty. */
const ERROR_EVENTS: ReadonlySet<string> = new Set([
  'runtime_error',
  'unhandled_rejection',
  'resource_error',
  'csp_violation',
  'twitch_ext_error',
  'app_bundle_missing',
]);

/** The milestones the owner scans for; tinted so a healthy load reads at a glance. */
const GOOD_EVENTS: ReadonlySet<string> = new Set([
  'html_loaded',
  'app_bundle_loaded',
  'onAuthorized_fired',
  'raw_button_upgraded',
  'map_opened',
]);

const VIEWER_LABEL: Record<string, string> = {
  anonymous: 'anonymous',
  logged_in: 'logged in',
  identified: 'identified',
  unknown: 'unknown',
};

function viewerLabel(kind: string): string {
  return VIEWER_LABEL[kind] ?? kind;
}

function toMs(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function clockMs(ms: number | null): string {
  if (ms == null) return '—';
  return new Date(ms).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function clock(iso: string | null): string {
  return clockMs(toMs(iso));
}

/** Age against the server clock of the same response, so a skewed laptop clock cannot lie. */
function ago(iso: string | null, now: number): string {
  const ms = toMs(iso);
  if (ms == null) return '—';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s} с назад`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} ч назад`;
  return `${Math.round(h / 24)} д назад`;
}

function clip(text: string): string {
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX)}…` : text;
}

function lines(parts: Array<string | null>): string {
  return clip(parts.filter((part): part is string => part !== null && part !== '').join('\n'));
}

function yesNo(v: boolean | null): string {
  return v == null ? '—' : v ? 'да' : 'нет';
}

function visibilityText(doc: string | null, twitch: boolean | null): string {
  return `${doc ?? '—'} · twitch ${twitch == null ? '—' : twitch ? 'видим' : 'скрыт'}`;
}

function visibilityTone(doc: string | null, twitch: boolean | null): Tone | null {
  if (doc === 'hidden' || twitch === false) return 'bad';
  if (doc === 'visible' && twitch === true) return 'ok';
  return null;
}

function statusTone(status: number | null): Tone | null {
  if (status == null) return null;
  if (status >= 400) return 'bad';
  if (status >= 300) return 'warn';
  return 'ok';
}

function statusPill(status: number | null): string {
  if (status == null) return 'is-dim';
  if (status >= 500) return 'is-bad';
  if (status >= 400) return 'is-accent';
  if (status >= 300) return 'is-redirect';
  if (status >= 200) return 'is-ok';
  return 'is-neutral';
}

/** Prefer the measured TriggerInfo; fall back to the server's Russian summary. */
function triggerTone(row: DiagEventRow): Tone | null {
  const info = obj(row.data.trigger);
  const visible = info ? bool(info.visible) : null;
  if (visible != null) return visible ? 'ok' : 'bad';
  if (!row.trigger) return null;
  if (row.trigger.startsWith('видна')) return 'ok';
  if (row.trigger.startsWith('скрыта')) return 'bad';
  return null;
}

function toneClass(tone: Tone | null | undefined): string {
  return tone ? ` is-${tone}` : '';
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** A single-line cell that ellipsises and keeps the full text in the tooltip. */
function Cut({
  text,
  size,
  title,
  className,
}: {
  text: string | null;
  size: 's' | 'm' | 'l';
  title?: string;
  className?: string;
}): JSX.Element {
  return (
    <span className={`ad-cut is-${size}${className ? ` ${className}` : ''}`} title={title ?? text ?? undefined}>
      {text ?? '—'}
    </span>
  );
}

function VerdictBanner({ verdict }: { verdict: Verdict | null }): JSX.Element {
  if (!verdict) {
    return (
      <div className="ad-verdict is-warn" role="status">
        <i className="dot warn" />
        <span className="ad-verdict-text">Сервер не прислал вердикт.</span>
      </div>
    );
  }
  const tone: Tone = verdict.ok ? 'ok' : AMBER_VERDICTS.has(verdict.code) ? 'warn' : 'bad';
  return (
    <div className={`ad-verdict is-${tone}`} role="status">
      <i className={`dot ${tone}`} />
      <span className="ad-verdict-code">{verdict.code}</span>
      <span className="ad-verdict-text">{verdict.text}</span>
    </div>
  );
}

function Fact({
  label,
  tone,
  title,
  children,
}: {
  label: string;
  tone?: Tone | null;
  title?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <span className={`ad-fact${toneClass(tone)}`} title={title}>
      <span className="label">{label}</span>
      <b>{children}</b>
    </span>
  );
}

function Facts({ summary, now }: { summary: ExtDiagnosticsResponse['summary']; now: number }): JSX.Element {
  const req = summary.lastIframeRequest;
  const s = summary.lastSession;

  const helper: { text: string; tone: Tone | null } = !s
    ? { text: '—', tone: null }
    : s.helperPresent === false
      ? { text: 'нет', tone: 'bad' }
      : s.helperVersion
        ? { text: s.helperVersion, tone: 'ok' }
        : s.helperPresent
          ? { text: 'есть', tone: 'ok' }
          : { text: '—', tone: null };

  return (
    <div className="ad-facts">
      <Fact
        label="iframe"
        tone={req ? statusTone(req.status) : 'warn'}
        title={req ? lines([req.ts, req.path, `Referer: ${req.referer ?? '—'}`]) : undefined}
      >
        {req
          ? `${clock(req.ts)} · ${ago(req.ts, now)} · ${req.path} · ${req.status ?? '—'} · ${req.referer ?? 'без Referer'}`
          : 'Twitch ещё не запрашивал страницу'}
      </Fact>

      {s ? (
        <>
          <Fact
            label="сессия"
            title={lines([
              `session ${s.session}`,
              `${s.firstAt} → ${s.lastAt}`,
              s.anchor ? `anchor: ${s.anchor}` : null,
              s.events.length > 0 ? `события: ${s.events.join(', ')}` : null,
            ])}
          >
            {clock(s.lastAt)} · {s.surface}
          </Fact>
          <Fact label="helper" tone={helper.tone}>
            {helper.text}
          </Fact>
          <Fact label="onAuthorized" tone={s.authorized ? 'ok' : 'warn'}>
            {s.authorized
              ? `да${s.channelId ? ` · ${s.channelId}` : ''} · ${viewerLabel(s.viewerKind)}`
              : 'нет'}
          </Fact>
          <Fact
            label="бандл"
            tone={s.appBundleLoaded ? 'ok' : s.appBundleMissing ? 'bad' : null}
          >
            {s.appBundleLoaded ? 'запущен' : s.appBundleMissing ? 'не запустился' : 'нет данных'}
          </Fact>
          <Fact
            label="trigger"
            tone={s.triggerVisible == null ? null : s.triggerVisible ? 'ok' : 'bad'}
            title={lines([
              s.trigger,
              s.onScreenTrigger ? `на экране: ${s.onScreenTrigger}` : 'на экране ещё не измерялся',
            ])}
          >
            {s.trigger ?? 'не измерялся'}
          </Fact>
          {s.rawTrigger && (
            <Fact label="EXTENSION LOADED" tone={s.rawVisible ? 'ok' : 'bad'} title={s.rawTrigger}>
              {s.rawTrigger}
            </Fact>
          )}
          <Fact label="карта" tone={s.mapOpened ? 'ok' : null}>
            {s.mapOpened ? 'открывали' : 'не открывали'}
          </Fact>
          <Fact
            label="ошибки"
            tone={s.errorCount + s.cspCount > 0 ? 'bad' : null}
            title={s.lastError ? `последняя: ${s.lastError}` : undefined}
          >
            {s.errorCount} · CSP {s.cspCount}
          </Fact>
          <Fact label="viewport">{s.viewport ?? '—'}</Fact>
          <Fact label="видимость" tone={visibilityTone(s.docVisibility, s.twitchVisible)}>
            {visibilityText(s.docVisibility, s.twitchVisible)}
          </Fact>
          <Fact label="state">{s.twitchState ?? '—'}</Fact>
          <Fact
            label="origin"
            title={lines([`страница: ${s.pageOrigin ?? '—'}`, `referrer: ${s.referrerOrigin ?? '—'}`])}
          >
            {s.pageOrigin ?? '—'} ← {s.referrerOrigin ?? '—'}
          </Fact>
        </>
      ) : (
        <Fact label="сессия" tone="warn">
          страница ещё не отчитывалась
        </Fact>
      )}
    </div>
  );
}

function EventsTable({ rows }: { rows: DiagEventRow[] }): JSX.Element {
  if (rows.length === 0) {
    return (
      <div className="ad-empty">
        Событий пока нет: расширение ещё ни разу не отчиталось. Запустите стрим и откройте канал.
      </div>
    );
  }
  return (
    <div className="ad-table-wrap scroll-thin">
      <table className="ad-table ad-diag-table">
        <thead>
          <tr>
            <th>время</th>
            <th>событие</th>
            <th>channelId</th>
            <th>зритель</th>
            <th>viewport</th>
            <th>видимость</th>
            <th>helper</th>
            <th>trigger</th>
            <th>ошибка</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const isError = row.error !== null || ERROR_EVENTS.has(row.event);
            // A heavier rule where one page load ends and the previous one begins.
            const split = i > 0 && rows[i - 1]?.session !== row.session;
            const dataText = Object.keys(row.data).length > 0 ? `data: ${JSON.stringify(row.data)}` : null;
            const eventTone: Tone | null = isError ? 'bad' : GOOD_EVENTS.has(row.event) ? 'ok' : null;
            const visTone = visibilityTone(row.docVisibility, row.twitchVisible);
            return (
              <tr
                key={row.id}
                className={`${isError ? 'is-err' : ''}${split ? ' is-split' : ''}`.trim() || undefined}
              >
                <td
                  className="num"
                  title={lines([row.receivedAt, row.clientTs ? `клиент: ${row.clientTs}` : null]) || undefined}
                >
                  {clock(row.receivedAt)}
                </td>
                <td>
                  <Cut
                    text={row.event}
                    size="m"
                    className={`mono${toneClass(eventTone)}`}
                    title={lines([
                      row.event,
                      `surface: ${row.surface}`,
                      `session: ${row.session}`,
                      dataText,
                    ])}
                  />
                  {row.surface !== 'video_overlay' ? <span className="ad-sub"> · {row.surface}</span> : null}
                </td>
                <td className="mono">{row.channelId ?? '—'}</td>
                <td title={`onAuthorized: ${yesNo(row.authorized)}`}>{viewerLabel(row.viewerKind)}</td>
                <td className="num">{row.viewport ?? '—'}</td>
                <td className={toneClass(visTone).trim() || undefined}>
                  {visibilityText(row.docVisibility, row.twitchVisible)}
                </td>
                <td className={row.helper === 'нет' ? 'is-bad' : undefined}>{row.helper}</td>
                <td>
                  <Cut text={row.trigger} size="m" className={toneClass(triggerTone(row)).trim()} />
                </td>
                <td>
                  <Cut text={row.error} size="l" className={row.error ? 'is-bad' : 'is-dim'} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RequestsTable({ rows }: { rows: ExtRequestRow[] }): JSX.Element {
  if (rows.length === 0) {
    return (
      <div className="ad-empty">
        Запросов пока нет: Twitch ещё не загружал страницы расширения через этот сервер.
      </div>
    );
  }
  return (
    <div className="ad-table-wrap scroll-thin">
      <table className="ad-table ad-diag-table">
        <thead>
          <tr>
            <th>время</th>
            <th>path</th>
            <th>status</th>
            <th>Referer</th>
            <th>Sec-Fetch-Dest</th>
            <th>User-Agent</th>
            <th>source</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((req) => {
            const iframe = req.secFetchDest === 'iframe';
            return (
              <tr key={req.id}>
                <td className="num" title={req.ts || undefined}>
                  {clock(req.ts)}
                </td>
                <td>
                  {req.method !== 'GET' ? <span className="ad-sub">{req.method} </span> : null}
                  <Cut text={req.path} size="l" className="mono" title={`${req.method} ${req.path}`} />
                </td>
                <td>
                  <span className={`ad-pill num ${statusPill(req.status)}`}>{req.status ?? '—'}</span>
                </td>
                <td>
                  <Cut text={req.referer} size="m" className="mono" />
                </td>
                <td
                  className={iframe ? 'is-accent' : undefined}
                  title={req.secFetchSite ? `Sec-Fetch-Site: ${req.secFetchSite}` : undefined}
                >
                  {req.secFetchDest ?? '—'}
                </td>
                <td>
                  <Cut text={req.userAgent} size="m" />
                </td>
                <td className="is-dim">{req.source}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

interface ExtDiagnosticsPanelProps {
  api: ApiClient;
  onAuthError: (err: unknown) => boolean;
}

/**
 * What the Twitch iframe reported about itself, next to what Twitch actually
 * requested — so "is the map button visible to viewers" is answered here and
 * never in DevTools.
 */
export function ExtDiagnosticsPanel({ api, onAuthError }: ExtDiagnosticsPanelProps): JSX.Element {
  const [data, setData] = useState<ExtDiagnosticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    let inFlight = false;
    const controller = new AbortController();

    const tick = (): void => {
      if (!alive || inFlight) return;
      inFlight = true;
      void (async () => {
        try {
          const raw = await api.get<unknown>(`/api/admin/ext-diagnostics?limit=${LIMIT}`, controller.signal);
          if (!alive) return;
          setData(parseResponse(raw));
          setError(null);
          setSyncedAt(Date.now());
        } catch (err) {
          if (!alive || isAbort(err)) return;
          if (onAuthError(err)) return;
          // The last good snapshot stays on screen; only this line says it is old.
          setError(errorText(err));
        } finally {
          inFlight = false;
        }
      })();
    };

    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
      controller.abort();
    };
  }, [api, onAuthError]);

  const note = syncedAt == null ? (error ? 'нет данных' : 'загрузка…') : `обновлено ${clockMs(syncedAt)}`;

  return (
    <section className="panel ad-panel ad-diag">
      <div className="ad-panel-head">
        <div className="ad-panel-title">TWITCH EXTENSION DIAGNOSTICS</div>
        <div className="ad-panel-note num">{note}</div>
      </div>

      {error ? <div className="ad-diag-err">Диагностика не обновилась: {error}</div> : null}

      {data ? (
        <>
          <VerdictBanner verdict={data.summary.verdict} />
          <Facts summary={data.summary} now={data.serverTime} />

          <div className="ad-diag-block">
            <div className="label ad-group-title">
              События расширения <span className="ad-sub num">· {data.events.length}</span>
            </div>
            <EventsTable rows={data.events} />
          </div>

          <div className="ad-diag-block">
            <div className="label ad-group-title">
              Запросы Twitch к страницам <span className="ad-sub num">· {data.requests.length}</span>
            </div>
            <RequestsTable rows={data.requests} />
          </div>
        </>
      ) : error ? null : (
        <div className="ad-empty">Загружаю диагностику…</div>
      )}
    </section>
  );
}

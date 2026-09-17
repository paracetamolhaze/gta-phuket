import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ApiClient, ApiFailure } from '../shared/api';
import { connectSocket } from '../shared/socket';
import type { SocketRole } from '../shared/socket';
import { formatDistance, formatDuration, formatPoints } from '../shared/format';

/**
 * Local stand-in for the Twitch player.
 *
 * The page composites the three layers a real viewer sees — video, the burnt-in
 * OBS overlay, the extension — and drives the backend through `/api/dev/*`,
 * which runs the production code paths (the redemption is a signed EventSub
 * payload posted into the real webhook, not a shortcut).
 */

const LOG_LIMIT = 200;
const DEFAULT_DEV_USER = '100000001';
/** The OBS browser source is authored for 1920x1080 and scaled into the video. */
const OBS_WIDTH = 1920;
const OBS_HEIGHT = 1080;

interface Preset {
  readonly label: string;
  readonly lat: number;
  readonly lng: number;
}

const PRESETS: readonly Preset[] = [
  { label: 'Патонг', lat: 7.8961, lng: 98.2958 },
  { label: 'Карон', lat: 7.846, lng: 98.2946 },
  { label: 'Ката', lat: 7.82, lng: 98.298 },
  { label: 'Пхукет-таун', lat: 7.8804, lng: 98.3923 },
  { label: 'Jungceylon', lat: 7.8921, lng: 98.2966 },
];

const QUICK_LINKS: readonly { href: string; note: string }[] = [
  { href: '/streamer.html', note: 'Телефон стримера — отдаёт GPS' },
  { href: '/obs.html', note: 'Оверлей для OBS, 1920×1080' },
  { href: '/admin.html', note: 'Пульт: настройки, слоты, отмена' },
  { href: '/viewer.html', note: 'Расширение отдельной вкладкой' },
];

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

type LogKind = 'rt' | 'net' | 'err' | 'sys';

interface LogEntry {
  id: number;
  at: number;
  kind: LogKind;
  name: string;
  detail: string;
  raw: string;
}

function stamp(at: number): string {
  const d = new Date(at);
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

// ---------------------------------------------------------------------------
// Tolerant readers — realtime payloads arrive as `unknown` through onAny
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toJson(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

function clip(text: string, max = 200): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function coords(rec: Record<string, unknown>): string {
  const lat = asNumber(rec.lat);
  const lng = asNumber(rec.lng);
  if (lat === null || lng === null) return '';
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

/** Short Russian gloss for the events worth reading at a glance. */
function summarize(event: string, payload: unknown): string {
  const rec = asRecord(payload);
  if (!rec) return clip(toJson(payload));

  switch (event) {
    case 'gps:update': {
      const status = asString(rec.status) ?? '—';
      const sample = asRecord(rec.sample);
      const where = sample ? coords(sample) : coords(rec);
      const age = asNumber(rec.ageMs);
      return [status, where, age === null ? '' : `${Math.round(age / 100) / 10} с`]
        .filter((part) => part.length > 0)
        .join(' · ');
    }
    case 'gps:stale': {
      const age = asNumber(rec.ageMs);
      return age === null ? 'нет фикса' : `нет фикса ${Math.round(age / 1000)} с`;
    }
    case 'route:update':
      return `осталось ${formatDistance(asNumber(rec.remainingDistanceMeters))} · ${formatDuration(
        asNumber(rec.remainingDurationSeconds),
      )}`;
    case 'waypoint:quoted':
      return `${asString(rec.code) ?? '—'} · ${asString(rec.destinationName) ?? '—'} · ${formatPoints(
        asNumber(rec.cost),
      )}`;
    case 'waypoint:awaiting_payment':
      return `${asString(rec.code) ?? '—'} · «${asString(rec.rewardTitle) ?? '—'}» · ${formatPoints(
        asNumber(rec.cost),
      )}`;
    case 'waypoint:activated':
      return `${asString(rec.destinationName) ?? '—'} · ${formatPoints(
        asNumber(rec.channelPointsPaid),
      )} · ${asString(rec.paidBy) ?? 'аноним'}`;
    case 'waypoint:completed':
      return asString(rec.destinationName) ?? '—';
    case 'waypoint:canceled':
      return asString(rec.reason) ?? '—';
    // A quote dying is deliberately a different event from a waypoint dying:
    // a losing quote must never blank the running job on the HUD.
    case 'quote:canceled':
      return `расчёт ${clip(asString(rec.quoteId) ?? '—', 8)} · ${asString(rec.reason) ?? '—'}`;
    case 'reward:redeemed':
      return `${asString(rec.userId) ?? '—'} · ${formatPoints(asNumber(rec.cost))}`;
    case 'reward:refunded':
      return `${asString(rec.userId) ?? '—'} · ${asString(rec.reason) ?? '—'}`;
    case 'slots:update':
      return `${asNumber(rec.free) ?? '?'} / ${asNumber(rec.total) ?? '?'} свободно`;
    case 'state:snapshot': {
      const waypoint = asRecord(rec.activeWaypoint);
      const open = rec.waypointsOpen === true ? 'приём открыт' : 'приём закрыт';
      return `${open} · ${waypoint ? (asString(waypoint.destinationName) ?? 'точка активна') : 'точки нет'}`;
    }
    default:
      return clip(toJson(payload));
  }
}

/**
 * `/api/dev/state` is not pinned down by the contract, so instead of guessing a
 * shape we walk the response for the quote that is waiting to be paid.
 */
function findQuoteId(value: unknown, wanted: string | null, depth = 0): string | null {
  if (depth > 6 || value === null || typeof value !== 'object') return null;

  if (Array.isArray(value)) {
    const items = value as unknown[];
    for (const item of items) {
      const hit = findQuoteId(item, wanted, depth + 1);
      if (hit !== null) return hit;
    }
    return null;
  }

  const rec = value as Record<string, unknown>;
  const status = asString(rec.status);
  if (wanted === null || status === wanted) {
    const id = asString(rec.quoteId) ?? (status !== null ? asString(rec.id) : null);
    if (id !== null) return id;
  }

  for (const nested of Object.values(rec)) {
    const hit = findQuoteId(nested, wanted, depth + 1);
    if (hit !== null) return hit;
  }
  return null;
}

function pendingQuoteIdOf(state: unknown): string | null {
  return (
    findQuoteId(state, 'AWAITING_REDEMPTION') ??
    findQuoteId(state, 'QUOTED') ??
    findQuoteId(state, null)
  );
}

function describeError(err: unknown): string {
  if (err instanceof ApiFailure) return `${err.status} ${err.code} — ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * The admin surface owns its own storage key, so look for anything that reads
 * like one. With a token the log sees exact GPS and settings; without it the
 * socket joins as a plain viewer, which is still enough to debug the flow.
 */
function readAdminToken(): string | null {
  const unwrap = (raw: string): string | null => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    if (!trimmed.startsWith('"') && !trimmed.startsWith('{')) return trimmed;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed.length > 0 ? parsed : null;
      const rec = asRecord(parsed);
      return rec ? asString(rec.token) : null;
    } catch {
      return trimmed;
    }
  };

  try {
    const store = window.localStorage;
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key === null || !/admin/i.test(key) || !/token|session|auth/i.test(key)) continue;
      const raw = store.getItem(key);
      if (raw !== null) {
        const token = unwrap(raw);
        if (token !== null) return token;
      }
    }
  } catch {
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fake player chrome
// ---------------------------------------------------------------------------

function Glyph({ name }: { name: 'play' | 'volume' | 'gear' | 'expand' }): JSX.Element {
  const common = { width: 20, height: 20, viewBox: '0 0 24 24', 'aria-hidden': true } as const;
  if (name === 'play') {
    return (
      <svg {...common}>
        <path d="M7 4.6v14.8L19.4 12z" fill="currentColor" />
      </svg>
    );
  }
  if (name === 'volume') {
    return (
      <svg {...common}>
        <path d="M4 9.4h3.6L12 5.2v13.6l-4.4-4.2H4z" fill="currentColor" />
        <path
          d="M15.4 8.8a4.6 4.6 0 0 1 0 6.4"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.7}
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (name === 'gear') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="3.1" fill="none" stroke="currentColor" strokeWidth={1.7} />
        <path
          d="M12 3.2v2.1M12 18.7v2.1M3.2 12h2.1M18.7 12h2.1M5.8 5.8l1.5 1.5M16.7 16.7l1.5 1.5M18.2 5.8l-1.5 1.5M7.3 16.7l-1.5 1.5"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.7}
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path
        d="M4.5 9.2V4.5h4.7M19.5 9.2V4.5h-4.7M4.5 14.8v4.7h4.7M19.5 14.8v4.7h-4.7"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------

export default function App(): JSX.Element {
  const dev = useMemo(() => new ApiClient({ basePath: '/api/dev' }), []);

  // --- viewer identity -----------------------------------------------------
  const [devUser, setDevUser] = useState(DEFAULT_DEV_USER);
  const [viewerUser, setViewerUser] = useState(DEFAULT_DEV_USER);
  const [viewerKey, setViewerKey] = useState(0);

  // --- gps simulator -------------------------------------------------------
  const first = PRESETS[0];
  const [latText, setLatText] = useState(first ? String(first.lat) : '7.8961');
  const [lngText, setLngText] = useState(first ? String(first.lng) : '98.2958');
  const [speedMps, setSpeedMps] = useState(1.4);
  const [walking, setWalking] = useState(false);

  // --- redemption ----------------------------------------------------------
  const [quoteId, setQuoteId] = useState('');
  const [redeemHint, setRedeemHint] = useState<string | null>(null);
  const [stateMissing, setStateMissing] = useState(false);

  // --- plumbing ------------------------------------------------------------
  const [busy, setBusy] = useState<string | null>(null);
  const [devOff, setDevOff] = useState(false);
  const [resetArmed, setResetArmed] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [socketState, setSocketState] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [obsScale, setObsScale] = useState(1);

  const logId = useRef(0);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const pushLog = useCallback((kind: LogKind, name: string, detail = '', raw = ''): void => {
    logId.current += 1;
    const entry: LogEntry = { id: logId.current, at: Date.now(), kind, name, detail, raw };
    setLog((prev) => {
      const next = [entry, ...prev];
      return next.length > LOG_LIMIT ? next.slice(0, LOG_LIMIT) : next;
    });
  }, []);

  // --- socket: the debugging view -----------------------------------------
  const adminToken = useMemo(() => readAdminToken(), []);
  const socketRole: SocketRole = adminToken === null ? 'viewer' : 'admin';

  useEffect(() => {
    const socket = connectSocket({ role: socketRole, token: adminToken });

    socket.on('connect', () => {
      setSocketState('online');
      pushLog('sys', 'socket:connect', `роль ${socketRole}${socket.id ? ` · ${socket.id}` : ''}`);
    });
    socket.on('disconnect', (reason: string) => {
      setSocketState('offline');
      pushLog('err', 'socket:disconnect', reason);
    });
    socket.on('connect_error', (err: Error) => {
      setSocketState('offline');
      pushLog('err', 'socket:error', err.message);
    });
    socket.onAny((event: string, ...args: unknown[]) => {
      const payload = args[0];
      pushLog('rt', event, summarize(event, payload), toJson(payload));
      if (event === 'waypoint:quoted' || event === 'waypoint:awaiting_payment') {
        const id = asString(asRecord(payload)?.quoteId);
        if (id !== null) setQuoteId(id);
      }
    });

    return () => {
      socket.offAny();
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [adminToken, socketRole, pushLog]);

  // --- OBS layer is authored at 1920x1080; scale it into the player box -----
  // Layout effect: at scale 1 the overlay would flash at full size for a frame.
  useLayoutEffect(() => {
    const node = stageRef.current;
    if (node === null) return;
    const apply = (width: number): void => {
      if (width > 0) setObsScale(width / OBS_WIDTH);
    };
    apply(node.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) apply(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!resetArmed) return;
    const timer = window.setTimeout(() => setResetArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [resetArmed]);

  // --- /api/dev/* ----------------------------------------------------------
  const post = useCallback(
    async (key: string, path: string, body: Record<string, unknown>): Promise<boolean> => {
      setBusy(key);
      try {
        const result = await dev.post<unknown>(path, body);
        setDevOff(false);
        pushLog('net', `POST /api/dev${path}`, 'ok', toJson(result));
        return true;
      } catch (err) {
        if (err instanceof ApiFailure && err.status === 404) setDevOff(true);
        pushLog('err', `POST /api/dev${path}`, describeError(err));
        return false;
      } finally {
        setBusy((current) => (current === key ? null : current));
      }
    },
    [dev, pushLog],
  );

  const fetchPendingQuoteId = useCallback(async (): Promise<string | null> => {
    setBusy('state');
    try {
      const state = await dev.get<unknown>('/state');
      setStateMissing(false);
      const id = pendingQuoteIdOf(state);
      pushLog('net', 'GET /api/dev/state', id === null ? 'ожидающего расчёта нет' : `quoteId ${id}`, toJson(state));
      return id;
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 404) setStateMissing(true);
      pushLog('err', 'GET /api/dev/state', describeError(err));
      return null;
    } finally {
      setBusy((current) => (current === 'state' ? null : current));
    }
  }, [dev, pushLog]);

  const point = useMemo(() => {
    const lat = Number(latText.replace(',', '.'));
    const lng = Number(lngText.replace(',', '.'));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  }, [latText, lngText]);

  const applyPreset = useCallback((preset: Preset): void => {
    setLatText(String(preset.lat));
    setLngText(String(preset.lng));
  }, []);

  const dropHere = useCallback(async (): Promise<void> => {
    if (point === null) return;
    await post('gps', '/gps', { lat: point.lat, lng: point.lng, accuracy: 6, heading: null, speed: 0 });
  }, [point, post]);

  const startWalk = useCallback(async (): Promise<void> => {
    if (point === null) return;
    const ok = await post('sim-start', '/gps/sim/start', { lat: point.lat, lng: point.lng, speedMps });
    if (ok) setWalking(true);
  }, [point, post, speedMps]);

  const stopWalk = useCallback(async (): Promise<void> => {
    const ok = await post('sim-stop', '/gps/sim/stop', {});
    if (ok) setWalking(false);
  }, [post]);

  const redeem = useCallback(async (): Promise<void> => {
    let id = quoteId.trim();
    if (id.length === 0) {
      const found = await fetchPendingQuoteId();
      if (found !== null) {
        id = found;
        setQuoteId(found);
      }
    }
    if (id.length === 0) {
      setRedeemHint('Нет quoteId. Выбери точку во вьюере и подтверди её — либо вставь quoteId руками.');
      return;
    }
    setRedeemHint(null);
    const ok = await post('redeem', '/redeem', { quoteId: id });
    if (!ok) setRedeemHint('Выкуп не прошёл — смотри последнюю строку лога.');
  }, [quoteId, fetchPendingQuoteId, post]);

  const resetAll = useCallback(async (): Promise<void> => {
    if (!resetArmed) {
      setResetArmed(true);
      return;
    }
    setResetArmed(false);
    const ok = await post('reset', '/reset', {});
    if (ok) {
      setWalking(false);
      setQuoteId('');
    }
  }, [resetArmed, post]);

  const reloadViewer = useCallback((): void => {
    const next = devUser.trim().length > 0 ? devUser.trim() : DEFAULT_DEV_USER;
    setDevUser(next);
    setViewerUser(next);
    setViewerKey((k) => k + 1);
    pushLog('sys', 'viewer:reload', `devUser ${next}`);
  }, [devUser, pushLog]);

  const viewerSrc = `/viewer.html?devUser=${encodeURIComponent(viewerUser)}&platform=web`;

  return (
    <div className="dev-shell">
      <header className="dev-banner">
        <span className="dev-banner-tag label">DEV ONLY</span>
        <p>
          Страница живёт только при <b className="mono">DEV_MODE=true</b> на сервере. Каждая кнопка здесь идёт через
          настоящий серверный код: «выкуп» — это подписанный EventSub-payload в реальный вебхук, а не обход логики.
        </p>
      </header>

      {devOff && (
        <div className="dev-alert" role="status">
          DEV_MODE выключен на сервере — <span className="mono">/api/dev/*</span> отвечает 404.
        </div>
      )}

      <div className="dev-body">
        <main className="dev-stage">
          <div className="dev-player" ref={stageRef}>
            {/* 1. Стенд-ин вместо видео */}
            <div className="dev-video" aria-hidden="true">
              <div className="dev-watermark">
                <span className="dev-watermark-main">ЭМУЛЯЦИЯ ВИДЕО</span>
                <span className="dev-watermark-sub label">здесь нет настоящего стрима</span>
              </div>
            </div>

            {/* 2. Оверлей OBS — то, что вшито в картинку стрима */}
            <div className="dev-obs-wrap" aria-hidden="true">
              <iframe
                className="dev-obs"
                title="OBS overlay"
                src="/obs.html"
                style={{
                  width: `${OBS_WIDTH}px`,
                  height: `${OBS_HEIGHT}px`,
                  transform: `scale(${obsScale})`,
                }}
              />
            </div>

            {/* 3. Слой расширения — единственный, который принимает клики */}
            <iframe
              key={viewerKey}
              className="dev-viewer"
              title="Twitch extension"
              src={viewerSrc}
            />

            {/* 4. Контролы плеера: ровно та полоса, которую расширение обходит */}
            <div
              className="dev-controls"
              title="Настоящие контролы Twitch перехватывают клики — расширение держит здесь безопасную зону"
            >
              <div className="dev-scrub">
                <span />
              </div>
              <button type="button" className="dev-ctl" aria-label="Пауза (муляж)">
                <Glyph name="play" />
              </button>
              <button type="button" className="dev-ctl" aria-label="Звук (муляж)">
                <Glyph name="volume" />
              </button>
              <div className="dev-volume" aria-hidden="true">
                <span />
              </div>
              <span className="dev-live">
                <i className="dot bad" />В ЭФИРЕ
              </span>
              <span className="dev-spacer" />
              <button type="button" className="dev-ctl" aria-label="Настройки (муляж)">
                <Glyph name="gear" />
              </button>
              <button type="button" className="dev-ctl" aria-label="На весь экран (муляж)">
                <Glyph name="expand" />
              </button>
            </div>
          </div>

          <p className="dev-stage-note label">
            Слои снизу вверх: видео · оверлей OBS (клики не ловит) · расширение (ловит) · контролы плеера (перехватывают)
          </p>
        </main>

        <aside className="dev-rail">
          <section className="panel dev-card">
            <h2 className="label">Зритель</h2>
            <div className="dev-row">
              <input
                className="dev-input mono"
                value={devUser}
                onChange={(e) => setDevUser(e.target.value)}
                inputMode="numeric"
                spellCheck={false}
                aria-label="devUser"
              />
              <button type="button" className="btn btn-ghost dev-wide" onClick={reloadViewer}>
                Перезагрузить зрителя
              </button>
            </div>
            <p className="dev-note">
              Новый <span className="mono">devUser</span> перемонтирует слой расширения — так проверяется второй
              «человек» в чате.
            </p>
          </section>

          <section className="panel dev-card">
            <h2 className="label">GPS-симулятор</h2>
            <div className="dev-presets">
              {PRESETS.map((preset) => {
                const active = point !== null && point.lat === preset.lat && point.lng === preset.lng;
                return (
                  <button
                    key={preset.label}
                    type="button"
                    className={`dev-chip${active ? ' is-active' : ''}`}
                    onClick={() => applyPreset(preset)}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>

            <div className="dev-row dev-row-2">
              <label className="dev-field">
                <span className="label">Широта</span>
                <input
                  className="dev-input mono num"
                  value={latText}
                  onChange={(e) => setLatText(e.target.value)}
                  inputMode="decimal"
                  spellCheck={false}
                />
              </label>
              <label className="dev-field">
                <span className="label">Долгота</span>
                <input
                  className="dev-input mono num"
                  value={lngText}
                  onChange={(e) => setLngText(e.target.value)}
                  inputMode="decimal"
                  spellCheck={false}
                />
              </label>
            </div>

            <button
              type="button"
              className="btn btn-primary dev-wide"
              onClick={() => void dropHere()}
              disabled={point === null || busy === 'gps'}
            >
              Поставить тут
            </button>

            <label className="dev-slider">
              <span className="label">
                Скорость <span className="num">{speedMps.toFixed(1)}</span> м/с
              </span>
              <input
                type="range"
                min={0.5}
                max={3}
                step={0.1}
                value={speedMps}
                onChange={(e) => setSpeedMps(Number(e.target.value))}
              />
            </label>

            <div className="dev-row dev-row-2">
              <button
                type="button"
                className="btn dev-wide"
                onClick={() => void startWalk()}
                disabled={point === null || busy === 'sim-start'}
              >
                Старт движения
              </button>
              <button
                type="button"
                className="btn btn-ghost dev-wide"
                onClick={() => void stopWalk()}
                disabled={busy === 'sim-stop'}
              >
                Стоп
              </button>
            </div>

            <p className="dev-note">
              <i className={`dot ${walking ? 'ok' : ''}`} /> {walking ? 'Симулятор идёт' : 'Симулятор стоит'}. Когда
              точка активна, сервер ведёт симулированного стримера по настоящему маршруту — остаток пути в HUD падает
              сам.
            </p>
          </section>

          <section className="panel dev-card">
            <h2 className="label">Оплата баллами</h2>
            <button
              type="button"
              className="dev-redeem"
              onClick={() => void redeem()}
              disabled={busy === 'redeem' || busy === 'state'}
            >
              <span className="dev-redeem-title">Simulate Twitch Redemption</span>
              <span className="dev-redeem-sub">вместо зрителя, который тратит баллы канала</span>
            </button>

            <div className="dev-row">
              <input
                className="dev-input mono"
                value={quoteId}
                onChange={(e) => setQuoteId(e.target.value)}
                placeholder="quoteId (подставится сам)"
                spellCheck={false}
                aria-label="quoteId"
              />
              <button
                type="button"
                className="btn btn-ghost dev-narrow"
                onClick={() => void fetchPendingQuoteId()}
                disabled={busy === 'state'}
              >
                Подтянуть
              </button>
            </div>

            {stateMissing && (
              <p className="dev-hint">
                <span className="mono">/api/dev/state</span> отвечает 404 — либо эндпоинта нет, либо DEV_MODE выключен
                на сервере. Вставь <span className="mono">quoteId</span> вручную.
              </p>
            )}
            {redeemHint !== null && <p className="dev-hint">{redeemHint}</p>}

            <p className="dev-note">
              Сервер собирает подписанный EventSub-payload и прогоняет его через тот же вебхук, что и настоящий Twitch.
            </p>

            <button
              type="button"
              className={`btn btn-ghost dev-wide${resetArmed ? ' is-armed' : ''}`}
              onClick={() => void resetAll()}
              disabled={busy === 'reset'}
            >
              {resetArmed ? 'Точно сбросить?' : 'Сброс состояния'}
            </button>
          </section>

          <section className="panel dev-card">
            <h2 className="label">Поверхности</h2>
            <div className="dev-links">
              {QUICK_LINKS.map((link) => (
                <a key={link.href} className="dev-link" href={link.href} target="_blank" rel="noreferrer noopener">
                  <span className="dev-link-path mono">{link.href}</span>
                  <span className="dev-link-note">{link.note}</span>
                </a>
              ))}
            </div>
          </section>

          <section className="panel dev-card dev-card-log">
            <div className="dev-log-head">
              <h2 className="label">
                Лог событий · {socketRole}
                <i
                  className={`dot ${socketState === 'online' ? 'ok' : socketState === 'connecting' ? 'warn' : 'bad'}`}
                />
              </h2>
              <button type="button" className="dev-clear label" onClick={() => setLog([])}>
                Очистить
              </button>
            </div>
            <div className="dev-log scroll-thin mono">
              {log.length === 0 ? (
                <p className="dev-log-empty">Тишина. События появятся здесь, новые сверху.</p>
              ) : (
                log.map((entry) => (
                  <div key={entry.id} className={`dev-log-row is-${entry.kind}`} title={entry.raw}>
                    <span className="dev-log-time num">{stamp(entry.at)}</span>
                    <span className="dev-log-name">{entry.name}</span>
                    <span className="dev-log-detail">{entry.detail}</span>
                  </div>
                ))
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

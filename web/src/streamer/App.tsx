/**
 * Streamer phone PWA.
 *
 * One job: push GPS and show the streamer where to walk. Everything numeric on
 * this screen (distance, ETA, price) is computed by the server and only
 * rendered here — the phone never derives a price or a remaining distance.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Socket } from 'socket.io-client';

import { ApiClient, ApiFailure, viewerMessage } from '../shared/api';
import { bind, connectSocket } from '../shared/socket';
import {
  bearingToCardinal,
  formatDistance,
  formatDuration,
  formatGta,
  formatPoints,
} from '../shared/format';
import type { ActiveWaypointView, GpsState } from '../shared/types';

import {
  bearingDegrees,
  haversineMeters,
  normalizeDegrees,
  useGeolocation,
} from './useGeolocation';
import type { GeoFix } from './useGeolocation';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOKEN_KEY = 'gta.streamer.deviceToken';
const CHANNEL_KEY = 'gta.streamer.channelId';

/** Upload cadence: move this far, or wait this long — never faster than MIN. */
const PUSH_MIN_MOVE_M = 8;
const PUSH_MAX_INTERVAL_MS = 3000;
const PUSH_MIN_INTERVAL_MS = 1500;
const PUSH_TICK_MS = 400;

const ARM_MS = 4000;

/** The two ways out of a job that is not completed; order is the on-screen order. */
const CANCEL_BUTTONS: ReadonlyArray<{ reason: CancelReason; label: string }> = [
  { reason: 'cannot', label: 'НЕ МОГУ' },
  { reason: 'unsafe', label: 'НЕБЕЗОПАСНО' },
];
const BANNER_MS = 15000;
const FLASH_MS = 1400;

// ---------------------------------------------------------------------------
// Capability shims (kept local so the build never depends on lib.dom versions)
// ---------------------------------------------------------------------------

interface WakeLockSentinelLike {
  release: () => Promise<void>;
  addEventListener?: (type: string, listener: () => void) => void;
}

interface WakeLockLike {
  request: (type: 'screen') => Promise<WakeLockSentinelLike>;
}

function getWakeLock(): WakeLockLike | null {
  const nav = navigator as unknown as { wakeLock?: WakeLockLike };
  return nav.wakeLock ?? null;
}

function buzz(pattern: number[]): void {
  const nav = navigator as unknown as { vibrate?: (p: number[]) => boolean };
  if (typeof nav.vibrate !== 'function') return;
  try {
    nav.vibrate(pattern);
  } catch {
    /* some browsers throw when the page is not visible — never fatal */
  }
}

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* private mode / blocked storage: the session still works, it just
       will not survive a reload */
  }
}

function deviceLabel(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const kind = /iPhone/i.test(ua)
    ? 'iPhone'
    : /iPad/i.test(ua)
      ? 'iPad'
      : /Android/i.test(ua)
        ? 'Android'
        : 'Телефон';
  return `${kind} · ${new Date().toLocaleDateString('ru-RU')}`;
}

/** "1.2 км" -> { value: "1.2", unit: "км" } so the number can be enormous. */
function splitValue(text: string): { value: string; unit: string } {
  const cut = text.lastIndexOf(' ');
  if (cut <= 0) return { value: text, unit: '' };
  return { value: text.slice(0, cut), unit: text.slice(cut + 1) };
}

// ---------------------------------------------------------------------------
// Wire shapes (see docs/API.md, /api/streamer/*)
// ---------------------------------------------------------------------------

interface PairResponse {
  deviceToken: string;
  channelId: string;
}

interface StreamerStateResponse {
  gps: GpsState;
  activeWaypoint: ActiveWaypointView | null;
  waypointsOpen: boolean;
}

interface Auth {
  deviceToken: string;
  channelId: string;
}

/** Why the streamer gives up on a job: POST /api/streamer/waypoint/cancel. */
type CancelReason = 'cannot' | 'unsafe';

interface CancelResponse {
  ok: boolean;
  refunded?: boolean;
  amount?: number | null;
}

/**
 * The banner after НЕ МОГУ / НЕБЕЗОПАСНО. The amount is only ever what the
 * server says it refunded. `wasGta` is the waypoint's currency captured before
 * the call: a legacy points job has no GTA$ to talk about.
 */
function cancelNotice(reason: CancelReason, res: CancelResponse | undefined, wasGta: boolean): string {
  const what = reason === 'unsafe' ? 'Точка отменена: небезопасно' : 'Точка отменена: не могу дойти';
  const amount = typeof res?.amount === 'number' && Number.isFinite(res.amount) ? res.amount : null;
  if (res?.refunded && amount != null && amount > 0) return `${what}. Зрителю возвращено ${formatGta(amount)}`;
  if (res?.refunded) return `${what}. GTA$ возвращены зрителю`;
  return wasGta ? `${what}. GTA$ не возвращались` : what;
}

type LinkState = 'connecting' | 'online' | 'reconnecting' | 'offline';

// ---------------------------------------------------------------------------
// Rotating arrow: keep turning the short way round, never 359° backwards.
// ---------------------------------------------------------------------------

function useSmoothAngle(target: number | null): number {
  const [angle, setAngle] = useState(0);
  const acc = useRef(0);

  useEffect(() => {
    if (target == null) return;
    const delta = normalizeDegrees(target - acc.current + 180) - 180;
    acc.current += delta;
    setAngle(acc.current);
  }, [target]);

  return angle;
}

// ---------------------------------------------------------------------------

export function App(): JSX.Element {
  const [auth, setAuth] = useState<Auth | null>(() => {
    const token = readStored(TOKEN_KEY);
    if (!token) return null;
    return { deviceToken: token, channelId: readStored(CHANNEL_KEY) ?? '' };
  });

  const [code, setCode] = useState('');
  const [reveal, setReveal] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);

  const [waypoint, setWaypoint] = useState<ActiveWaypointView | null>(null);
  const [waypointsOpen, setWaypointsOpen] = useState<boolean | null>(null);

  const [link, setLink] = useState<LinkState>('connecting');
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  );
  const [linkError, setLinkError] = useState<string | null>(null);

  const [banner, setBanner] = useState(false);
  const [flashing, setFlashing] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);

  const [armComplete, setArmComplete] = useState(false);
  const [armCancel, setArmCancel] = useState<CancelReason | null>(null);
  const [armUnpair, setArmUnpair] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [canceling, setCanceling] = useState<CancelReason | null>(null);

  const [pushedAt, setPushedAt] = useState<number | null>(null);
  const [wakeOn, setWakeOn] = useState(false);

  const geo = useGeolocation();

  const tokenRef = useRef<string | null>(auth?.deviceToken ?? null);
  const socketRef = useRef<Socket | null>(null);
  const pendingRef = useRef<GeoFix | null>(null);
  const lastSentRef = useRef<{ at: number; fix: GeoFix } | null>(null);
  const wakeRef = useRef<WakeLockSentinelLike | null>(null);
  const wantWakeRef = useRef(false);
  const gestureRef = useRef(false);
  const noticeTimer = useRef<number | null>(null);

  useEffect(() => {
    tokenRef.current = auth?.deviceToken ?? null;
  }, [auth]);

  const api = useMemo(
    () => new ApiClient({ basePath: '/api/streamer', getToken: () => tokenRef.current }),
    [],
  );

  // -- notices -------------------------------------------------------------

  const say = useCallback((kind: 'ok' | 'bad', text: string) => {
    setNotice({ kind, text });
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 6000);
  }, []);

  useEffect(
    () => () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    },
    [],
  );

  // -- wake lock -----------------------------------------------------------

  const acquireWake = useCallback(async () => {
    const wl = getWakeLock();
    if (!wl || wakeRef.current) return;
    try {
      const sentinel = await wl.request('screen');
      wakeRef.current = sentinel;
      setWakeOn(true);
      sentinel.addEventListener?.('release', () => {
        wakeRef.current = null;
        setWakeOn(false);
      });
    } catch {
      setWakeOn(false);
    }
  }, []);

  const releaseWake = useCallback(() => {
    const sentinel = wakeRef.current;
    wakeRef.current = null;
    setWakeOn(false);
    if (sentinel) void sentinel.release().catch(() => undefined);
  }, []);

  useEffect(() => {
    const want = waypoint !== null && gestureRef.current;
    wantWakeRef.current = want;
    if (want) void acquireWake();
    else releaseWake();
  }, [waypoint, acquireWake, releaseWake]);

  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible' && wantWakeRef.current) void acquireWake();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [acquireWake]);

  useEffect(() => releaseWake, [releaseWake]);

  // -- network flag --------------------------------------------------------

  useEffect(() => {
    const up = (): void => setOnline(true);
    const down = (): void => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  // -- auth ----------------------------------------------------------------

  const clearAuth = useCallback((reason: string | null) => {
    writeStored(TOKEN_KEY, null);
    writeStored(CHANNEL_KEY, null);
    tokenRef.current = null;
    setAuth(null);
    setWaypoint(null);
    setWaypointsOpen(null);
    setCode('');
    setPairError(reason);
  }, []);

  const onPair = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = code.trim();
      if (!trimmed || pairing) return;
      gestureRef.current = true;
      setPairing(true);
      setPairError(null);
      api
        .post<PairResponse>('/pair', { code: trimmed, label: deviceLabel() })
        .then((res) => {
          writeStored(TOKEN_KEY, res.deviceToken);
          writeStored(CHANNEL_KEY, res.channelId);
          tokenRef.current = res.deviceToken;
          setAuth({ deviceToken: res.deviceToken, channelId: res.channelId });
          setCode('');
        })
        .catch((err: unknown) => {
          if (err instanceof ApiFailure && (err.status === 401 || err.status === 403)) {
            setPairError('Неверный код');
          } else if (err instanceof ApiFailure && err.code === 'invalid_request') {
            setPairError('Неверный код');
          } else {
            setPairError(viewerMessage(err));
          }
        })
        .finally(() => setPairing(false));
    },
    [api, code, pairing],
  );

  // -- initial state -------------------------------------------------------

  useEffect(() => {
    if (!auth) return;
    let alive = true;
    api
      .get<StreamerStateResponse>('/state')
      .then((res) => {
        if (!alive) return;
        setWaypoint(res.activeWaypoint);
        setWaypointsOpen(res.waypointsOpen);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        if (err instanceof ApiFailure && (err.status === 401 || err.status === 403)) {
          clearAuth('Устройство больше не авторизовано. Введи код заново');
        }
      });
    return () => {
      alive = false;
    };
  }, [api, auth, clearAuth]);

  // -- socket --------------------------------------------------------------

  useEffect(() => {
    if (!auth) return;

    const socket = connectSocket({
      role: 'streamer',
      token: auth.deviceToken,
      channelId: auth.channelId || undefined,
    });
    socketRef.current = socket;
    setLink('connecting');

    const onConnect = (): void => {
      setLink('online');
      setLinkError(null);
    };
    const onDisconnect = (reason: string): void => {
      setLink(reason === 'io client disconnect' ? 'offline' : 'reconnecting');
    };
    const onConnectError = (err: Error): void => {
      setLink('reconnecting');
      if (/unauthor|forbidden|token/i.test(err.message)) {
        setLinkError('Сервер не принял устройство. Привяжи заново');
      }
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);

    const offs: Array<() => void> = [
      bind(socket, 'state:snapshot', (payload) => {
        setWaypointsOpen(payload.waypointsOpen);
        setWaypoint(payload.activeWaypoint);
      }),
      bind(socket, 'waypoint:activated', (payload) => {
        setWaypoint(payload);
        setBanner(true);
        setFlashing(true);
        setArmComplete(false);
        setArmCancel(null);
        buzz([120, 60, 120]);
      }),
      bind(socket, 'route:update', (payload) => {
        setWaypoint((prev) =>
          prev
            ? {
                ...prev,
                liveRouteGeometry: payload.liveRouteGeometry,
                remainingDistanceMeters: payload.remainingDistanceMeters,
                remainingDurationSeconds: payload.remainingDurationSeconds,
              }
            : prev,
        );
      }),
      bind(socket, 'waypoint:completed', () => {
        setWaypoint(null);
        setBanner(false);
        setArmComplete(false);
        setArmCancel(null);
      }),
      bind(socket, 'waypoint:canceled', () => {
        setWaypoint(null);
        setBanner(false);
        setArmComplete(false);
        setArmCancel(null);
      }),
      bind(socket, 'settings:update', (settings) => {
        setWaypointsOpen(settings.waypointsOpen);
      }),
    ];

    return () => {
      for (const off of offs) off();
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [auth]);

  // -- flash / banner timers ----------------------------------------------

  useEffect(() => {
    if (!flashing) return;
    const id = window.setTimeout(() => setFlashing(false), FLASH_MS);
    return () => window.clearTimeout(id);
  }, [flashing]);

  useEffect(() => {
    if (!banner) return;
    const id = window.setTimeout(() => setBanner(false), BANNER_MS);
    return () => window.clearTimeout(id);
  }, [banner]);

  useEffect(() => {
    if (!armComplete) return;
    const id = window.setTimeout(() => setArmComplete(false), ARM_MS);
    return () => window.clearTimeout(id);
  }, [armComplete]);

  // Re-arming the other cancel button restarts the window: the dep changes.
  useEffect(() => {
    if (!armCancel) return;
    const id = window.setTimeout(() => setArmCancel(null), ARM_MS);
    return () => window.clearTimeout(id);
  }, [armCancel]);

  useEffect(() => {
    if (!armUnpair) return;
    const id = window.setTimeout(() => setArmUnpair(false), ARM_MS);
    return () => window.clearTimeout(id);
  }, [armUnpair]);

  // -- GPS upload ----------------------------------------------------------

  useEffect(() => {
    if (geo.state !== 'watching') {
      pendingRef.current = null;
      return;
    }
    if (geo.lastPosition) pendingRef.current = geo.lastPosition;
  }, [geo.state, geo.lastPosition]);

  useEffect(() => {
    const id = window.setInterval(() => {
      const fix = pendingRef.current;
      const socket = socketRef.current;
      // Socket down: keep only the newest sample and flush it on reconnect.
      if (!fix || !socket || !socket.connected) return;

      const now = Date.now();
      const last = lastSentRef.current;
      if (last) {
        if (now - last.at < PUSH_MIN_INTERVAL_MS) return;
        const moved = haversineMeters(last.fix, fix);
        if (moved < PUSH_MIN_MOVE_M && now - last.at < PUSH_MAX_INTERVAL_MS) return;
      }

      socket.emit('gps:push', {
        lat: fix.lat,
        lng: fix.lng,
        accuracy: fix.accuracy,
        heading: fix.heading,
        speed: fix.speed,
        timestamp: fix.timestamp,
      });
      lastSentRef.current = { at: now, fix };
      setPushedAt(now);
    }, PUSH_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  // -- actions -------------------------------------------------------------

  const enableGps = useCallback(() => {
    gestureRef.current = true;
    geo.start();
    if (waypoint) void acquireWake();
  }, [geo, waypoint, acquireWake]);

  const retryGps = useCallback(() => {
    gestureRef.current = true;
    geo.stop();
    geo.start();
  }, [geo]);

  const onComplete = useCallback(() => {
    gestureRef.current = true;
    if (!armComplete) {
      // One armed button at a time, so a second tap can only confirm what it armed.
      setArmCancel(null);
      setArmComplete(true);
      buzz([20]);
      return;
    }
    setArmComplete(false);
    setCompleting(true);
    api
      .post<{ ok: true }>('/waypoint/complete')
      .then(() => {
        setWaypoint(null);
        setBanner(false);
        say('ok', 'Точка завершена');
      })
      .catch((err: unknown) => say('bad', viewerMessage(err)))
      .finally(() => setCompleting(false));
  }, [api, armComplete, say]);

  /**
   * НЕ МОГУ / НЕБЕЗОПАСНО: same arm-then-confirm as the complete button. The
   * server cancels the job and returns a GTA$ waypoint's cost to the viewer;
   * the phone only reports the amount the server says it refunded.
   */
  const onCancel = useCallback(
    (reason: CancelReason) => {
      gestureRef.current = true;
      if (armCancel !== reason) {
        setArmComplete(false);
        setArmCancel(reason);
        buzz([20]);
        return;
      }
      setArmCancel(null);
      setCanceling(reason);
      // Captured before the call: the canceled event may clear the waypoint first.
      const wasGta = waypoint?.currency === 'GTA_DOLLAR';
      api
        .post<CancelResponse>('/waypoint/cancel', { reason })
        .then((res) => {
          setWaypoint(null);
          setBanner(false);
          say('ok', cancelNotice(reason, res, wasGta));
        })
        .catch((err: unknown) => say('bad', viewerMessage(err)))
        .finally(() => setCanceling(null));
    },
    [api, armCancel, say, waypoint],
  );

  const onUnpair = useCallback(() => {
    if (!armUnpair) {
      setArmUnpair(true);
      return;
    }
    setArmUnpair(false);
    geo.stop();
    clearAuth(null);
  }, [armUnpair, clearAuth, geo]);

  // -- derived -------------------------------------------------------------

  const fix = geo.lastPosition;
  const headingKnown = fix?.heading != null;

  const targetAngle = useMemo(() => {
    if (!fix || !waypoint) return null;
    const bearing = bearingDegrees(fix, waypoint.destination);
    const heading = fix.heading;
    return heading != null ? normalizeDegrees(bearing - heading) : bearing;
  }, [fix, waypoint]);

  const arrowAngle = useSmoothAngle(targetAngle);

  const compass = useMemo(() => {
    if (!fix || !waypoint) return '';
    return bearingToCardinal(bearingDegrees(fix, waypoint.destination));
  }, [fix, waypoint]);

  const remaining = splitValue(formatDistance(waypoint?.remainingDistanceMeters ?? null));
  const etaSeconds = waypoint?.remainingDurationSeconds ?? null;
  const arrival =
    etaSeconds != null && Number.isFinite(etaSeconds)
      ? new Date(Date.now() + etaSeconds * 1000).toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
        })
      : null;

  const linkState: LinkState = !online ? 'offline' : link;
  const linkWord =
    linkState === 'online' ? 'ОНЛАЙН' : linkState === 'offline' ? 'НЕТ СЕТИ' : 'СВЯЗЬ…';
  const linkDot = linkState === 'online' ? 'ok' : linkState === 'offline' ? 'bad' : 'warn';

  const gpsDot =
    geo.state !== 'watching' || !fix
      ? 'bad'
      : fix.accuracy <= 25
        ? 'ok'
        : fix.accuracy <= 60
          ? 'warn'
          : 'bad';
  const gpsWord =
    geo.state === 'watching' && fix
      ? `±${Math.round(fix.accuracy)} м`
      : geo.state === 'denied'
        ? 'ЗАПРЕЩЁН'
        : geo.state === 'requesting'
          ? 'ИЩЕМ…'
          : 'ВЫКЛ';

  const navUrl = waypoint
    ? `https://www.google.com/maps/dir/?api=1&destination=${waypoint.destination.lat},${waypoint.destination.lng}&travelmode=walking`
    : '';

  // Remounting the beat restarts its CSS pulse — one blink per uploaded fix.
  const beatKey = pushedAt ?? 0;

  const isGta = waypoint?.currency === 'GTA_DOLLAR';
  // One request at a time across ЗАВЕРШИТЬ / НЕ МОГУ / НЕБЕЗОПАСНО.
  const busy = completing || canceling !== null;

  // -- pairing screen ------------------------------------------------------

  if (!auth) {
    return (
      <div className="sc">
        <form className="sc-pair" onSubmit={onPair}>
          <div className="sc-pair-head">
            <div className="label">Привязка телефона</div>
            <h1 className="sc-pair-title">КОД&nbsp;ПАРЫ</h1>
            <p className="sc-pair-note">
              Введи код с сервера. Он сохранится на этом телефоне, второй раз спрашивать не будем.
            </p>
          </div>

          <div className="sc-pair-field">
            <input
              className="sc-input mono"
              type={reveal ? 'text' : 'password'}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="••••••••"
              autoComplete="one-time-code"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="go"
              aria-label="Код привязки"
            />
            <button
              type="button"
              className="btn btn-ghost sc-reveal"
              onClick={() => setReveal((v) => !v)}
            >
              {reveal ? 'СКРЫТЬ' : 'ПОКАЗАТЬ'}
            </button>
          </div>

          {pairError ? <div className="sc-note bad">{pairError}</div> : null}

          <button
            className="btn btn-primary sc-xl"
            type="submit"
            disabled={pairing || code.trim().length === 0}
          >
            {pairing ? 'ПОДКЛЮЧАЕМ…' : 'ПОДКЛЮЧИТЬ'}
          </button>
        </form>
      </div>
    );
  }

  // -- main screen ---------------------------------------------------------

  return (
    <div className={`sc${flashing ? ' is-flashing' : ''}`}>
      <header className="sc-head">
        <div className="sc-stat">
          <span className={`dot ${gpsDot}`} />
          <span className="sc-stat-key">GPS</span>
          <span className="num">{gpsWord}</span>
        </div>
        <div className="sc-stat">
          <span className={`dot ${linkDot}`} />
          <span>{linkWord}</span>
          <span className="sc-beat" key={beatKey} aria-hidden="true" />
        </div>
        <div className="sc-hint">
          {wakeOn ? 'Экран не гаснет · убавь яркость' : 'Держи павербанк под рукой'}
        </div>
      </header>

      <main className="sc-body">
        {linkError ? <div className="sc-note bad">{linkError}</div> : null}
        {notice ? <div className={`sc-note ${notice.kind}`}>{notice.text}</div> : null}

        {geo.state !== 'watching' ? (
          <section className="sc-gate">
            {geo.state === 'denied' ? (
              <>
                <div className="label">Геолокация</div>
                <h2 className="sc-gate-title">ДОСТУП ЗАПРЕЩЁН</h2>
                <p className="sc-gate-note">
                  Открой настройки браузера → «Настройки сайтов» → «Геолокация» и разреши доступ
                  для этого сайта, потом перезагрузи страницу.
                </p>
                <button className="btn sc-xl" type="button" onClick={retryGps}>
                  ПОПРОБОВАТЬ СНОВА
                </button>
              </>
            ) : geo.state === 'unsupported' ? (
              <>
                <div className="label">Геолокация</div>
                <h2 className="sc-gate-title">НЕ ПОДДЕРЖИВАЕТСЯ</h2>
                <p className="sc-gate-note">Этот браузер не умеет отдавать координаты. Открой Chrome или Safari.</p>
              </>
            ) : geo.state === 'requesting' || geo.state === 'error' ? (
              <>
                <div className="label">Геолокация</div>
                <h2 className="sc-gate-title">ЛОВИМ СПУТНИКИ</h2>
                <p className="sc-gate-note">{geo.error ?? 'Выйди на открытое место, это займёт несколько секунд.'}</p>
                <button className="btn sc-xl" type="button" onClick={retryGps}>
                  ПЕРЕЗАПУСТИТЬ GPS
                </button>
              </>
            ) : (
              <>
                <div className="label">Шаг 1</div>
                <h2 className="sc-gate-title">GPS ВЫКЛЮЧЕН</h2>
                <p className="sc-gate-note">
                  Зрители не увидят карту, пока телефон не отдаёт координаты.
                </p>
                <button className="btn btn-primary sc-xl" type="button" onClick={enableGps}>
                  ВКЛЮЧИТЬ GPS
                </button>
              </>
            )}
          </section>
        ) : null}

        {waypoint ? (
          <section className="sc-active">
            {banner ? (
              <div className="sc-banner">
                <span className="sc-banner-text">НОВАЯ ТОЧКА</span>
                <button
                  type="button"
                  className="sc-banner-x"
                  onClick={() => setBanner(false)}
                  aria-label="Скрыть уведомление"
                >
                  ✕
                </button>
              </div>
            ) : null}

            <div className="sc-dial" aria-hidden="true">
              <svg viewBox="0 0 200 200" className="sc-dial-ring">
                <circle cx="100" cy="100" r="94" className="sc-ring-outer" />
                <circle cx="100" cy="100" r="72" className="sc-ring-inner" />
                <path d="M100 6 L100 20" className="sc-tick sc-tick-n" />
                <path d="M194 100 L180 100" className="sc-tick" />
                <path d="M100 194 L100 180" className="sc-tick" />
                <path d="M6 100 L20 100" className="sc-tick" />
              </svg>
              <svg
                viewBox="0 0 200 200"
                className="sc-dial-arrow"
                style={{ transform: `rotate(${arrowAngle}deg)` }}
              >
                <path
                  d="M100 18 L156 148 C128 132 72 132 44 148 Z"
                  className="sc-arrow-body"
                />
                <circle cx="100" cy="126" r="7" className="sc-arrow-pin" />
              </svg>
            </div>

            <div className="sc-frame">
              {headingKnown ? (
                <span className="label">
                  ПО КОМПАСУ ТЕЛЕФОНА{compass ? ` · НА ${compass}` : ''}
                </span>
              ) : (
                <span className="label sc-frame-warn">
                  БЕЗ КОМПАСА · СЕВЕР ВВЕРХУ{compass ? ` · НА ${compass}` : ''}
                </span>
              )}
            </div>

            <h1 className="sc-dest">{waypoint.destinationName}</h1>

            <div className="sc-metric">
              <span className="sc-metric-value num">{remaining.value}</span>
              <span className="sc-metric-unit">{remaining.unit}</span>
            </div>

            <div className="sc-eta num">
              {formatDuration(etaSeconds)}
              {arrival ? <span className="sc-eta-at"> · прибытие ~{arrival}</span> : null}
            </div>

            <div className="sc-paid">
              {waypoint.paidBy ? `${waypoint.paidBy} · ` : ''}
              {isGta ? (
                <span className="num">{formatGta(waypoint.channelPointsPaid)}</span>
              ) : (
                <>
                  <span className="num">{formatPoints(waypoint.channelPointsPaid)}</span> очков
                </>
              )}
            </div>

            <div className="sc-actions">
              <a
                className="btn sc-xl"
                href={navUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => {
                  gestureRef.current = true;
                }}
              >
                ОТКРЫТЬ НАВИГАТОР
              </a>
              <button
                type="button"
                className={`btn sc-xl sc-finish${armComplete ? ' is-armed' : ''}`}
                onClick={onComplete}
                disabled={busy}
              >
                {completing ? 'ОТПРАВЛЯЕМ…' : armComplete ? 'НАЖМИ ЕЩЁ РАЗ' : 'ЗАВЕРШИТЬ'}
              </button>
              <div className="sc-abort">
                {CANCEL_BUTTONS.map(({ reason, label }) => (
                  <button
                    key={reason}
                    type="button"
                    className={`btn sc-xl sc-finish sc-abort-btn${armCancel === reason ? ' is-armed' : ''}`}
                    onClick={() => onCancel(reason)}
                    disabled={busy}
                  >
                    {canceling === reason ? 'ОТПРАВЛЯЕМ…' : armCancel === reason ? 'НАЖМИ ЕЩЁ РАЗ' : label}
                  </button>
                ))}
              </div>
              {isGta && waypoint.channelPointsPaid > 0 ? (
                <div className="sc-abort-note">
                  Отмена вернёт зрителю <span className="num">{formatGta(waypoint.channelPointsPaid)}</span>
                </div>
              ) : null}
            </div>
          </section>
        ) : (
          <section className="sc-wait">
            <div className="sc-wait-mark" aria-hidden="true">
              <svg viewBox="0 0 120 120">
                <circle cx="60" cy="60" r="52" className="sc-wait-ring" />
                <circle cx="60" cy="60" r="6" className="sc-wait-dot" />
              </svg>
            </div>
            <h1 className="sc-wait-title">ЖДЁМ ТОЧКУ</h1>
            <div className="sc-wait-coords mono num">
              {fix ? `${fix.lat.toFixed(5)}, ${fix.lng.toFixed(5)}` : 'координат пока нет'}
            </div>
            <div className="sc-wait-open">
              Приём точек:{' '}
              <span className={waypointsOpen == null ? '' : waypointsOpen ? 'is-open' : 'is-closed'}>
                {waypointsOpen == null ? '—' : waypointsOpen ? 'открыт' : 'закрыт'}
              </span>
            </div>
          </section>
        )}
      </main>

      <footer className="sc-foot">
        <span className="label">{auth.channelId ? `КАНАЛ ${auth.channelId}` : 'УСТРОЙСТВО ПРИВЯЗАНО'}</span>
        <button
          type="button"
          className={`btn btn-ghost sc-unpair${armUnpair ? ' is-armed' : ''}`}
          onClick={onUnpair}
        >
          {armUnpair ? 'ТОЧНО?' : 'ОТВЯЗАТЬ'}
        </button>
      </footer>
    </div>
  );
}

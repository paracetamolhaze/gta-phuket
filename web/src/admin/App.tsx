import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Socket } from 'socket.io-client';

import { ApiClient, ApiFailure } from '../shared/api';
import { bind, connectSocket } from '../shared/socket';
import type {
  ActiveWaypointView,
  ChannelSettings,
  GpsState,
  GpsStatus,
  PublicGps,
  QuoteStatus,
  SlotStatus,
} from '../shared/types';

import { ExtDiagnosticsPanel } from './ExtDiagnosticsPanel';
import { SettingsPanel } from './SettingsPanel';
import { StatusPanel } from './StatusPanel';

const TOKEN_KEY = 'gta.admin.token';
const POLL_MS = 2000;
const TICK_MS = 1000;
const TOAST_MS = 7000;

// ---------------------------------------------------------------------------
// Local view types for /api/admin/state. The server response is described in
// docs/API.md; only the domain types it embeds live in shared/types.ts.
// ---------------------------------------------------------------------------

/**
 * The exact ActiveWaypointView plus the purchased distance when the server
 * happens to send it. It is not in the published contract, so the console also
 * remembers the largest remaining distance it has seen as a fallback baseline.
 */
export type AdminWaypointView = ActiveWaypointView & { routeDistanceMeters?: number };

export interface AdminSlotItem {
  index: number;
  status: SlotStatus;
  currentTitle: string | null;
  currentCost: number | null;
  enabled: boolean;
  quoteId: string | null;
  reservedForUser: string | null;
}

export interface AdminSlotsView {
  total: number;
  free: number;
  items: AdminSlotItem[] | null;
}

export interface AdminQuoteRow {
  id: string;
  code: string;
  status: QuoteStatus;
  destinationName: string;
  cost: number;
  twitchUserName: string | null;
  expiresAt: number;
  createdAt?: number;
}

export interface AdminOAuthView {
  connected: boolean;
  scopes: string[];
  expiresAt: number | null;
  eventsub: { count: number; types: string[] };
}

export type ToastKind = 'ok' | 'err' | 'info';

interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

/** Everything in the payload is treated as optional: a half-built server must
 *  not blank the whole console. */
interface RawAdminState {
  gps?: Partial<GpsState> | null;
  activeWaypoint?: AdminWaypointView | null;
  settings?: ChannelSettings | null;
  slots?: { total?: number; free?: number; items?: AdminSlotItem[] | null } | null;
  quotes?: AdminQuoteRow[] | null;
  oauth?: {
    connected?: boolean;
    scopes?: string[] | null;
    expiresAt?: number | null;
    eventsub?: { count?: number; types?: string[] | null } | null;
  } | null;
}

const EMPTY_GPS: GpsState = { status: 'missing', sample: null, ageMs: null };
const EMPTY_SLOTS: AdminSlotsView = { total: 0, free: 0, items: null };
const EMPTY_OAUTH: AdminOAuthView = {
  connected: false,
  scopes: [],
  expiresAt: null,
  eventsub: { count: 0, types: [] },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeStoredToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: the session simply does not survive a reload */
  }
}

/** Admin copy shows the server message verbatim; the code is kept as a suffix. */
export function errorText(err: unknown): string {
  if (err instanceof ApiFailure) {
    return err.code === 'internal' ? err.message : `${err.message} · ${err.code}`;
  }
  if (err instanceof Error) return err.message;
  return 'Неизвестная ошибка';
}

function isGpsState(payload: PublicGps | GpsState): payload is GpsState {
  return 'sample' in payload;
}

function isAbort(err: unknown): boolean {
  return err instanceof DOMException ? err.name === 'AbortError' : false;
}

function normalizeGps(raw: Partial<GpsState> | null | undefined): GpsState {
  if (!raw) return EMPTY_GPS;
  const status: GpsStatus = raw.status ?? 'missing';
  return {
    status,
    sample: raw.sample ?? null,
    ageMs: typeof raw.ageMs === 'number' ? raw.ageMs : null,
  };
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

function LoginScreen({ onToken }: { onToken: (token: string) => void }): JSX.Element {
  const api = useMemo(() => new ApiClient(), []);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const res = await api.post<{ token?: string }>('/api/admin/login', { password });
        const token = res?.token;
        if (typeof token !== 'string' || !token) throw new Error('Сервер не вернул токен');
        setPassword('');
        onToken(token);
      } catch (err) {
        setError(errorText(err));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <div className="ad-login">
      <form className="panel ad-login-panel" onSubmit={submit}>
        <div className="ad-login-brand">
          GTA PHUKET <span>LIVE ADMIN</span>
        </div>
        <label className="ad-field">
          <span className="label">Пароль администратора</span>
          <input
            className="ad-input"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
        </label>
        {error ? <div className="ad-err ad-err-block">{error}</div> : null}
        <button className="btn btn-primary ad-login-btn" type="submit" disabled={busy || !password}>
          {busy ? 'ПРОВЕРЯЮ…' : 'ВОЙТИ'}
        </button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Confirm dialog
// ---------------------------------------------------------------------------

type ConfirmKind = 'cancel' | 'clear';

interface ConfirmDialogProps {
  kind: ConfirmKind;
  busy: boolean;
  onClose: () => void;
  onConfirm: (reason: string, refund: boolean) => void;
}

function ConfirmDialog({ kind, busy, onClose, onConfirm }: ConfirmDialogProps): JSX.Element {
  const [reason, setReason] = useState('Отменено стримером');
  const [refund, setRefund] = useState(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const isCancel = kind === 'cancel';

  return (
    <div className="ad-modal" role="dialog" aria-modal="true">
      <div className="panel ad-modal-panel">
        <div className="ad-panel-title">{isCancel ? 'ОТМЕНИТЬ ЗАДАНИЕ' : 'СБРОСИТЬ МАРШРУТ'}</div>
        <p className="ad-modal-text">
          {isCancel
            ? 'Активное задание будет закрыто. Зритель увидит отмену на оверлее.'
            : 'Текущий маршрут и состояние точки будут очищены. Действие необратимо.'}
        </p>
        {isCancel ? (
          <>
            <label className="ad-field">
              <span className="label">Причина</span>
              <input
                className="ad-input"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                disabled={busy}
              />
            </label>
            <label className="ad-check">
              <input
                type="checkbox"
                checked={refund}
                onChange={(e) => setRefund(e.target.checked)}
                disabled={busy}
              />
              <span>Вернуть баллы зрителю</span>
            </label>
          </>
        ) : null}
        <div className="ad-modal-row">
          <button className="btn btn-ghost" type="button" onClick={onClose} disabled={busy}>
            НАЗАД
          </button>
          <button
            className="btn btn-danger"
            type="button"
            onClick={() => onConfirm(reason.trim(), refund)}
            disabled={busy}
          >
            {busy ? 'ВЫПОЛНЯЮ…' : isCancel ? 'ОТМЕНИТЬ' : 'СБРОСИТЬ'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------

interface ActionDef {
  key: string;
  label: string;
  className: string;
  disabled: boolean;
  confirm?: ConfirmKind;
  run: (reason: string, refund: boolean) => Promise<string>;
}

export function App(): JSX.Element {
  const [token, setTokenState] = useState<string | null>(() => readStoredToken());
  const tokenRef = useRef<string | null>(token);
  const setToken = useCallback((next: string | null) => {
    tokenRef.current = next;
    writeStoredToken(next);
    setTokenState(next);
  }, []);

  const api = useMemo(() => new ApiClient({ getToken: () => tokenRef.current }), []);

  const [gps, setGps] = useState<GpsState>(EMPTY_GPS);
  const [gpsStampAt, setGpsStampAt] = useState<number>(() => Date.now());
  const [waypoint, setWaypoint] = useState<AdminWaypointView | null>(null);
  const [settings, setSettings] = useState<ChannelSettings | null>(null);
  const [waypointsOpen, setWaypointsOpen] = useState<boolean | null>(null);
  const [slots, setSlots] = useState<AdminSlotsView>(EMPTY_SLOTS);
  const [quotes, setQuotes] = useState<AdminQuoteRow[]>([]);
  const [oauth, setOauth] = useState<AdminOAuthView>(EMPTY_OAUTH);

  const [baseline, setBaseline] = useState<{ id: string; meters: number } | null>(null);
  const [socketUp, setSocketUp] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ConfirmKind | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [now, setNow] = useState<number>(() => Date.now());

  const toastSeq = useRef(0);
  const refreshRef = useRef<(() => void) | null>(null);

  const pushToast = useCallback((kind: ToastKind, text: string) => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev.slice(-4), { id, kind, text }]);
    window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), TOAST_MS);
  }, []);

  const handleAuthError = useCallback(
    (err: unknown): boolean => {
      if (err instanceof ApiFailure && err.status === 401) {
        setToken(null);
        setSettings(null);
        setWaypoint(null);
        setQuotes([]);
        setSlots(EMPTY_SLOTS);
        setOauth(EMPTY_OAUTH);
        return true;
      }
      return false;
    },
    [setToken],
  );

  const applyGps = useCallback((next: GpsState) => {
    setGps(next);
    setGpsStampAt(Date.now());
  }, []);

  // --- clock ---------------------------------------------------------------
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  // --- OAuth return --------------------------------------------------------
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('connected') !== '1') return;
    pushToast('ok', 'Twitch подключён');
    params.delete('connected');
    const query = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
  }, [pushToast]);

  // --- poll (the reconciler) ----------------------------------------------
  useEffect(() => {
    if (!token) {
      refreshRef.current = null;
      return;
    }
    let alive = true;
    let inFlight = false;
    const controller = new AbortController();

    const tick = (): void => {
      if (!alive || inFlight) return;
      inFlight = true;
      void (async () => {
        try {
          const raw = await api.get<RawAdminState | null>('/api/admin/state', controller.signal);
          if (!alive) return;
          const state: RawAdminState = raw ?? {};
          applyGps(normalizeGps(state.gps));
          setWaypoint(state.activeWaypoint ?? null);
          const nextSettings = state.settings;
          if (nextSettings) {
            setSettings(nextSettings);
            setWaypointsOpen(nextSettings.waypointsOpen);
          }
          const rawSlots = state.slots;
          const rawItems = rawSlots?.items;
          setSlots({
            total: rawSlots?.total ?? 0,
            free: rawSlots?.free ?? 0,
            items: Array.isArray(rawItems) ? rawItems : null,
          });
          setQuotes(Array.isArray(state.quotes) ? state.quotes : []);
          const rawOauth = state.oauth;
          const rawScopes = rawOauth?.scopes;
          const rawTypes = rawOauth?.eventsub?.types;
          setOauth({
            connected: rawOauth?.connected === true,
            scopes: Array.isArray(rawScopes) ? rawScopes : [],
            expiresAt: typeof rawOauth?.expiresAt === 'number' ? rawOauth.expiresAt : null,
            eventsub: {
              count: rawOauth?.eventsub?.count ?? 0,
              types: Array.isArray(rawTypes) ? rawTypes : [],
            },
          });
          setPollError(null);
          setLastSyncAt(Date.now());
        } catch (err) {
          if (!alive || isAbort(err)) return;
          if (handleAuthError(err)) return;
          setPollError(errorText(err));
        } finally {
          inFlight = false;
        }
      })();
    };

    refreshRef.current = tick;
    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      refreshRef.current = null;
      window.clearInterval(id);
      controller.abort();
    };
  }, [token, api, applyGps, handleAuthError]);

  // --- socket (the fast path) ---------------------------------------------
  useEffect(() => {
    if (!token) return;
    const socket: Socket = connectSocket({ role: 'admin', token });
    const offs: Array<() => void> = [];

    const onConnect = (): void => setSocketUp(true);
    const onDisconnect = (): void => setSocketUp(false);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onDisconnect);

    offs.push(
      bind(socket, 'state:snapshot', (p) => {
        applyGps(isGpsState(p.gps) ? p.gps : { status: p.gps.status, sample: null, ageMs: p.gps.ageMs });
        setWaypoint(p.activeWaypoint ?? null);
        setWaypointsOpen(p.waypointsOpen);
        if (p.settings) {
          const patch = p.settings;
          setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
        }
      }),
    );
    offs.push(
      bind(socket, 'gps:update', (p) => {
        applyGps(isGpsState(p) ? p : { status: p.status, sample: null, ageMs: p.ageMs });
      }),
    );
    offs.push(
      bind(socket, 'gps:stale', (p) => {
        setGps((prev) => ({ ...prev, status: 'stale', ageMs: p.ageMs }));
        setGpsStampAt(Date.now());
      }),
    );
    offs.push(bind(socket, 'waypoint:activated', (p) => setWaypoint(p)));
    offs.push(
      bind(socket, 'route:update', (p) => {
        setWaypoint((prev) =>
          prev
            ? {
                ...prev,
                liveRouteGeometry: p.liveRouteGeometry,
                remainingDistanceMeters: p.remainingDistanceMeters,
                remainingDurationSeconds: p.remainingDurationSeconds,
              }
            : prev,
        );
      }),
    );
    offs.push(
      bind(socket, 'waypoint:completed', (p) => {
        setWaypoint(null);
        pushToast('ok', `Задание завершено: ${p.destinationName}`);
      }),
    );
    offs.push(
      bind(socket, 'waypoint:canceled', (p) => {
        setWaypoint(null);
        pushToast('info', `Задание отменено: ${p.reason || 'без причины'}`);
      }),
    );
    offs.push(
      bind(socket, 'waypoint:quoted', (p) =>
        pushToast('info', `Расчёт ${p.code}: ${p.destinationName} · ${p.cost}`),
      ),
    );
    offs.push(
      bind(socket, 'waypoint:awaiting_payment', (p) =>
        pushToast('info', `Ждём оплату ${p.code}: «${p.rewardTitle}» · ${p.cost}`),
      ),
    );
    offs.push(
      bind(socket, 'reward:redeemed', (p) => pushToast('ok', `Оплачено: ${p.userId} · ${p.cost}`)),
    );
    offs.push(
      bind(socket, 'reward:refunded', (p) =>
        pushToast('info', `Возврат: ${p.userId} · ${p.reason || 'без причины'}`),
      ),
    );
    offs.push(
      bind(socket, 'settings:update', (p) => {
        setSettings(p);
        setWaypointsOpen(p.waypointsOpen);
      }),
    );
    offs.push(
      bind(socket, 'slots:update', (p) =>
        setSlots((prev) => ({ ...prev, free: p.free, total: p.total })),
      ),
    );

    return () => {
      for (const off of offs) off();
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onDisconnect);
      socket.disconnect();
      setSocketUp(false);
    };
  }, [token, applyGps, pushToast]);

  // --- baseline distance for the progress bar ------------------------------
  useEffect(() => {
    if (!waypoint) {
      setBaseline(null);
      return;
    }
    const known = waypoint.totalDistanceMeters ?? waypoint.remainingDistanceMeters;
    if (known == null || !Number.isFinite(known)) return;
    setBaseline((prev) => {
      if (!prev || prev.id !== waypoint.id) return { id: waypoint.id, meters: known };
      return known > prev.meters ? { id: prev.id, meters: known } : prev;
    });
  }, [waypoint]);

  // --- actions -------------------------------------------------------------
  const runAction = useCallback(
    (key: string, fn: () => Promise<string>) => {
      if (pending) return;
      setPending(key);
      void (async () => {
        try {
          pushToast('ok', await fn());
        } catch (err) {
          if (handleAuthError(err)) pushToast('err', 'Сессия истекла, войдите заново');
          else pushToast('err', errorText(err));
        } finally {
          setPending(null);
          refreshRef.current?.();
        }
      })();
    },
    [pending, pushToast, handleAuthError],
  );

  const hasWaypoint = waypoint !== null;
  const actions: ActionDef[] = [
    {
      key: 'open',
      label: 'ОТКРЫТЬ ТОЧКИ',
      className: 'btn btn-primary',
      disabled: waypointsOpen === true,
      run: async () => {
        await api.post<{ ok: boolean }>('/api/admin/waypoints/open');
        setWaypointsOpen(true);
        return 'Приём точек открыт';
      },
    },
    {
      key: 'close',
      label: 'ЗАКРЫТЬ ТОЧКИ',
      className: 'btn',
      disabled: waypointsOpen === false,
      run: async () => {
        await api.post<{ ok: boolean }>('/api/admin/waypoints/close');
        setWaypointsOpen(false);
        return 'Приём точек закрыт';
      },
    },
    {
      key: 'complete',
      label: 'ЗАВЕРШИТЬ',
      className: 'btn',
      disabled: !hasWaypoint,
      run: async () => {
        await api.post<{ ok: boolean }>('/api/admin/waypoint/complete');
        setWaypoint(null);
        return 'Задание завершено';
      },
    },
    {
      key: 'cancel',
      label: 'ОТМЕНИТЬ',
      className: 'btn btn-danger',
      disabled: !hasWaypoint,
      confirm: 'cancel',
      run: async (reason, refund) => {
        const res = await api.post<{ ok: boolean; refunded?: boolean }>('/api/admin/waypoint/cancel', {
          reason: reason || 'Отменено стримером',
          refund,
        });
        setWaypoint(null);
        return res?.refunded ? 'Задание отменено, баллы возвращены' : 'Задание отменено';
      },
    },
    {
      key: 'clear',
      label: 'СБРОСИТЬ МАРШРУТ',
      className: 'btn btn-danger',
      disabled: false,
      confirm: 'clear',
      run: async () => {
        await api.post<{ ok: boolean }>('/api/admin/waypoint/clear');
        setWaypoint(null);
        return 'Маршрут сброшен';
      },
    },
    {
      key: 'slots',
      label: 'СИНХР. СЛОТЫ',
      className: 'btn',
      disabled: !oauth.connected,
      run: async () => {
        const res = await api.post<{ created?: number; updated?: number; total?: number }>(
          '/api/admin/slots/sync',
        );
        return `Слоты: создано ${res?.created ?? 0}, обновлено ${res?.updated ?? 0}, всего ${res?.total ?? 0}`;
      },
    },
    {
      key: 'eventsub',
      label: 'СИНХР. EVENTSUB',
      className: 'btn',
      disabled: !oauth.connected,
      run: async () => {
        const res = await api.post<{ subscriptions?: unknown }>('/api/admin/eventsub/sync');
        const subs = res?.subscriptions;
        const count = Array.isArray(subs) ? subs.length : typeof subs === 'number' ? subs : null;
        return count == null ? 'EventSub синхронизирован' : `EventSub: подписок ${count}`;
      },
    },
  ];

  const confirmAction = confirming ? actions.find((a) => a.confirm === confirming) ?? null : null;

  if (!token) return <LoginScreen onToken={setToken} />;

  const gpsAgeMs = gps.ageMs == null ? null : gps.ageMs + Math.max(0, now - gpsStampAt);
  const syncAgeS = lastSyncAt == null ? null : Math.max(0, Math.round((now - lastSyncAt) / 1000));
  const original =
    waypoint?.totalDistanceMeters ?? (baseline?.id === waypoint?.id ? (baseline?.meters ?? null) : null);

  return (
    <div className="ad-shell">
      <header className="ad-top">
        <div className="ad-brand">
          GTA PHUKET <span>LIVE ADMIN</span>
        </div>
        <div className="ad-chips">
          <span className={`ad-chip ${socketUp ? 'is-ok' : 'is-bad'}`}>
            <i className={`dot ${socketUp ? 'ok' : 'bad'}`} />
            сокет {socketUp ? 'онлайн' : 'офлайн'}
          </span>
          <span className={`ad-chip ${pollError ? 'is-bad' : ''}`}>
            <i className={`dot ${pollError ? 'bad' : 'ok'}`} />
            опрос <b className="num">{syncAgeS == null ? '—' : `${syncAgeS} с`}</b>
          </span>
          <span className={`ad-chip ${waypointsOpen ? 'is-accent' : 'is-dim'}`}>
            точки {waypointsOpen == null ? '—' : waypointsOpen ? 'открыты' : 'закрыты'}
          </span>
          <button className="ad-chip ad-chip-btn" type="button" onClick={() => setToken(null)}>
            ВЫЙТИ
          </button>
        </div>
      </header>

      <nav className="ad-actions">
        {actions.map((action) => (
          <button
            key={action.key}
            type="button"
            className={action.className}
            disabled={action.disabled || pending !== null}
            onClick={() =>
              action.confirm
                ? setConfirming(action.confirm)
                : runAction(action.key, () => action.run('', true))
            }
          >
            {pending === action.key ? '…' : action.label}
          </button>
        ))}
      </nav>

      {pollError ? <div className="ad-banner">Опрос состояния: {pollError}</div> : null}

      <main className="ad-main">
        <div className="ad-col">
          <StatusPanel
            gps={gps}
            gpsAgeMs={gpsAgeMs}
            gpsTimeoutSeconds={settings?.gpsTimeoutSeconds ?? null}
            maxGpsAccuracyMeters={settings?.maxGpsAccuracyMeters ?? null}
            waypoint={waypoint}
            originalDistanceMeters={original ?? null}
            originalIsObserved={waypoint?.totalDistanceMeters == null}
            slots={slots}
            quotes={quotes}
            oauth={oauth}
            now={now}
          />
        </div>
        <div className="ad-col">
          <SettingsPanel
            api={api}
            externalSettings={settings}
            onToast={pushToast}
            onAuthError={handleAuthError}
            onSaved={(next) => {
              setSettings(next);
              setWaypointsOpen(next.waypointsOpen);
              refreshRef.current?.();
            }}
          />
        </div>
      </main>

      {/* Full width: its two tables are wide, and it polls on its own cadence. */}
      <div className="ad-wide">
        <ExtDiagnosticsPanel api={api} onAuthError={handleAuthError} />
      </div>

      {confirming && confirmAction ? (
        <ConfirmDialog
          kind={confirming}
          busy={pending === confirmAction.key}
          onClose={() => setConfirming(null)}
          onConfirm={(reason, refund) => {
            setConfirming(null);
            runAction(confirmAction.key, () => confirmAction.run(reason, refund));
          }}
        />
      ) : null}

      <div className="ad-toasts">
        {toasts.map((toast) => (
          <div key={toast.id} className={`panel ad-toast is-${toast.kind}`}>
            {toast.text}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Twitch video-overlay extension.
 *
 * Collapsed it is invisible: a transparent hit area sitting exactly over the
 * minimap that OBS already burns into the video. Expanded it becomes the map,
 * the search and one destination card. The stream keeps playing underneath.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiClient, ApiFailure, viewerMessage } from '../shared/api';
import { bind, connectSocket } from '../shared/socket';
import { formatDistance } from '../shared/format';
import type {
  ActiveWaypointView,
  GpsState,
  LatLng,
  PublicGps,
  QuoteView,
  SearchResult,
  ViewerStatePayload,
} from '../shared/types';
import MapView, { parseExtConfig } from './MapView';
import type { ExtConfig, MapFocus, MapPick } from './MapView';
import DestinationCard from './DestinationCard';
import type { CardState } from './DestinationCard';
import SearchBox from './SearchBox';
import type { ExtAuth } from './twitch';
import { currentToken, extParams, isLinked, onAuthorized, onError as onExtError, requestIdShare } from './twitch';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function toPublicGps(payload: PublicGps | GpsState): PublicGps {
  if ('sample' in payload) {
    const sample = payload.sample;
    return {
      status: payload.status,
      lat: sample?.lat ?? null,
      lng: sample?.lng ?? null,
      heading: sample?.heading ?? null,
      speed: sample?.speed ?? null,
      ageMs: payload.ageMs,
    };
  }
  return payload;
}

function quoteOf(state: CardState): QuoteView | null {
  if (state.kind === 'quoted' || state.kind === 'confirming' || state.kind === 'awaiting') return state.quote;
  return null;
}

/** ~20 m — enough to tell "this activation is the point I just paid for". */
function sameSpot(a: LatLng, b: LatLng): boolean {
  return Math.abs(a.lat - b.lat) < 2e-4 && Math.abs(a.lng - b.lng) < 2e-4;
}

/**
 * `expiresAt` is a server timestamp, and a viewer's clock can be minutes out.
 * Every countdown and expiry check runs on server time reconstructed from the
 * offset the server reports, never on raw Date.now().
 */
let serverClockOffsetMs = 0;

function noteServerTime(serverTime: number | undefined): void {
  if (typeof serverTime === 'number' && Number.isFinite(serverTime)) {
    serverClockOffsetMs = serverTime - Date.now();
  }
}

function serverNow(): number {
  return Date.now() + serverClockOffsetMs;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => serverNow());
  useEffect(() => {
    if (!active) return;
    setNow(serverNow());
    const id = window.setInterval(() => setNow(serverNow()), 500);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

interface Banner {
  text: string;
  tone: 'warn' | 'bad';
}

// ---------------------------------------------------------------------------

export interface AppProps {
  /**
   * Forces the mobile layout. `mobile.html` sets it, because Twitch only adds
   * `?platform=mobile` inside its own app — opening that page in a desktop
   * browser to check it would otherwise render the overlay layout.
   */
  forceMobile?: boolean;
}

export default function App({ forceMobile = false }: AppProps = {}) {
  const [auth, setAuth] = useState<ExtAuth | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [config, setConfig] = useState<ExtConfig | null>(null);
  const [gps, setGps] = useState<PublicGps | null>(null);
  const [active, setActive] = useState<ActiveWaypointView | null>(null);
  const [waypointsOpen, setWaypointsOpen] = useState<boolean | null>(null);
  const [slots, setSlots] = useState<{ free: number; total: number } | null>(null);
  const [card, setCard] = useState<CardState>({ kind: 'idle' });
  const [expanded, setExpanded] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const [narrow, setNarrow] = useState(() => (typeof window === 'undefined' ? false : window.innerWidth < 640));

  const mobile = forceMobile || extParams.platform === 'mobile' || narrow;

  const api = useMemo(() => new ApiClient({ getToken: () => currentToken() }), []);

  const cardRef = useRef<CardState>(card);
  cardRef.current = card;
  const paidQuoteRef = useRef<string | null>(null);
  const pickSeqRef = useRef(0);

  // --- Twitch authorization -------------------------------------------------
  useEffect(() => {
    const offAuth = onAuthorized((next) => {
      setAuth(next);
      setAuthError(null);
    });
    const offError = onExtError((err) => setAuthError(viewerMessage(err)));
    return () => {
      offAuth();
      offError();
    };
  }, []);

  // --- viewport -------------------------------------------------------------
  useEffect(() => {
    const onResize = (): void => setNarrow(window.innerWidth < 640);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // --- config ---------------------------------------------------------------
  useEffect(() => {
    if (!auth) return;
    let alive = true;
    api
      .get<unknown>('/api/ext/config')
      .then((raw) => {
        if (alive) setConfig(parseExtConfig(raw));
      })
      .catch(() => {
        // Fall back to the build-time public token so the map still renders.
        if (alive) setConfig(parseExtConfig({}));
      });
    return () => {
      alive = false;
    };
  }, [auth, api]);

  // --- state ----------------------------------------------------------------
  const refresh = useCallback(() => {
    if (!currentToken()) return;
    api
      .get<ViewerStatePayload>('/api/ext/state')
      .then((next) => {
        noteServerTime(next.serverTime);
        setGps(next.gps);
        setActive(next.activeWaypoint);
        setWaypointsOpen(next.waypointsOpen);
        setSlots(next.slots);
        setAuthError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiFailure && err.code === 'unauthorized') setAuthError(viewerMessage(err));
      });
  }, [api]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!auth) return;
    refresh();
  }, [auth, refresh]);

  // Opening the overlay is a good moment to re-sync (the tab may have slept).
  useEffect(() => {
    if (expanded) refreshRef.current();
  }, [expanded]);

  // --- realtime -------------------------------------------------------------
  const channelId = auth?.channelId ?? config?.channelId ?? null;

  useEffect(() => {
    if (!channelId) return;
    const socket = connectSocket({ role: 'viewer', channelId });

    const resolveMine = (waypoint: ActiveWaypointView): boolean => {
      const mine = quoteOf(cardRef.current);
      if (!mine) return false;
      return paidQuoteRef.current === mine.quoteId || sameSpot(waypoint.destination, mine.destination);
    };

    const offs: Array<() => void> = [
      bind(socket, 'state:snapshot', (payload) => {
        noteServerTime(payload.serverTime);
        setGps(toPublicGps(payload.gps));
        setActive(payload.activeWaypoint);
        setWaypointsOpen(payload.waypointsOpen);
      }),
      bind(socket, 'gps:update', (payload) => setGps(toPublicGps(payload))),
      bind(socket, 'gps:stale', (payload) =>
        setGps((prev) => (prev ? { ...prev, status: 'stale', ageMs: payload.ageMs } : prev)),
      ),
      bind(socket, 'route:update', (payload) =>
        setActive((prev) =>
          prev
            ? {
                ...prev,
                liveRouteGeometry: payload.liveRouteGeometry,
                remainingDistanceMeters: payload.remainingDistanceMeters,
                remainingDurationSeconds: payload.remainingDurationSeconds,
              }
            : prev,
        ),
      ),
      bind(socket, 'reward:redeemed', (payload) => {
        const mine = quoteOf(cardRef.current);
        if (mine && mine.quoteId === payload.quoteId) paidQuoteRef.current = payload.quoteId;
      }),
      bind(socket, 'waypoint:awaiting_payment', (payload) => {
        const mine = quoteOf(cardRef.current);
        if (!mine || mine.quoteId !== payload.quoteId) return;
        setCard((prev) =>
          prev.kind === 'awaiting'
            ? { kind: 'awaiting', quote: { ...prev.quote, rewardTitle: payload.rewardTitle } }
            : prev,
        );
      }),
      bind(socket, 'waypoint:activated', (waypoint) => {
        setActive(waypoint);
        if (resolveMine(waypoint)) {
          paidQuoteRef.current = null;
          setCard({ kind: 'active', name: waypoint.destinationName });
        } else if (quoteOf(cardRef.current)) {
          setCard({ kind: 'error', message: 'Сейчас выполняется задание…', code: 'waypoint_active' });
        }
        refreshRef.current();
      }),
      bind(socket, 'waypoint:completed', (payload) => {
        setActive(null);
        if (cardRef.current.kind === 'active') setCard({ kind: 'completed', name: payload.destinationName });
        refreshRef.current();
      }),
      bind(socket, 'waypoint:canceled', (payload) => {
        setActive(null);
        const mine = quoteOf(cardRef.current);
        if (mine && payload.quoteId === mine.quoteId) {
          setCard({ kind: 'error', message: 'Точка отменена', code: null });
        }
        refreshRef.current();
      }),
      // A quote dying is not a waypoint dying: only clear our own card, and
      // never touch the running job.
      bind(socket, 'quote:canceled', (payload) => {
        const mine = quoteOf(cardRef.current);
        if (!mine || mine.quoteId !== payload.quoteId) return;
        setCard({
          kind: 'error',
          message:
            payload.reason === 'another viewer paid first'
              ? 'Кто-то оплатил раньше. Баллы возвращены'
              : 'Расчёт больше не действителен. Выбери точку заново',
          code: null,
        });
        refreshRef.current();
      }),
      bind(socket, 'slots:update', (payload) => setSlots(payload)),
    ];

    const onConnect = (): void => refreshRef.current();
    socket.on('connect', onConnect);

    return () => {
      for (const off of offs) off();
      socket.off('connect', onConnect);
      socket.disconnect();
    };
  }, [channelId]);

  // --- derived --------------------------------------------------------------
  const gpsDown = gps !== null && gps.status !== 'ok';
  const closed = waypointsOpen === false;
  const blockedMessage: string | null = closed
    ? 'Приём точек закрыт'
    : active
      ? 'Сейчас выполняется задание…'
      : gpsDown
        ? 'GPS временно недоступен'
        : null;

  const blockedRef = useRef(blockedMessage);
  blockedRef.current = blockedMessage;

  const quote = quoteOf(card);
  const routeGeometry = active ? active.liveRouteGeometry ?? active.routeGeometry : quote?.routeGeometry ?? null;
  const destination: LatLng | null = active ? active.destination : quote?.destination ?? null;

  const countdownRunning =
    card.kind === 'quoted' || card.kind === 'confirming' || card.kind === 'awaiting';
  const now = useNow(countdownRunning);

  // --- actions --------------------------------------------------------------
  const openMap = useCallback(() => {
    setMounted(true);
    setExpanded(true);
  }, []);

  const closeMap = useCallback(() => setExpanded(false), []);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  const handlePick = useCallback(
    (pick: MapPick) => {
      const blocked = blockedRef.current;
      if (blocked) {
        setCard({ kind: 'error', message: blocked, code: null });
        return;
      }
      if (!isLinked()) {
        const failure = new ApiFailure('needs_id_share', 'identity not shared', 403);
        setCard({ kind: 'error', message: viewerMessage(failure), code: 'needs_id_share' });
        return;
      }

      const seq = pickSeqRef.current + 1;
      pickSeqRef.current = seq;
      paidQuoteRef.current = null;
      setCard({ kind: 'loading', name: pick.name });

      api
        .post<QuoteView>('/api/ext/quote', {
          lat: pick.lat,
          lng: pick.lng,
          name: pick.name ?? undefined,
          category: pick.category ?? undefined,
        })
        .then((next) => {
          if (pickSeqRef.current !== seq) return;
          setCard({ kind: 'quoted', quote: next });
        })
        .catch((err: unknown) => {
          if (pickSeqRef.current !== seq) return;
          setCard({
            kind: 'error',
            message: viewerMessage(err),
            code: err instanceof ApiFailure ? err.code : null,
          });
        });
    },
    [api],
  );

  const handleSearchSelect = useCallback(
    (result: SearchResult) => {
      setFocus({ lat: result.lat, lng: result.lng, zoom: 16.4, nonce: Date.now() });
      handlePick({ lat: result.lat, lng: result.lng, name: result.name, category: result.category });
    },
    [handlePick],
  );

  const handleConfirm = useCallback(() => {
    const pending = quoteOf(cardRef.current);
    if (!pending) return;
    setCard({ kind: 'confirming', quote: pending });
    api
      .post<QuoteView>(`/api/ext/quote/${encodeURIComponent(pending.quoteId)}/confirm`)
      .then((next) => setCard({ kind: 'awaiting', quote: next }))
      .catch((err: unknown) =>
        setCard({
          kind: 'error',
          message: viewerMessage(err),
          code: err instanceof ApiFailure ? err.code : null,
        }),
      );
  }, [api]);

  const handleCancel = useCallback(() => {
    const pending = quoteOf(cardRef.current);
    setCard({ kind: 'idle' });
    paidQuoteRef.current = null;
    if (!pending) return;
    api.post<{ ok: true }>(`/api/ext/quote/${encodeURIComponent(pending.quoteId)}/cancel`).catch(() => {
      /* the quote expires on its own; nothing to show */
    });
  }, [api]);

  const handleClose = useCallback(() => {
    const pending = quoteOf(cardRef.current);
    if (pending && cardRef.current.kind === 'awaiting') {
      handleCancel();
      return;
    }
    setCard({ kind: 'idle' });
  }, [handleCancel]);

  // --- banners --------------------------------------------------------------
  const banners: Banner[] = [];
  if (authError) banners.push({ text: authError, tone: 'bad' });
  if (closed) banners.push({ text: 'Приём точек закрыт', tone: 'warn' });
  else if (gpsDown) banners.push({ text: 'GPS временно недоступен', tone: 'warn' });
  if (slots && slots.total > 0 && slots.free === 0)
    banners.push({ text: 'Все слоты наград заняты, подожди немного', tone: 'warn' });

  const remaining = active ? formatDistance(active.remainingDistanceMeters) : null;

  return (
    <div className="viewer" data-mobile={mobile ? 'true' : 'false'} data-expanded={expanded ? 'true' : 'false'}>
      {!expanded && !mobile && (
        <>
          {active && (
            <div className="taskPill" aria-live="polite">
              <span className="label">Задание</span>
              <span className="taskName">{active.destinationName}</span>
              {remaining && (
                <>
                  <span className="taskSep">·</span>
                  <span className="taskDist num">{remaining}</span>
                </>
              )}
            </div>
          )}
          <button type="button" className="hitArea" onClick={openMap} aria-label="Открыть карту">
            <span className="hitChip">Открыть карту</span>
          </button>
        </>
      )}

      {!expanded && mobile && (
        <div className="mobileBar panel">
          <div className="mobileBarText">
            <span className="label">{active ? 'Задание' : 'Waypoint'}</span>
            <span className="mobileBarName">
              {active ? active.destinationName : blockedMessage ?? 'Отправь стримера в точку'}
            </span>
          </div>
          <button type="button" className="btn btn-primary mobileBtn" onClick={openMap}>
            Карта
          </button>
        </div>
      )}

      {mounted && (
        <div className={expanded ? 'overlay is-open' : 'overlay'} aria-hidden={!expanded}>
          <div className="topBar">
            <button type="button" className="iconBtn" onClick={closeMap} aria-label="Закрыть карту">
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <path
                  d="M6 6l12 12M18 6 6 18"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  fill="none"
                />
              </svg>
            </button>
            <SearchBox api={api} enabled={auth !== null} onSelect={handleSearchSelect} />
          </div>

          {banners.length > 0 && (
            <div className="banners">
              {banners.map((banner) => (
                <div key={banner.text} className={`banner banner--${banner.tone}`}>
                  <span className={banner.tone === 'bad' ? 'dot bad' : 'dot warn'} />
                  {banner.text}
                </div>
              ))}
            </div>
          )}

          <div className="mapWrap">
            <MapView
              config={config}
              visible={expanded}
              player={gps}
              routeGeometry={routeGeometry}
              destination={destination}
              focus={focus}
              onPick={handlePick}
            />

            {card.kind === 'idle' && (
              <div className="hintPill">
                {active ? `Идёт задание: ${active.destinationName}` : 'Нажми на место на карте или найди его поиском'}
              </div>
            )}

            <div className="sheet">
              <DestinationCard
                state={card}
                now={now}
                blockedMessage={blockedMessage}
                onConfirm={handleConfirm}
                onCancel={handleCancel}
                onIdShare={requestIdShare}
                onClose={handleClose}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

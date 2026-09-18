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
  EconomyInfo,
  GpsState,
  LatLng,
  PaymentMode,
  PublicGps,
  QuoteView,
  SearchResult,
  ViewerStatePayload,
  WalletView,
} from '../shared/types';
import MapView, { parseExtConfig } from './MapView';
import type { ExtConfig, MapFocus, MapPick } from './MapView';
import DestinationCard, { isGtaQuote } from './DestinationCard';
import type { CardState } from './DestinationCard';
import SearchBox from './SearchBox';
import { TopUpDialog, WalletChip, WalletToast } from './Wallet';
import type { WalletCredit, WalletLoad } from './Wallet';
import { walletIdentity } from './identity';
import type { ExtAuth } from './twitch';
import {
  currentToken,
  diagnostics,
  extParams,
  isLinked,
  logDiagnostics,
  markDomMounted,
  onAuthorized,
  onDiagnostics,
  onError as onExtError,
  onHighlightChanged,
  onVisibilityChanged,
  requestIdShare,
  type ExtDiagnostics,
} from './twitch';
import {
  diagEvent,
  diagPageOnScreen,
  isSmokeTest,
  measureTrigger,
  setDiagSnap,
  triggerMoved,
  type TriggerInfo,
} from './diag';

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
  if (
    state.kind === 'quoted' ||
    state.kind === 'confirming' ||
    state.kind === 'awaiting' ||
    state.kind === 'purchasing'
  ) {
    return state.quote;
  }
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

/** How long a credit or refund toast stays up. */
const WALLET_TOAST_MS = 5000;

/** The top-up dialog: closed, open, or open and showing a credit that just landed. */
type TopUpState = { credit: WalletCredit | null } | null;

/** `POST /api/ext/waypoints/purchase` → 200. */
interface PurchaseResponse {
  ok: true;
  /** False on an idempotent repeat: the same waypoint, no second charge. */
  charged: boolean;
  waypoint: ActiveWaypointView;
  /**
   * Where that waypoint stands now. A repeat can arrive after the job has
   * already ended; absent from an older server, which means ACTIVE.
   */
  waypointStatus?: 'ACTIVE' | 'COMPLETED' | 'CANCELED';
  balance: number;
  cost: number;
}

// ---------------------------------------------------------------------------

/**
 * Both are build-time flags and both must be off for review: the badge and the
 * smoke button exist to answer "did the extension load at all", which is not a
 * question a viewer should ever see being asked.
 *
 * With SMOKE_TEST the smoke button is not React's: it is raw markup in
 * video_overlay.html (`#gtamap-raw-trigger`, see twitchPages() in
 * vite.config.ts), on screen before any script of ours runs. The app only
 * adopts it and turns it into a second way into the map.
 */
const DIAG_BADGE = (import.meta.env.VITE_DEV_MODE as string | undefined) === 'true';
const SMOKE_TEST = isSmokeTest();

/** When the trigger is measured again after mount, in ms. */
const TRIGGER_RECHECK_MS = [1000, 3000, 10000, 30000];

/**
 * A Twitch extension iframe can report a width of 0 before the player has laid
 * it out. Treating that as "narrow" used to flip the overlay into the mobile
 * layout, whose bar sits at the bottom of the frame — underneath the Twitch
 * player controls, where nobody ever saw it. Zero means "not measured yet",
 * not "phone".
 */
function isNarrowViewport(): boolean {
  if (typeof window === 'undefined') return false;
  const width = window.innerWidth;
  return width > 0 && width < 640;
}

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
  const [narrow, setNarrow] = useState(() => isNarrowViewport());

  // GTA$ economy. The balance lives in memory only, never in localStorage, and
  // is always whatever GET /api/ext/wallet answered last.
  const [paymentMode, setPaymentMode] = useState<PaymentMode | null>(null);
  const [economy, setEconomy] = useState<EconomyInfo | null>(null);
  const [wallet, setWallet] = useState<WalletView | null>(null);
  const [walletLoad, setWalletLoad] = useState<WalletLoad>('idle');
  const [topUp, setTopUp] = useState<TopUpState>(null);
  const [toast, setToast] = useState<WalletCredit | null>(null);

  const mobile = forceMobile || extParams.platform === 'mobile' || narrow;

  // Twitch highlights the extension while the viewer hovers its icon. The
  // trigger gets louder for that moment — it does not depend on it.
  const [highlighted, setHighlighted] = useState(false);
  const [diag, setDiag] = useState<ExtDiagnostics>(() => diagnostics());

  useEffect(() => {
    // Proof that React actually mounted inside the Twitch iframe. Everything
    // else in this component can fail; this cannot.
    markDomMounted();
    logDiagnostics('overlay mounted');
    const offHighlight = onHighlightChanged(setHighlighted);
    const offDiag = onDiagnostics(setDiag);
    return () => {
      offHighlight();
      offDiag();
    };
  }, []);

  const api = useMemo(() => new ApiClient({ getToken: () => currentToken() }), []);

  const cardRef = useRef<CardState>(card);
  cardRef.current = card;
  const paidQuoteRef = useRef<string | null>(null);
  const pickSeqRef = useRef(0);
  const lastPickRef = useRef<MapPick | null>(null);
  const purchasingRef = useRef(false);

  // Twitch rotates the token for the same viewer every so often; the identity
  // key only changes when the viewer does — typically right after
  // requestIdShare — and that is what the wallet and the socket follow.
  const identity = useMemo(() => walletIdentity(auth), [auth]);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const paymentModeRef = useRef(paymentMode);
  paymentModeRef.current = paymentMode;
  const topUpOpenRef = useRef(false);
  topUpOpenRef.current = topUp !== null;

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
    const onResize = (): void => setNarrow(isNarrowViewport());
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
        setPaymentMode(next.paymentMode ?? null);
        setEconomy(next.economy ?? null);
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

  // --- GTA$ wallet ----------------------------------------------------------
  const walletSeqRef = useRef(0);
  const announcedRef = useRef<Set<string>>(new Set());

  /**
   * The only way a balance reaches the screen. Realtime events, a purchase, a
   * reconnect and an identity change all end up here; none of them sets a
   * balance on its own. Resolves with what the server said (null on failure)
   * even when a newer read has since overtaken it.
   */
  const loadWallet = useCallback((): Promise<WalletView | null> => {
    const seq = walletSeqRef.current + 1;
    walletSeqRef.current = seq;
    if (identityRef.current.kind !== 'linked' || !currentToken()) return Promise.resolve(null);
    setWalletLoad((prev) => (prev === 'ready' ? prev : 'loading'));
    return api.get<WalletView>('/api/ext/wallet').then(
      (next) => {
        if (walletSeqRef.current === seq) {
          setWallet(next);
          setWalletLoad('ready');
        }
        return next;
      },
      (err: unknown) => {
        if (walletSeqRef.current === seq) {
          const code = err instanceof ApiFailure ? err.code : null;
          if (code === 'needs_id_share' || code === 'needs_login') {
            // The server read the token differently than we did. It wins.
            setWallet(null);
            setWalletLoad(code);
          } else {
            // A blip: keep showing the last balance the server confirmed.
            setWalletLoad((prev) => (prev === 'ready' ? prev : 'error'));
          }
        }
        return null;
      },
    );
  }, [api]);

  const loadWalletRef = useRef(loadWallet);
  loadWalletRef.current = loadWallet;

  // On mount and whenever the viewer behind the token changes: forget
  // everything that belonged to the previous one before reading again, so one
  // viewer's balance can never be shown to another.
  useEffect(() => {
    walletSeqRef.current += 1;
    setWallet(null);
    setToast(null);
    setTopUp((prev) => (prev ? { credit: null } : prev));
    if (identity.kind === 'linked') {
      setWalletLoad('loading');
      void loadWalletRef.current();
      // The share prompt was answered; the card that asked for it is done.
      setCard((prev) =>
        prev.kind === 'error' && (prev.code === 'needs_id_share' || prev.code === 'needs_login')
          ? { kind: 'idle' }
          : prev,
      );
    } else if (identity.kind === 'anonymous') {
      setWalletLoad('needs_login');
    } else if (identity.kind === 'unlinked') {
      setWalletLoad('needs_id_share');
    } else {
      setWalletLoad('idle');
    }
  }, [identity.key, identity.kind]);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), WALLET_TOAST_MS);
    return () => window.clearTimeout(id);
  }, [toast]);

  /**
   * An exchange credit lands in the open top-up dialog, which is where the
   * viewer is waiting for it; anything else, or a credit with the dialog
   * closed, becomes a short toast.
   */
  const announceCredit = useCallback((credit: WalletCredit) => {
    // One notice per ledger row, however many times the signal arrives.
    if (announcedRef.current.has(credit.transactionId)) return;
    announcedRef.current.add(credit.transactionId);
    if (paymentModeRef.current !== 'gta_dollar') return;
    if (credit.type === 'EXCHANGE_CREDIT' && topUpOpenRef.current && expandedRef.current) {
      setTopUp({ credit });
      return;
    }
    setToast(credit);
  }, []);

  // Opening the overlay is a good moment to re-sync (the tab may have slept).
  useEffect(() => {
    if (!expanded) return;
    refreshRef.current();
    void loadWalletRef.current();
  }, [expanded]);

  // --- realtime -------------------------------------------------------------
  const channelId = auth?.channelId ?? config?.channelId ?? null;

  useEffect(() => {
    if (!channelId) return;
    // The token is read on every (re)connect, so a rotated JWT is what the
    // server sees. A different viewer reconnects outright (identity.key in the
    // deps), because the server only puts a verified, linked viewer into their
    // wallet room at handshake time.
    const socket = connectSocket({ role: 'viewer', channelId, token: () => currentToken() });

    const resolveMine = (waypoint: ActiveWaypointView): boolean => {
      const mine = quoteOf(cardRef.current);
      if (!mine) return false;
      // A GTA$ quote only becomes a waypoint through our own purchase request,
      // and its response says so. A waypoint at the same spot is someone else's.
      if (isGtaQuote(mine, paymentModeRef.current)) return false;
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
        const current = cardRef.current;
        if (current.kind === 'purchasing' || (current.kind === 'quoted' && current.unsure)) {
          // Ours or somebody else's: only the purchase endpoint knows — its
          // response is on its way, or one more press of the button asks it.
        } else if (resolveMine(waypoint)) {
          paidQuoteRef.current = null;
          setCard({ kind: 'active', name: waypoint.destinationName, waypointId: waypoint.id });
        } else if (quoteOf(cardRef.current)) {
          setCard({ kind: 'error', message: 'Сейчас выполняется задание…', code: 'waypoint_active' });
        }
        refreshRef.current();
      }),
      bind(socket, 'waypoint:completed', (payload) => {
        setActive(null);
        const current = cardRef.current;
        const mine = quoteOf(current);
        // Also a quote whose purchase went unanswered: it was ours after all,
        // and it is over, so there is nothing left to press again for.
        if (current.kind === 'active' || (mine && mine.quoteId === payload.quoteId)) {
          setCard({ kind: 'completed', name: payload.destinationName });
        }
        refreshRef.current();
      }),
      bind(socket, 'waypoint:canceled', (payload) => {
        setActive(null);
        const current = cardRef.current;
        const mine = quoteOf(current);
        if (mine && payload.quoteId === mine.quoteId) {
          setCard({ kind: 'error', message: 'Точка отменена', code: null });
        } else if (current.kind === 'active' && current.waypointId === payload.id) {
          // A GTA$ refund, if there is one, arrives as its own wallet:updated.
          setCard({ kind: 'error', message: 'Задание отменено', code: null });
        }
        refreshRef.current();
      }),
      // A quote dying is not a waypoint dying: only clear our own card, and
      // never touch the running job.
      bind(socket, 'quote:canceled', (payload) => {
        const current = cardRef.current;
        const mine = quoteOf(current);
        if (!mine || mine.quoteId !== payload.quoteId) return;
        // Mid-purchase, the purchase response says exactly what happened.
        if (current.kind === 'purchasing') return;
        const lostRace = payload.reason === 'another viewer paid first';
        setCard({
          kind: 'error',
          message: lostRace
            ? isGtaQuote(mine, paymentModeRef.current)
              ? 'Кто-то оплатил раньше. GTA$ не списаны'
              : 'Кто-то оплатил раньше. Баллы возвращены'
            : 'Расчёт больше не действителен. Выбери точку заново',
          code: null,
        });
        refreshRef.current();
      }),
      bind(socket, 'slots:update', (payload) => setSlots(payload)),
      // A signal, not a value: re-read the wallet and announce what the
      // server says now.
      bind(socket, 'wallet:updated', (payload) => {
        const key = identityRef.current.key;
        void loadWalletRef.current().then((fresh) => {
          if (identityRef.current.key !== key) return;
          if (payload.type !== 'EXCHANGE_CREDIT' && payload.type !== 'MISSION_REFUND') return;
          const row = fresh?.recent.find((tx) => tx.id === payload.transactionId);
          announceCredit({
            transactionId: payload.transactionId,
            type: payload.type,
            amount: row?.amount ?? payload.amount,
            balance: fresh?.balance ?? payload.balance,
          });
        });
      }),
    ];

    // A reconnect may have missed a wallet:updated; the first connect follows
    // a wallet read that the identity effect has already started.
    let connectedBefore = false;
    const onConnect = (): void => {
      refreshRef.current();
      if (connectedBefore) void loadWalletRef.current();
      connectedBefore = true;
    };
    socket.on('connect', onConnect);

    return () => {
      for (const off of offs) off();
      socket.off('connect', onConnect);
      socket.disconnect();
    };
  }, [channelId, identity.key, announceCredit]);

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
    card.kind === 'quoted' || card.kind === 'confirming' || card.kind === 'awaiting' || card.kind === 'purchasing';
  const now = useNow(countdownRunning);

  const gtaMode = paymentMode === 'gta_dollar';

  // --- actions --------------------------------------------------------------
  const openMapVia = useCallback((via: 'react' | 'raw') => {
    setMounted(true);
    setExpanded(true);
    diagEvent('map_opened', { via });
  }, []);

  const openMap = useCallback(() => openMapVia('react'), [openMapVia]);

  const closeMap = useCallback(() => {
    setExpanded(false);
    setTopUp(null);
  }, []);

  const openTopUp = useCallback(() => setTopUp({ credit: null }), []);
  const closeTopUp = useCallback(() => setTopUp(null), []);

  // --- trigger diagnostics --------------------------------------------------
  // Nobody can look at a viewer's player, so the app measures the button this
  // layout actually rendered and tells the backend: once after mount
  // (trigger_rendered), then only when it appears, disappears, moves or
  // resizes (trigger_check) — plus once more the first time the page is
  // actually on screen, because the backend only trusts a measurement taken
  // then, and a page opened in a background tab has not had one.
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const reportedTriggerRef = useRef<TriggerInfo | null>(null);
  const reportedOnScreenRef = useRef(false);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  const checkTrigger = useCallback(() => {
    // While the map is open the trigger is gone on purpose; that is not a fault.
    if (expandedRef.current) return;
    const info = measureTrigger(triggerRef.current, 'react');
    setDiagSnap({ triggerVisible: info.visible });
    const firstOnScreen = !reportedOnScreenRef.current && diagPageOnScreen();
    if (firstOnScreen) reportedOnScreenRef.current = true;
    const reported = reportedTriggerRef.current;
    if (!reported) {
      reportedTriggerRef.current = info;
      diagEvent('trigger_rendered', { trigger: info });
    } else if (firstOnScreen || triggerMoved(reported, info)) {
      reportedTriggerRef.current = info;
      diagEvent('trigger_check', { trigger: info });
    }
  }, []);

  // After mount, after the map closes, and whenever the layout swaps buttons.
  useEffect(() => {
    if (!expanded) checkTrigger();
  }, [expanded, mobile, checkTrigger]);

  useEffect(() => {
    const timers = TRIGGER_RECHECK_MS.map((ms) => window.setTimeout(checkTrigger, ms));
    // Resizes, Twitch hiding/showing the extension, and the tab coming to the
    // front: measure once React has re-rendered and the frame has settled,
    // not in the middle of it.
    let settle = 0;
    const recheck = (): void => {
      window.clearTimeout(settle);
      settle = window.setTimeout(checkTrigger, 150);
    };
    window.addEventListener('resize', recheck);
    document.addEventListener('visibilitychange', recheck);
    const offVisibility = onVisibilityChanged(recheck);
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
      window.clearTimeout(settle);
      window.removeEventListener('resize', recheck);
      document.removeEventListener('visibilitychange', recheck);
      offVisibility();
    };
  }, [checkTrigger]);

  // --- SMOKE_TEST raw button ------------------------------------------------
  // Adopt the raw HTML button instead of rendering one: if it was visible and
  // stops being the map button, the app broke it; if it never showed at all,
  // Twitch never showed the iframe. Idempotent, because StrictMode runs this
  // twice in dev and the element outlives React.
  const rawUpgradedRef = useRef(false);

  useEffect(() => {
    if (!SMOKE_TEST) return;
    const raw = document.getElementById('gtamap-raw-trigger');
    if (!raw) return;
    raw.textContent = '🗺 КАРТА';
    raw.dataset.state = 'react';
    raw.setAttribute('aria-label', 'Открыть карту Пхукета');
    // viewer.css makes the whole page click-through; gtamap-raw.css (or the
    // boot script's fallback) restores clicks on this button. Restated here,
    // through CSSOM, so a map button can never be one that clicks fall through.
    raw.style.pointerEvents = 'auto';
    const onRawClick = (): void => openMapVia('raw');
    raw.addEventListener('click', onRawClick);
    if (!rawUpgradedRef.current) {
      rawUpgradedRef.current = true;
      diagEvent('raw_button_upgraded', { trigger: measureTrigger(raw, 'raw') });
    }
    return () => raw.removeEventListener('click', onRawClick);
  }, [openMapVia]);

  useEffect(() => {
    if (!SMOKE_TEST) return;
    const raw = document.getElementById('gtamap-raw-trigger');
    if (raw) raw.hidden = expanded;
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      // The top-up dialog is the innermost layer, so it goes first.
      if (topUpOpenRef.current) setTopUp(null);
      else setExpanded(false);
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
        // Sharing an identity is something an anonymous viewer cannot do yet.
        const code =
          identityRef.current.kind === 'anonymous' && paymentModeRef.current === 'gta_dollar'
            ? 'needs_login'
            : 'needs_id_share';
        const failure = new ApiFailure(code, 'identity not shared', 403);
        setCard({ kind: 'error', message: viewerMessage(failure), code });
        return;
      }

      const seq = pickSeqRef.current + 1;
      pickSeqRef.current = seq;
      paidQuoteRef.current = null;
      lastPickRef.current = pick;
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

  /**
   * One click, one request. The button is disabled for as long as it is in
   * flight (and the ref catches a double click before React re-renders); the
   * server is idempotent per quote anyway, which is what makes "press it
   * again" a safe answer when the response never arrives.
   */
  const handlePurchase = useCallback(() => {
    const pending = quoteOf(cardRef.current);
    if (!pending || purchasingRef.current) return;
    const wasUnsure = cardRef.current.kind === 'quoted' && cardRef.current.unsure === true;
    purchasingRef.current = true;
    setCard({ kind: 'purchasing', quote: pending });

    const stillMine = (): boolean => {
      const current = cardRef.current;
      return current.kind === 'purchasing' && current.quote.quoteId === pending.quoteId;
    };

    api
      .post<PurchaseResponse>('/api/ext/waypoints/purchase', { quoteId: pending.quoteId })
      .then((result) => {
        // A press after an unanswered one can come back once the job it
        // bought is already over: say how it ended, never show it as running.
        // Nothing new happened, so a card the viewer has moved on from stays.
        if (result.waypointStatus === 'COMPLETED' || result.waypointStatus === 'CANCELED') {
          if (!stillMine()) return;
          setCard(
            result.waypointStatus === 'COMPLETED'
              ? { kind: 'completed', name: result.waypoint.destinationName }
              : { kind: 'error', message: 'Задание отменено', code: null },
          );
          return;
        }
        // Bought is bought, even if the viewer has closed the card meanwhile.
        setActive(result.waypoint);
        setCard({
          kind: 'active',
          name: result.waypoint.destinationName,
          waypointId: result.waypoint.id,
          paid: result.cost,
        });
      })
      .catch((err: unknown) => {
        if (!stillMine()) return;
        if (!(err instanceof ApiFailure) || err.status >= 500) {
          // No verdict: it may or may not have gone through. Same quote again
          // is safe — the server charges one quote once, and answers a repeat
          // of a purchase that did go through with that same waypoint.
          setCard({
            kind: 'quoted',
            quote: pending,
            notice: 'Нет ответа от сервера. Нажмите ещё раз — GTA$ спишутся только один раз',
            unsure: true,
          });
          return;
        }
        if (err.code === 'insufficient_funds') {
          // A verdict: nothing was charged for this quote (a repeat of one that
          // was would have been answered with its waypoint). Back to the quote,
          // which with the re-read balance shows the shortfall and the top-up.
          setCard({ kind: 'quoted', quote: pending, notice: viewerMessage(err) });
          return;
        }
        if (err.code === 'rate_limited') {
          // Not even looked at: the quote stands exactly as it did before.
          setCard({ kind: 'quoted', quote: pending, notice: viewerMessage(err), unsure: wasUnsure });
          return;
        }
        setCard({ kind: 'error', message: viewerMessage(err), code: err.code });
      })
      .finally(() => {
        purchasingRef.current = false;
        void loadWalletRef.current();
        refreshRef.current();
      });
  }, [api]);

  /**
   * After `price_changed`, `payment_mode` or `quote_expired`: the same place,
   * a fresh quote at today's price and in today's currency.
   */
  const handleRequote = useCallback(() => {
    const pick = lastPickRef.current;
    if (pick) handlePick(pick);
    else setCard({ kind: 'idle' });
  }, [handlePick]);

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
  // The map still opens and still shows Phuket without a GPS fix; only buying
  // is blocked, so this says what is missing rather than hiding the map.
  else if (gpsDown) banners.push({ text: 'GPS стримера временно недоступен', tone: 'warn' });
  // Slots are the legacy Channel Points mechanism; GTA$ purchases never use one.
  if (!gtaMode && slots && slots.total > 0 && slots.free === 0)
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

          {/*
            Unconditional. No GPS, no backend, no identity, no active waypoint,
            no onAuthorized — none of it may hide the way into the map. Those
            states stop a viewer from *buying* a waypoint, which is a different
            thing, and they are explained inside the map once it is open.
          */}
          <button
            ref={triggerRef}
            type="button"
            className="mapTrigger"
            data-highlighted={highlighted ? 'true' : 'false'}
            onClick={openMap}
            aria-label="Открыть карту Пхукета"
          >
            <span className="mapTriggerIcon" aria-hidden="true">🗺</span>
            <span className="mapTriggerText">Карта</span>
          </button>

          {DIAG_BADGE && (
            <div className="diagBadge" role="status">
              <span className="diagBadgeTitle">GTAMAP EXTENSION LOADED</span>
              <span className="diagBadgeLine">
                mount {diag.domMounted ? 'ok' : '—'} · helper {diag.helperLoaded ? 'ok' : '—'} ·
                auth {diag.authorized ? 'ok' : '—'}
              </span>
              <span className="diagBadgeLine">
                ch {diag.channelId ?? '—'} · {diag.viewerKind} · {diag.platform}
                {diag.anchor ? ` · ${diag.anchor}` : ''}
              </span>
              <span className="diagBadgeLine">
                vis {diag.visible ? 'on' : 'off'} · hl {diag.highlighted ? 'on' : 'off'}
                {diag.devFallback ? ' · dev-fallback' : ''}
              </span>
              {diag.lastError && <span className="diagBadgeErr">{diag.lastError}</span>}
            </div>
          )}
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
          <button ref={triggerRef} type="button" className="btn btn-primary mobileBtn" onClick={openMap}>
            Карта
          </button>
        </div>
      )}

      {/* A credit that lands while the map is shut. Click-through, and clear of the trigger. */}
      {!expanded && gtaMode && toast && <WalletToast credit={toast} placement="collapsed" />}

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

            {gtaMode && (
              <div className="walletDock">
                <WalletChip
                  load={walletLoad}
                  balance={wallet?.balance ?? null}
                  onTopUp={openTopUp}
                  onIdShare={requestIdShare}
                />
                {topUp && (
                  <TopUpDialog offer={economy ?? wallet?.exchange ?? null} credit={topUp.credit} onClose={closeTopUp} />
                )}
                {toast && <WalletToast credit={toast} placement="map" />}
              </div>
            )}

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
                paymentMode={paymentMode}
                wallet={{ load: walletLoad, balance: wallet?.balance ?? null }}
                onConfirm={handleConfirm}
                onPurchase={handlePurchase}
                onTopUp={openTopUp}
                onRequote={handleRequote}
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

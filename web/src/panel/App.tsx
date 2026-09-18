import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ApiClient, ApiFailure, viewerMessage } from '../shared/api';
import { bind, connectSocket } from '../shared/socket';
import { formatApproxDuration, formatGta, formatKm } from '../shared/format';
import type {
  EconomyInfo,
  LastWaypointView,
  PublicGps,
  QuoteView,
  SearchResult,
  ViewerStatePayload,
  WalletView,
} from '../shared/types';
import MapView, { parseExtConfig, type ExtConfig, type MapFocus, type MapPick } from '../viewer/MapView';
import SearchBox from '../viewer/SearchBox';
import {
  LINK_PROMPT,
  LOGIN_PROMPT,
  TopUpDialog,
  WalletChip,
  WalletToast,
  type ExchangeOffer,
  type WalletCredit,
  type WalletLoad,
} from '../viewer/Wallet';
import { walletIdentity } from '../viewer/identity';
import { currentToken, onAuthorized, requestIdShare, type ExtAuth } from '../viewer/twitch';
import { useLiveStatus, type LiveStatus } from './useLiveStatus';

/**
 * IRL Waypoint — Panel.
 *
 * The same backend, Twitch identity and GTA$ wallet as the video overlay, on
 * the channel page, where it is also there while the channel is offline:
 * balance, identity link, top-up instructions, the map of Phuket with the
 * streamer's last known position, the last waypoint, and prices.
 *
 * It never sells. A waypoint is bought on the stream, in the video overlay;
 * here the main button is either disabled ("СТРИМЕР СЕЙЧАС ОФЛАЙН") or points
 * at the overlay ("ОТКРЫТЬ КАРТУ НА СТРИМЕ"). A quote only prices a place —
 * nothing is charged by asking.
 */

const WALLET_TOAST_MS = 5000;

type Card =
  | { kind: 'idle' }
  | { kind: 'loading'; name: string | null }
  | { kind: 'error'; message: string }
  | { kind: 'quoted'; quote: QuoteView };

const LIVE_LABEL: Record<LiveStatus, string> = {
  live: 'В ЭФИРЕ',
  offline: 'СТРИМЕР ОФЛАЙН',
  unknown: 'ПРОВЕРЯЕМ ЭФИР…',
};

const LAST_STATUS: Record<LastWaypointView['status'], string> = {
  ACTIVE: 'выполняется',
  COMPLETED: 'стример дошёл',
  CANCELED: 'отменена',
};

function when(ms: number | null, now: number): string {
  if (ms == null) return '';
  const minutes = Math.max(0, Math.round((now - ms) / 60_000));
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return new Date(ms).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

export default function App() {
  const [auth, setAuth] = useState<ExtAuth | null>(null);
  const [config, setConfig] = useState<ExtConfig | null>(null);
  const [state, setState] = useState<ViewerStatePayload | null>(null);
  const [wallet, setWallet] = useState<WalletView | null>(null);
  const [walletLoad, setWalletLoad] = useState<WalletLoad>('idle');
  const [topUp, setTopUp] = useState<{ credit: WalletCredit | null } | null>(null);
  const [toast, setToast] = useState<WalletCredit | null>(null);
  const [card, setCard] = useState<Card>({ kind: 'idle' });
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const [hint, setHint] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const live = useLiveStatus(auth);
  const identity = useMemo(() => walletIdentity(auth), [auth]);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const walletSeqRef = useRef(0);
  const pickSeqRef = useRef(0);
  const announcedRef = useRef(new Set<string>());
  const topUpOpenRef = useRef(false);
  topUpOpenRef.current = topUp !== null;

  const api = useMemo(() => new ApiClient({ getToken: () => currentToken() }), []);

  useEffect(() => onAuthorized((next) => setAuth({ ...next })), []);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // --- config and state ------------------------------------------------------
  useEffect(() => {
    if (!auth) return;
    let alive = true;
    api
      .get<unknown>('/api/ext/config')
      .then((raw) => alive && setConfig(parseExtConfig(raw)))
      .catch(() => alive && setConfig(parseExtConfig({})));
    return () => {
      alive = false;
    };
  }, [auth, api]);

  const refresh = useCallback(() => {
    if (!currentToken()) return;
    api
      .get<ViewerStatePayload>('/api/ext/state')
      .then(setState)
      .catch(() => undefined);
  }, [api]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (auth) refresh();
  }, [auth, refresh]);

  // --- wallet ----------------------------------------------------------------
  const loadWallet = useCallback((): Promise<WalletView | null> => {
    const seq = ++walletSeqRef.current;
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
            setWallet(null);
            setWalletLoad(code);
          } else {
            setWalletLoad((prev) => (prev === 'ready' ? prev : 'error'));
          }
        }
        return null;
      },
    );
  }, [api]);
  const loadWalletRef = useRef(loadWallet);
  loadWalletRef.current = loadWallet;

  // A different viewer behind the token: forget the previous one first.
  useEffect(() => {
    walletSeqRef.current += 1;
    setWallet(null);
    setToast(null);
    if (identity.kind === 'linked') {
      setWalletLoad('loading');
      void loadWalletRef.current();
      setCard((prev) => (prev.kind === 'error' ? { kind: 'idle' } : prev));
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

  // --- realtime: wallet signals and waypoint changes -------------------------
  const channelId = auth?.channelId ?? null;
  useEffect(() => {
    if (!channelId) return;
    const socket = connectSocket({ role: 'viewer', channelId, token: () => currentToken() });
    const offs = [
      bind(socket, 'wallet:updated', (payload) => {
        const key = identityRef.current.key;
        void loadWalletRef.current().then((fresh) => {
          if (identityRef.current.key !== key) return;
          if (payload.type !== 'EXCHANGE_CREDIT' && payload.type !== 'MISSION_REFUND') return;
          if (announcedRef.current.has(payload.transactionId)) return;
          announcedRef.current.add(payload.transactionId);
          const row = fresh?.recent.find((tx) => tx.id === payload.transactionId);
          const credit: WalletCredit = {
            transactionId: payload.transactionId,
            type: payload.type,
            amount: row?.amount ?? payload.amount,
            balance: fresh?.balance ?? payload.balance,
          };
          if (credit.type === 'EXCHANGE_CREDIT' && topUpOpenRef.current) setTopUp({ credit });
          setToast(credit);
        });
      }),
      bind(socket, 'waypoint:activated', () => refreshRef.current()),
      bind(socket, 'waypoint:completed', () => refreshRef.current()),
      bind(socket, 'waypoint:canceled', () => refreshRef.current()),
    ];
    const onConnect = (): void => {
      refreshRef.current();
      void loadWalletRef.current();
    };
    socket.on('connect', onConnect);
    return () => {
      offs.forEach((off) => off());
      socket.off('connect', onConnect);
      socket.disconnect();
    };
  }, [channelId, identity.key]);

  // --- picking a place: price only, never a purchase -------------------------
  const handlePick = useCallback(
    (pick: MapPick) => {
      setHint(false);
      const kind = identityRef.current.kind;
      if (kind !== 'linked') {
        setCard({
          kind: 'error',
          message:
            kind === 'anonymous'
              ? LOGIN_PROMPT
              : kind === 'unlinked'
                ? LINK_PROMPT
                : 'Twitch ещё подключается. Попробуйте через пару секунд.',
        });
        return;
      }
      const seq = ++pickSeqRef.current;
      setCard({ kind: 'loading', name: pick.name });
      api
        .post<QuoteView>('/api/ext/quote', {
          lat: pick.lat,
          lng: pick.lng,
          name: pick.name ?? undefined,
          category: pick.category ?? undefined,
        })
        .then((quote) => pickSeqRef.current === seq && setCard({ kind: 'quoted', quote }))
        .catch((err: unknown) => pickSeqRef.current === seq && setCard({ kind: 'error', message: viewerMessage(err) }));
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

  // --- derived ---------------------------------------------------------------
  const economy: EconomyInfo | null = state?.economy ?? null;
  const offer: ExchangeOffer | null =
    economy ?? (wallet ? { ...wallet.exchange, exchangeRate: wallet.exchangeRate } : null);
  const balance = wallet?.balance ?? null;
  const gps: PublicGps | null = state?.gps ?? null;
  const last = state?.lastWaypoint ?? null;
  const quote = card.kind === 'quoted' ? card.quote : null;
  const gtaMode = (state?.paymentMode ?? 'gta_dollar') === 'gta_dollar';

  return (
    <div className="pn" data-live={live}>
      <header className="pnHead">
        <div className="pnBrand">IRL WAYPOINT</div>
        <span className={`pnLive is-${live}`}>{LIVE_LABEL[live]}</span>
      </header>

      {gtaMode && (
        <div className="pnWallet walletSlot">
          <WalletChip
            load={walletLoad}
            balance={balance}
            onTopUp={() => setTopUp({ credit: null })}
            onIdShare={requestIdShare}
          />
          {topUp && (
            <TopUpDialog
              offer={offer}
              credit={topUp.credit}
              load={walletLoad}
              balance={balance}
              onClose={() => setTopUp(null)}
            />
          )}
        </div>
      )}

      <div className="pnSearch">
        <SearchBox api={api} enabled={auth !== null} onSelect={handleSearchSelect} />
      </div>

      <div className="pnMap">
        <MapView
          config={config}
          visible
          player={gps}
          routeGeometry={quote?.routeGeometry ?? null}
          destination={quote?.destination ?? null}
          focus={focus}
          onPick={handlePick}
        />
      </div>

      <section className="pnCard" aria-live="polite">
        {card.kind === 'idle' && <p className="pnHintText">Выберите точку на карте или найдите её поиском.</p>}
        {card.kind === 'loading' && <p className="pnHintText">Считаем маршрут{card.name ? ` до «${card.name}»` : ''}…</p>}
        {card.kind === 'error' && (
          <div className="pnError">
            <p>{card.message}</p>
            {walletLoad === 'needs_id_share' && (
              <button type="button" className="walletBtn walletBtn--accent" onClick={requestIdShare}>
                ПОДКЛЮЧИТЬ
              </button>
            )}
          </div>
        )}
        {quote && (
          <div className="pnQuote">
            <div className="pnQuoteName">{quote.destinationName}</div>
            <div className="pnQuoteMeta">
              {formatKm(quote.distanceMeters)} · {formatApproxDuration(quote.durationSeconds)}
            </div>
            <div className="pnQuotePrice">{formatGta(quote.cost)}</div>
            {balance != null && <div className="pnQuoteBalance">Ваш баланс: {formatGta(balance)}</div>}
            {live === 'live' ? (
              <button type="button" className="pnCta" onClick={() => setHint(true)}>
                ОТКРЫТЬ КАРТУ НА СТРИМЕ
              </button>
            ) : (
              <button type="button" className="pnCta" disabled>
                {live === 'offline' ? 'СТРИМЕР СЕЙЧАС ОФЛАЙН' : 'ПРОВЕРЯЕМ ЭФИР…'}
              </button>
            )}
            {hint && (
              <p className="pnHintText">
                Точка отправляется на видео: нажмите «🗺 КАРТА» у левого края плеера и выберите это место там.
              </p>
            )}
          </div>
        )}
      </section>

      <section className="pnLast">
        <div className="pnLastTitle">Последняя точка</div>
        {last ? (
          <div className="pnLastBody">
            <b>{last.destinationName}</b> · {formatKm(last.distanceMeters)} · {LAST_STATUS[last.status]}
            <span className="pnLastWhen"> · {when(last.finishedAt ?? last.activatedAt, now)}</span>
          </div>
        ) : (
          <div className="pnLastBody">{state ? 'Точек ещё не было.' : '…'}</div>
        )}
      </section>

      {toast && <WalletToast credit={toast} placement="map" />}
    </div>
  );
}

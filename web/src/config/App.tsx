import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiClient, ApiFailure } from '../shared/api';
import { formatGta, formatInteger } from '../shared/format';
import { currentToken, onAuthorized, onError } from '../viewer/twitch';

/**
 * Broadcaster Config surface (Twitch dashboard → Extensions → Configure).
 *
 * Read-only on purpose. Everything that changes behaviour — prices, limits,
 * privacy, the exchange reward — lives in the admin console, which the
 * streamer also needs on a phone mid-stream. This page answers one question
 * for the streamer and for a Twitch reviewer alike: is the extension wired up,
 * and if not, which part is missing.
 *
 * Nothing secret is displayed. GET /api/ext/broadcaster/status returns
 * booleans, counters, the channel id and the public broadcaster login; every
 * field is still parsed defensively, because this page ships inside the Twitch
 * zip and can outlive the server it was built against (the older response
 * shape is understood too). Errors are always shown as friendly Russian text,
 * never as a raw server message.
 */

/** Slow enough that an open dashboard tab does not keep the server busy. */
const POLL_MS = 10_000;

type Tone = 'ok' | 'warn' | 'bad' | 'idle';
type GpsStatus = 'ok' | 'stale' | 'missing' | 'inaccurate' | 'unknown';
type PaymentMode = 'gta_dollar' | 'channel_points_reward';

interface BroadcasterStatus {
  channelId: string | null;
  twitch: { connected: boolean; login: string | null; localStub: boolean };
  /** null: the server did not say (an older backend). */
  mapboxReady: boolean | null;
  /** count -1 means the server could not ask Twitch. */
  eventsub: { ready: boolean | null; count: number | null };
  gps: { status: GpsStatus; ageMs: number | null; accuracy: number | null };
  reviewDemo: boolean;
  economy: {
    paymentMode: PaymentMode | null;
    exchangeRate: number | null;
    reward: { ready: boolean | null; title: string | null; cost: number | null };
  };
  adminUrl: string | null;
  ready: boolean;
}

// ---------------------------------------------------------------------------
// Defensive parsing
// ---------------------------------------------------------------------------

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A bounded, trimmed display string; anything else is "not given". */
function asText(value: unknown, max = 120): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, max) : null;
}

/** Only http(s) ever becomes a link: a `javascript:` URL must not render. */
function safeHttpUrl(value: unknown): string | null {
  const text = asText(value, 500);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function parseStatus(raw: unknown): BroadcasterStatus {
  const root = asObject(raw) ?? {};
  const twitch = asObject(root.twitch) ?? {};
  const mapbox = asObject(root.mapbox);
  const eventsub = asObject(root.eventsub);
  const gps = asObject(root.gps) ?? {};
  const economy = asObject(root.economy) ?? {};
  const reward = asObject(economy.exchangeReward) ?? {};

  const channelId = asText(root.channelId, 20);
  const login = asText(twitch.login, 25);

  // eventsub.count is the contract; twitch.eventsubCount is the older shape.
  const eventsubCount = asNumber(eventsub?.count) ?? asNumber(twitch.eventsubCount);
  const eventsubReady =
    asBool(eventsub?.ready) ?? (eventsubCount === null || eventsubCount < 0 ? null : eventsubCount > 0);

  const rawGps = asText(gps.status, 20);
  const gpsStatus: GpsStatus =
    rawGps === 'ok' || rawGps === 'stale' || rawGps === 'missing' || rawGps === 'inaccurate'
      ? rawGps
      : 'unknown';
  const ageMs = asNumber(gps.ageMs);
  const accuracy = asNumber(gps.accuracy);

  const reviewDemo =
    asBool(asObject(root.reviewDemo)?.active) === true || asText(gps.source, 20) === 'review_demo';

  const mode = asText(economy.paymentMode, 40);
  const rate = asNumber(economy.exchangeRate);
  const cost = asNumber(reward.cost);

  const parsed: Omit<BroadcasterStatus, 'ready'> = {
    channelId: channelId && /^\d{1,20}$/.test(channelId) ? channelId : null,
    twitch: {
      connected: asBool(twitch.connected) === true,
      login: login && /^[A-Za-z0-9_]{1,25}$/.test(login) ? login : null,
      localStub: asBool(twitch.usingLocalStub) === true,
    },
    mapboxReady: asBool(mapbox?.ready) ?? asBool(root.mapboxConfigured),
    eventsub: { ready: eventsubReady, count: eventsubCount },
    gps: {
      status: gpsStatus,
      ageMs: ageMs !== null && ageMs >= 0 ? ageMs : null,
      accuracy: accuracy !== null && accuracy >= 0 ? accuracy : null,
    },
    reviewDemo,
    economy: {
      paymentMode: mode === 'gta_dollar' || mode === 'channel_points_reward' ? mode : null,
      exchangeRate: rate !== null && rate > 0 ? rate : null,
      reward: {
        ready: asBool(reward.ready),
        title: asText(reward.title),
        cost: cost !== null && cost > 0 ? Math.round(cost) : null,
      },
    },
    adminUrl: safeHttpUrl(root.adminUrl),
  };

  // The server's verdict wins; the local one only covers a backend that
  // predates the field, using the same rule the contract spells out.
  const ready = asBool(root.ready) ?? missingParts(parsed).length === 0;
  return { ...parsed, ready };
}

// ---------------------------------------------------------------------------
// What is missing, in plain Russian
// ---------------------------------------------------------------------------

function missingParts(s: Omit<BroadcasterStatus, 'ready'>): string[] {
  const out: string[] = [];

  if (!s.twitch.connected) {
    out.push(
      'Twitch не подключён. Откройте админ-панель и нажмите «ПОДКЛЮЧИТЬ TWITCH» — без этого награда обмена не работает и GTA$ не начисляются.',
    );
  }

  if (s.eventsub.ready !== true) {
    out.push(
      s.eventsub.count === -1
        ? 'Не удалось проверить подписку EventSub у Twitch. Статус обновится сам; если не пройдёт — нажмите «СИНХР. EVENTSUB» в админ-панели.'
        : 'Нет подписки EventSub на активации наград: Twitch не сообщит серверу об обмене ETH, и GTA$ не начислятся. Нажмите «СИНХР. EVENTSUB» в админ-панели.',
    );
  }

  if (s.mapboxReady !== true) {
    out.push(
      s.mapboxReady === null
        ? 'Сервер не сообщил, настроена ли карта Mapbox. Обновите сервер IRL Waypoint.'
        : 'Не настроен публичный токен Mapbox: зрители не увидят карту и маршрут.',
    );
  }

  if (s.economy.reward.ready !== true) {
    out.push(
      'Награда «Обмен ETH на GTA DOLLAR» не создана или выключена на Twitch: зрителям негде получить GTA$. Нажмите «СИНХР. НАГРАДУ ОБМЕНА» в админ-панели.',
    );
  }

  if (s.gps.status !== 'ok' && !s.reviewDemo) {
    out.push(
      s.gps.status === 'missing'
        ? 'Телефон стримера ещё не прислал GPS. Откройте страницу стримера на телефоне и включите передачу координат.'
        : s.gps.status === 'inaccurate'
          ? 'GPS стримера слишком неточный. Выйдите на открытое место или подождите, пока телефон уточнит позицию.'
          : 'GPS стримера устарел или слишком неточный. Проверьте, что страница стримера открыта на телефоне и передача координат включена.',
    );
  }

  return out;
}

// ---------------------------------------------------------------------------
// Friendly errors
// ---------------------------------------------------------------------------

function friendlyError(err: unknown): string {
  if (err instanceof ApiFailure) {
    if (err.status === 401 || err.code === 'unauthorized') {
      return 'Twitch ещё не подтвердил сессию. Обновите страницу.';
    }
    if (err.status === 429 || err.code === 'rate_limited') {
      return 'Слишком частые запросы. Статус обновится сам через несколько секунд.';
    }
    if (err.status >= 500) return 'Сервер IRL Waypoint временно не отвечает. Статус обновится сам.';
    return 'Сервер не смог показать статус. Обновите страницу.';
  }
  // fetch() rejects with a TypeError when the network or the server is down.
  return 'Нет связи с сервером IRL Waypoint. Статус обновится сам, как только сервер ответит.';
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

function Row({
  label,
  value,
  tone = 'idle',
  note,
}: {
  label: string;
  value: string;
  tone?: Tone;
  note?: string | null;
}) {
  return (
    <div className={`cf-row${tone === 'bad' ? ' is-bad' : ''}`}>
      <div className="cf-rowHead">
        <span className="cf-label">{label}</span>
        <span className={`cf-value is-${tone}`}>
          <span className={`dot ${tone === 'idle' ? '' : tone}`} aria-hidden="true" />
          <span className="num">{value}</span>
        </span>
      </div>
      {note ? <div className="cf-note">{note}</div> : null}
    </div>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="cf">
      <div className="cf-card panel">
        <header className="cf-head">
          <div className="cf-brand">IRL WAYPOINT</div>
          <p className="cf-lead">
            Статус расширения для владельца канала. Цены, лимиты и награда обмена настраиваются в
            админ-панели.
          </p>
        </header>
        {children}
      </div>
    </div>
  );
}

function ageText(ageMs: number | null): string | null {
  if (ageMs === null) return null;
  const s = Math.round(ageMs / 1000);
  if (s < 60) return `последние координаты ${s} с назад`;
  const m = Math.round(s / 60);
  return m < 60 ? `последние координаты ${m} мин назад` : 'последние координаты больше часа назад';
}

/** Age and accuracy together: a fresh but imprecise fix also reads as stale. */
function gpsNote(gps: BroadcasterStatus['gps'], fallback: string | null = null): string | null {
  const parts = [
    ageText(gps.ageMs),
    gps.accuracy !== null ? `точность ±${formatInteger(gps.accuracy)} м` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : fallback;
}

function gpsRow(s: BroadcasterStatus): { value: string; tone: Tone; note: string | null } {
  if (s.reviewDemo) {
    return {
      value: 'REVIEW DEMO',
      tone: 'warn',
      note: 'Включён демонстрационный GPS для проверки Twitch: зрители видят демо-позицию, а не телефон стримера.',
    };
  }
  switch (s.gps.status) {
    case 'ok':
      return { value: 'ONLINE', tone: 'ok', note: gpsNote(s.gps) };
    case 'inaccurate':
      return { value: 'LOW ACCURACY', tone: 'warn', note: gpsNote(s.gps) };
    case 'stale':
      return { value: 'OFFLINE', tone: 'bad', note: gpsNote(s.gps, 'координаты устарели') };
    case 'missing':
      return { value: 'OFFLINE', tone: 'bad', note: 'телефон стримера ещё не прислал координаты' };
    default:
      return { value: '—', tone: 'idle', note: 'сервер не сообщил состояние GPS' };
  }
}

function readyValue(ready: boolean | null): { value: string; tone: Tone } {
  if (ready === true) return { value: 'READY', tone: 'ok' };
  if (ready === false) return { value: 'NOT READY', tone: 'bad' };
  return { value: 'UNKNOWN', tone: 'warn' };
}

function StatusView({
  status,
  refreshError,
  updatedAt,
}: {
  status: BroadcasterStatus;
  refreshError: string | null;
  updatedAt: number | null;
}) {
  const problems = status.ready ? [] : missingParts(status);
  const gps = gpsRow(status);

  const twitchValue = status.twitch.localStub
    ? 'LOCAL STUB'
    : status.twitch.connected
      ? 'CONNECTED'
      : 'DISCONNECTED';
  const twitchTone: Tone = status.twitch.localStub ? 'warn' : status.twitch.connected ? 'ok' : 'bad';
  const twitchNote = status.twitch.localStub
    ? 'Режим разработки: Twitch эмулируется локально.'
    : status.twitch.connected
      ? status.twitch.login
        ? `Аккаунт стримера: ${status.twitch.login}`
        : null
      : 'Подключите аккаунт стримера в админ-панели.';

  const mapbox = readyValue(status.mapboxReady);
  const eventsub = readyValue(status.eventsub.ready);
  const eventsubNote =
    status.eventsub.count === -1
      ? 'не удалось спросить Twitch'
      : status.eventsub.count === null
        ? null
        : `подписок на активации наград: ${formatInteger(status.eventsub.count)}`;

  const reward = readyValue(status.economy.reward.ready);
  const { title, cost } = status.economy.reward;
  const rate = status.economy.exchangeRate;
  const price =
    cost === null
      ? null
      : rate === null
        ? `${formatInteger(cost)} ETH`
        : `${formatInteger(cost)} ETH → ${formatGta(cost * rate)}`;
  const rewardNote = [title ? `«${title}»` : null, price].filter(Boolean).join(' · ');

  const payments =
    status.economy.paymentMode === 'gta_dollar'
      ? { value: 'GTA DOLLAR', tone: 'ok' as Tone, note: 'Точки покупаются за GTA$ прямо на карте.' }
      : status.economy.paymentMode === 'channel_points_reward'
        ? {
            value: 'CHANNEL POINTS',
            tone: 'warn' as Tone,
            note: 'Старый режим: оплата отдельными наградами канала.',
          }
        : { value: '—', tone: 'idle' as Tone, note: null };

  let publicOrigin: string | null = null;
  if (status.adminUrl) {
    try {
      publicOrigin = new URL(status.adminUrl).origin;
    } catch {
      publicOrigin = null;
    }
  }

  return (
    <>
      {status.reviewDemo ? (
        <div className="cf-demo" role="status">
          <div className="cf-demoTitle">REVIEW DEMO GPS ACTIVE</div>
          <div className="cf-demoText">
            Зрители видят демонстрационную позицию, а не реальный GPS стримера. Выключите
            демо-режим на сервере, когда проверка Twitch закончится.
          </div>
        </div>
      ) : null}

      {status.ready ? (
        <div className="cf-verdict is-ready" role="status">
          ✓ EXTENSION READY
        </div>
      ) : (
        <div className="cf-verdict is-missing" role="status">
          <div className="cf-verdictTitle">Расширение ещё не готово</div>
          {problems.length ? (
            <ul className="cf-missing">
              {problems.map((text) => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          ) : (
            <p className="cf-missingOne">
              Сервер сообщает, что расширение ещё не готово. Подробности — в админ-панели.
            </p>
          )}
        </div>
      )}

      {refreshError ? (
        <div className="cf-stale">
          {refreshError}
          {updatedAt !== null
            ? ` Показан статус на ${new Date(updatedAt).toLocaleTimeString('ru-RU')}.`
            : ''}
        </div>
      ) : null}

      <section className="cf-rows" aria-label="Статус расширения">
        <Row label="Twitch" value={twitchValue} tone={twitchTone} note={twitchNote} />
        <Row label="Channel" value={status.channelId ?? '—'} tone="idle" />
        <Row
          label="Mapbox"
          value={mapbox.value}
          tone={mapbox.tone}
          note={status.mapboxReady === false ? 'карта у зрителей не загрузится' : null}
        />
        <Row label="EventSub" value={eventsub.value} tone={eventsub.tone} note={eventsubNote} />
        <Row label="GPS" value={gps.value} tone={gps.tone} note={gps.note} />
        <Row label="Exchange Reward" value={reward.value} tone={reward.tone} note={rewardNote || null} />
        <Row
          label="Exchange rate"
          value={rate !== null ? `1 ETH = ${formatInteger(rate)} GTA$` : '—'}
          tone="idle"
          note="ETH — баллы канала. GTA$ — внутренние очки расширения, не деньги."
        />
        <Row label="Waypoint payments" value={payments.value} tone={payments.tone} note={payments.note} />
      </section>

      <footer className="cf-foot">
        <div className="cf-label">Админ-панель</div>
        {status.adminUrl ? (
          <>
            <a
              className="btn btn-primary cf-link"
              href={status.adminUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              ОТКРЫТЬ АДМИН-ПАНЕЛЬ
            </a>
            <div className="cf-note">
              Если ссылка не открывается из окна Twitch, скопируйте адрес вручную:
            </div>
            <code className="cf-url mono">{status.adminUrl}</code>
          </>
        ) : (
          <div className="cf-note">Сервер не сообщил адрес админ-панели.</div>
        )}
        {publicOrigin ? (
          <div className="cf-legal">
            <a href={`${publicOrigin}/privacy`} target="_blank" rel="noreferrer noopener">
              Privacy Policy
            </a>
            <span aria-hidden="true">·</span>
            <a href={`${publicOrigin}/terms`} target="_blank" rel="noreferrer noopener">
              Terms of Service
            </a>
          </div>
        ) : null}
      </footer>
    </>
  );
}

export default function App() {
  const [authorized, setAuthorized] = useState(false);
  const [status, setStatus] = useState<BroadcasterStatus | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notBroadcaster, setNotBroadcaster] = useState(false);

  const api = useMemo(() => new ApiClient({ getToken: () => currentToken() }), []);

  const load = useCallback(() => {
    if (!currentToken()) return;
    api
      .get<unknown>('/api/ext/broadcaster/status')
      .then((raw) => {
        setStatus(parseStatus(raw));
        setUpdatedAt(Date.now());
        setError(null);
        setNotBroadcaster(false);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiFailure && (err.status === 403 || err.code === 'forbidden')) {
          setNotBroadcaster(true);
          return;
        }
        setError(friendlyError(err));
      });
  }, [api]);

  useEffect(() => {
    // Twitch re-authorizes with a fresh token from time to time; each one is a
    // good moment to re-check.
    const offAuth = onAuthorized(() => {
      setAuthorized(true);
      load();
    });
    const offErr = onError(() => setError('Twitch сообщил об ошибке расширения. Обновите страницу.'));
    return () => {
      offAuth();
      offErr();
    };
  }, [load]);

  useEffect(() => {
    if (!authorized) return;
    // No polling while the dashboard tab is in the background.
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') load();
    }, POLL_MS);
    const onVisible = (): void => {
      if (document.visibilityState !== 'hidden') load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [authorized, load]);

  if (notBroadcaster) {
    return (
      <Shell>
        <div className="cf-verdict is-missing" role="status">
          <div className="cf-verdictTitle">Только для владельца канала</div>
          <p className="cf-missingOne">
            Эта страница открывается владельцем канала из панели управления Twitch. Зрителям здесь
            ничего не нужно настраивать.
          </p>
        </div>
      </Shell>
    );
  }

  if (!status) {
    return (
      <Shell>
        {error ? (
          <div className="cf-verdict is-missing" role="status">
            <div className="cf-verdictTitle">Статус пока недоступен</div>
            <p className="cf-missingOne">{error}</p>
          </div>
        ) : (
          <div className="cf-verdict is-waiting" role="status">
            <p className="cf-missingOne">
              {authorized ? 'Проверяем статус расширения…' : 'Ждём авторизацию Twitch…'}
            </p>
          </div>
        )}
      </Shell>
    );
  }

  return (
    <Shell>
      <StatusView status={status} refreshError={error} updatedAt={updatedAt} />
    </Shell>
  );
}

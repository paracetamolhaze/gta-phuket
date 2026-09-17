import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiClient, ApiFailure, viewerMessage } from '../shared/api';
import { currentToken, onAuthorized, onError } from '../viewer/twitch';

/**
 * Broadcaster Config surface.
 *
 * Read-only on purpose. Everything that actually changes behaviour — price,
 * limits, privacy, restricted zones — lives in /admin, which the streamer needs
 * on a phone mid-stream anyway. This page answers one question: is the thing
 * wired up, and if not, which part is missing.
 *
 * Nothing secret is displayed. The backend endpoint returns booleans, counters
 * and the channel id, never a token or a secret.
 */

interface StatusPayload {
  channelId: string;
  serverTime: number;
  backend: { ok: boolean; devMode: boolean };
  twitch: {
    connected: boolean;
    usingLocalStub: boolean;
    scopes: string[];
    eventsubCount: number;
  };
  gps: { status: string; ageMs: number | null; accuracy: number | null };
  mapboxConfigured: boolean;
  waypointsOpen: boolean;
  slots: { free: number; total: number };
  adminUrl: string;
}

type Tone = 'ok' | 'warn' | 'bad' | 'idle';

const GPS_WORDS: Record<string, { text: string; tone: Tone }> = {
  ok: { text: 'В НОРМЕ', tone: 'ok' },
  stale: { text: 'УСТАРЕЛ', tone: 'bad' },
  missing: { text: 'НЕТ СИГНАЛА', tone: 'bad' },
  inaccurate: { text: 'НИЗКАЯ ТОЧНОСТЬ', tone: 'warn' },
};

function Row({
  label,
  value,
  tone = 'idle',
  note,
}: {
  label: string;
  value: string;
  tone?: Tone;
  note?: string;
}) {
  return (
    <div className="cf-row">
      <div className="cf-rowHead">
        <span className="label">{label}</span>
        <span className="cf-value">
          <span className={`dot ${tone === 'idle' ? '' : tone}`} />
          <span className="num">{value}</span>
        </span>
      </div>
      {note ? <div className="cf-note">{note}</div> : null}
    </div>
  );
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notBroadcaster, setNotBroadcaster] = useState(false);

  const api = useMemo(() => new ApiClient({ getToken: () => currentToken() }), []);
  const timer = useRef<number | null>(null);

  const load = useCallback(() => {
    if (!currentToken()) return;
    api
      .get<StatusPayload>('/api/ext/broadcaster/status')
      .then((next) => {
        setStatus(next);
        setError(null);
        setNotBroadcaster(false);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiFailure && err.code === 'forbidden') {
          setNotBroadcaster(true);
          return;
        }
        setError(viewerMessage(err));
      });
  }, [api]);

  useEffect(() => {
    const offAuth = onAuthorized(() => {
      setReady(true);
      load();
    });
    const offErr = onError((err) => setError(viewerMessage(err)));
    return () => {
      offAuth();
      offErr();
    };
  }, [load]);

  useEffect(() => {
    if (!ready) return;
    timer.current = window.setInterval(load, 5000);
    return () => {
      if (timer.current !== null) window.clearInterval(timer.current);
    };
  }, [ready, load]);

  if (notBroadcaster) {
    return (
      <div className="cf">
        <div className="cf-card panel">
          <h1 className="cf-title">Только для владельца канала</h1>
          <p className="cf-lead">
            Эта страница открывается из дашборда Twitch владельцем канала. Зрителям тут ничего нет.
          </p>
        </div>
      </div>
    );
  }

  if (!ready || !status) {
    return (
      <div className="cf">
        <div className="cf-card panel">
          <h1 className="cf-title">Waypoint</h1>
          <p className="cf-lead">
            {error ?? 'Ждём авторизацию Twitch…'}
          </p>
        </div>
      </div>
    );
  }

  const gpsWord = GPS_WORDS[status.gps.status] ?? { text: status.gps.status.toUpperCase(), tone: 'idle' as Tone };
  const twitchTone: Tone = status.twitch.usingLocalStub
    ? 'warn'
    : status.twitch.connected
      ? 'ok'
      : 'bad';
  const twitchWord = status.twitch.usingLocalStub
    ? 'ЛОКАЛЬНАЯ ЗАГЛУШКА'
    : status.twitch.connected
      ? 'ПОДКЛЮЧЕН'
      : 'НЕ ПОДКЛЮЧЕН';

  return (
    <div className="cf">
      <div className="cf-card panel">
        <header className="cf-head">
          <h1 className="cf-title">
            GTA PHUKET <span className="cf-titleAccent">WAYPOINT</span>
          </h1>
          <p className="cf-lead">
            Статус связки. Настройки — цена, лимиты, приватность, запретные зоны — задаются
            в собственной админ-панели, а не здесь.
          </p>
        </header>

        <section className="cf-rows">
          <Row label="Бэкенд" value={status.backend.ok ? 'ОТВЕЧАЕТ' : 'НЕТ СВЯЗИ'} tone={status.backend.ok ? 'ok' : 'bad'} />
          <Row
            label="Авторизация Twitch"
            value={twitchWord}
            tone={twitchTone}
            note={
              status.twitch.usingLocalStub
                ? 'DEV_MODE без ключей Twitch: награды и redemption эмулируются локально.'
                : status.twitch.connected
                  ? `Scopes: ${status.twitch.scopes.join(', ') || '—'} · EventSub: ${
                      status.twitch.eventsubCount < 0 ? 'не удалось спросить' : status.twitch.eventsubCount
                    }`
                  : 'Пройди broadcaster OAuth в админ-панели, иначе награды не создаются и оплата не засчитывается.'
            }
          />
          <Row label="Channel ID" value={status.channelId} tone="idle" />
          <Row
            label="GPS стримера"
            value={gpsWord.text}
            tone={gpsWord.tone}
            note={
              status.gps.ageMs === null
                ? 'Телефон ещё ни разу не прислал координаты.'
                : `Возраст ${Math.round(status.gps.ageMs / 1000)} с${
                    status.gps.accuracy === null ? '' : ` · точность ±${Math.round(status.gps.accuracy)} м`
                  }`
            }
          />
          <Row
            label="Mapbox"
            value={status.mapboxConfigured ? 'НАСТРОЕН' : 'НЕ НАСТРОЕН'}
            tone={status.mapboxConfigured ? 'ok' : 'bad'}
            note={status.mapboxConfigured ? undefined : 'Без токена карта и маршруты не работают.'}
          />
          <Row
            label="Приём точек"
            value={status.waypointsOpen ? 'ОТКРЫТ' : 'ЗАКРЫТ'}
            tone={status.waypointsOpen ? 'ok' : 'warn'}
            note={`Слоты наград: ${status.slots.free} свободно из ${status.slots.total}`}
          />
        </section>

        <footer className="cf-foot">
          <div className="label">Полная настройка</div>
          <a className="btn btn-primary cf-link" href={status.adminUrl} target="_blank" rel="noreferrer noopener">
            ОТКРЫТЬ АДМИН-ПАНЕЛЬ
          </a>
          <div className="cf-note">
            Если Twitch не даёт открыть ссылку из этого окна — скопируй адрес вручную:
          </div>
          <code className="cf-url mono">{status.adminUrl}</code>
        </footer>
      </div>
    </div>
  );
}

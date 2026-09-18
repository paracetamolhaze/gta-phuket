import type { ReactNode } from 'react';

import { API_BASE } from '../shared/api';
import {
  bearingToCardinal,
  categoryLabel,
  formatCountdown,
  formatDistance,
  formatDuration,
  formatGta,
  formatPoints,
} from '../shared/format';
import type { GpsState, GpsStatus, QuoteStatus, SlotStatus } from '../shared/types';

import type { AdminOAuthView, AdminQuoteRow, AdminSlotsView, AdminWaypointView } from './App';

const GPS_LABEL: Record<GpsStatus, string> = {
  ok: 'В НОРМЕ',
  stale: 'УСТАРЕЛ',
  missing: 'НЕТ СИГНАЛА',
  inaccurate: 'НЕТОЧНЫЙ',
};

const GPS_DOT: Record<GpsStatus, string> = {
  ok: 'ok',
  stale: 'warn',
  missing: 'bad',
  inaccurate: 'warn',
};

const SLOT_LABEL: Record<SlotStatus, string> = {
  FREE: 'СВОБОДЕН',
  RESERVED: 'БРОНЬ',
  CONSUMED: 'ИСПОЛЬЗОВАН',
  BROKEN: 'СЛОМАН',
};

const SLOT_CLASS: Record<SlotStatus, string> = {
  FREE: 'is-free',
  RESERVED: 'is-reserved',
  CONSUMED: 'is-consumed',
  BROKEN: 'is-broken',
};

const QUOTE_LABEL: Record<QuoteStatus, string> = {
  QUOTED: 'РАСЧЁТ',
  AWAITING_REDEMPTION: 'ЖДЁТ ОПЛАТЫ',
  PAID: 'ОПЛАЧЕН',
  EXPIRED: 'ИСТЁК',
  CANCELED: 'ОТМЕНЁН',
};

const QUOTE_CLASS: Record<QuoteStatus, string> = {
  QUOTED: 'is-neutral',
  AWAITING_REDEMPTION: 'is-accent',
  PAID: 'is-ok',
  EXPIRED: 'is-dim',
  CANCELED: 'is-dim',
};

interface StatusPanelProps {
  gps: GpsState;
  /** Age of the newest fix, already advanced by the local clock. */
  gpsAgeMs: number | null;
  gpsTimeoutSeconds: number | null;
  maxGpsAccuracyMeters: number | null;
  waypoint: AdminWaypointView | null;
  /** Server-provided purchased distance, or the largest remaining seen so far. */
  originalDistanceMeters: number | null;
  originalIsObserved: boolean;
  slots: AdminSlotsView;
  quotes: AdminQuoteRow[];
  oauth: AdminOAuthView;
  now: number;
}

function Cell({
  label,
  children,
  mono,
  big,
  wide,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
  big?: boolean;
  wide?: boolean;
}): JSX.Element {
  return (
    <div className={`ad-cell${wide ? ' is-wide' : ''}`}>
      <div className="label">{label}</div>
      <div className={`ad-cell-v num${mono ? ' mono' : ''}${big ? ' is-big' : ''}`}>{children}</div>
    </div>
  );
}

function PanelHead({ title, note }: { title: string; note?: ReactNode }): JSX.Element {
  return (
    <div className="ad-panel-head">
      <div className="ad-panel-title">{title}</div>
      {note ? <div className="ad-panel-note">{note}</div> : null}
    </div>
  );
}

function formatClock(ms: number | null): string {
  if (ms == null) return '—';
  return new Date(ms).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function GpsBlock({
  gps,
  ageMs,
  timeoutSeconds,
  maxAccuracy,
}: {
  gps: GpsState;
  ageMs: number | null;
  timeoutSeconds: number | null;
  maxAccuracy: number | null;
}): JSX.Element {
  const sample = gps.sample;
  const ageS = ageMs == null ? null : ageMs / 1000;
  const stale = ageS != null && timeoutSeconds != null && ageS > timeoutSeconds;
  const inaccurate =
    sample != null && maxAccuracy != null && Number.isFinite(sample.accuracy) && sample.accuracy > maxAccuracy;

  return (
    <section className="panel ad-panel">
      <PanelHead
        title="GPS"
        note={
          <span className="ad-inline">
            <i className={`dot ${GPS_DOT[gps.status]}`} />
            {GPS_LABEL[gps.status]}
          </span>
        }
      />
      <div className="ad-grid">
        <Cell label="Широта" mono>
          {sample ? sample.lat.toFixed(6) : '—'}
        </Cell>
        <Cell label="Долгота" mono>
          {sample ? sample.lng.toFixed(6) : '—'}
        </Cell>
        <Cell label="Точность">
          {sample && Number.isFinite(sample.accuracy) ? `${Math.round(sample.accuracy)} м` : '—'}
        </Cell>
        <Cell label="Возраст">{ageS == null ? '—' : `${ageS.toFixed(1)} с`}</Cell>
        <Cell label="Курс">
          {sample && sample.heading != null
            ? `${Math.round(sample.heading)}° ${bearingToCardinal(sample.heading)}`
            : '—'}
        </Cell>
        <Cell label="Скорость">
          {sample && sample.speed != null ? `${(sample.speed * 3.6).toFixed(1)} км/ч` : '—'}
        </Cell>
      </div>
      {stale ? (
        <div className="ad-warn">
          Фикс старше лимита: {ageS == null ? '—' : ageS.toFixed(1)} с при пороге {timeoutSeconds} с —
          новые точки сервер отклоняет.
        </div>
      ) : null}
      {inaccurate && sample ? (
        <div className="ad-warn">
          Погрешность {Math.round(sample.accuracy)} м выше лимита {maxAccuracy} м.
        </div>
      ) : null}
    </section>
  );
}

function WaypointBlock({
  waypoint,
  original,
  originalIsObserved,
  now,
}: {
  waypoint: AdminWaypointView | null;
  original: number | null;
  originalIsObserved: boolean;
  now: number;
}): JSX.Element {
  if (!waypoint) {
    return (
      <section className="panel ad-panel">
        <PanelHead title="Активная точка" />
        <div className="ad-empty">Активного задания нет</div>
      </section>
    );
  }

  const remaining = waypoint.remainingDistanceMeters;
  const progress =
    original != null && original > 0 && remaining != null
      ? Math.min(1, Math.max(0, 1 - remaining / original))
      : null;
  const category = categoryLabel(waypoint.destinationCategory);
  const elapsed = Math.max(0, now - waypoint.activatedAt);

  return (
    <section className="panel ad-panel">
      <PanelHead
        title="Активная точка"
        note={<span className="ad-inline is-accent">В РАБОТЕ</span>}
      />
      <div className="ad-dest">
        <span className="ad-dest-name">{waypoint.destinationName}</span>
        {category ? <span className="ad-dest-cat">{category}</span> : null}
      </div>
      <div className="ad-grid">
        <Cell label="Осталось" big>
          {formatDistance(remaining)}
        </Cell>
        <Cell label="ETA" big>
          {formatDuration(waypoint.remainingDurationSeconds)}
        </Cell>
        <Cell label={originalIsObserved ? 'Исходно (набл.)' : 'Исходно'}>
          {formatDistance(original)}
        </Cell>
        <Cell label="В пути">{formatCountdown(elapsed)}</Cell>
        <Cell label="Оплатил">{waypoint.paidBy ?? '—'}</Cell>
        {/* A GTA$ waypoint stores its GTA$ cost in the points field (GTA_DOLLAR_ECONOMY.md §6). */}
        {waypoint.currency === 'GTA_DOLLAR' ? (
          <Cell label="Оплачено">{formatGta(waypoint.channelPointsPaid)}</Cell>
        ) : (
          <Cell label="Баллов">{formatPoints(waypoint.channelPointsPaid)}</Cell>
        )}
        <Cell label="Цель" mono wide>
          {waypoint.destination.lat.toFixed(5)}, {waypoint.destination.lng.toFixed(5)}
        </Cell>
      </div>
      <div className="ad-bar" title={progress == null ? 'нет данных' : `${Math.round(progress * 100)}%`}>
        <i style={{ width: `${progress == null ? 0 : progress * 100}%` }} />
      </div>
      {originalIsObserved && original != null ? (
        <div className="ad-hint">
          Исходная дистанция — максимум из наблюдённых значений остатка: сервер не отдаёт купленную
          длину маршрута в состоянии.
        </div>
      ) : null}
    </section>
  );
}

function SlotsBlock({ slots }: { slots: AdminSlotsView }): JSX.Element {
  const items = slots.items;
  return (
    <section className="panel ad-panel">
      <PanelHead
        title="Слоты наград"
        note={
          <span className="num">
            свободно <b>{slots.free}</b> / {slots.total}
          </span>
        }
      />
      {items && items.length > 0 ? (
        <>
          <div className="ad-slots">
            {items.map((item) => {
              const label = SLOT_LABEL[item.status] ?? item.status;
              const title = [
                `#${item.index} · ${label}`,
                item.currentTitle ?? null,
                item.currentCost == null ? null : `${formatPoints(item.currentCost)} баллов`,
                item.reservedForUser ? `бронь: ${item.reservedForUser}` : null,
                item.quoteId ? `расчёт: ${item.quoteId}` : null,
                item.enabled === false ? 'выключен на Twitch' : null,
              ]
                .filter((part): part is string => part !== null)
                .join('\n');
              return (
                <div
                  key={item.index}
                  className={`ad-slot ${SLOT_CLASS[item.status] ?? 'is-free'}${
                    item.enabled === false ? ' is-off' : ''
                  }`}
                  title={title}
                >
                  <span className="num ad-slot-i">{item.index}</span>
                  <i />
                </div>
              );
            })}
          </div>
          <div className="ad-legend">
            <span className="is-free">свободен</span>
            <span className="is-reserved">бронь</span>
            <span className="is-consumed">использован</span>
            <span className="is-broken">сломан</span>
          </div>
        </>
      ) : (
        <div className="ad-empty">
          Состав слотов сервер не прислал — известны только счётчики: {slots.free} из {slots.total}.
        </div>
      )}
    </section>
  );
}

function QuotesBlock({ quotes, now }: { quotes: AdminQuoteRow[]; now: number }): JSX.Element {
  const rows = [...quotes]
    .sort((a, b) => (b.createdAt ?? b.expiresAt ?? 0) - (a.createdAt ?? a.expiresAt ?? 0))
    .slice(0, 15);

  return (
    <section className="panel ad-panel">
      <PanelHead title="Последние расчёты" note={<span className="num">{quotes.length}</span>} />
      {rows.length === 0 ? (
        <div className="ad-empty">Расчётов пока нет</div>
      ) : (
        <div className="ad-table-wrap scroll-thin">
          <table className="ad-table">
            <thead>
              <tr>
                <th>Код</th>
                <th>Статус</th>
                <th>Точка</th>
                <th className="is-right">Цена</th>
                <th>Зритель</th>
                <th className="is-right">Истекает</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((quote) => {
                const left = quote.expiresAt - now;
                const live = quote.status === 'QUOTED' || quote.status === 'AWAITING_REDEMPTION';
                return (
                  <tr key={quote.id}>
                    <td className="mono">{quote.code}</td>
                    <td>
                      <span className={`ad-pill ${QUOTE_CLASS[quote.status] ?? 'is-neutral'}`}>
                        {QUOTE_LABEL[quote.status] ?? quote.status}
                      </span>
                    </td>
                    <td className="ad-ellipsis" title={quote.destinationName}>
                      {quote.destinationName}
                    </td>
                    <td className="is-right num">
                      {quote.currency === 'GTA_DOLLAR' ? formatGta(quote.cost) : formatPoints(quote.cost)}
                    </td>
                    <td className="ad-ellipsis">{quote.twitchUserName ?? '—'}</td>
                    <td className="is-right num">
                      {live && left > 0 ? formatCountdown(left) : formatClock(quote.expiresAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function OAuthBlock({ oauth, now }: { oauth: AdminOAuthView; now: number }): JSX.Element {
  if (!oauth.connected) {
    return (
      <section className="panel ad-panel ad-oauth-cta">
        <PanelHead title="Twitch не подключён" />
        <p className="ad-modal-text">
          Без авторизации канала награды не создаются, EventSub не приходит и оплата не засчитывается.
        </p>
        <a className="btn btn-primary ad-oauth-btn" href={`${API_BASE}/api/oauth/twitch/start`}>
          ПОДКЛЮЧИТЬ TWITCH
        </a>
      </section>
    );
  }

  const left = oauth.expiresAt == null ? null : oauth.expiresAt - now;

  return (
    <section className="panel ad-panel">
      <PanelHead
        title="Twitch"
        note={
          <span className="ad-inline">
            <i className="dot ok" />
            ПОДКЛЮЧЁН
          </span>
        }
      />
      <div className="ad-grid">
        <Cell label="Токен до">
          {formatClock(oauth.expiresAt)}
          {left != null && left > 0 ? <span className="ad-sub"> · {formatCountdown(left)}</span> : null}
        </Cell>
        <Cell label="EventSub">{oauth.eventsub.count}</Cell>
      </div>
      {oauth.scopes.length > 0 ? (
        <div className="ad-chip-row">
          {oauth.scopes.map((scope) => (
            <span key={scope} className="ad-tag mono">
              {scope}
            </span>
          ))}
        </div>
      ) : null}
      {oauth.eventsub.types.length > 0 ? (
        <div className="ad-chip-row">
          {oauth.eventsub.types.map((type) => (
            <span key={type} className="ad-tag mono is-dim">
              {type}
            </span>
          ))}
        </div>
      ) : null}
      <a className="ad-relink" href={`${API_BASE}/api/oauth/twitch/start`}>
        переподключить
      </a>
    </section>
  );
}

export function StatusPanel(props: StatusPanelProps): JSX.Element {
  const { gps, gpsAgeMs, gpsTimeoutSeconds, maxGpsAccuracyMeters, waypoint, slots, quotes, oauth, now } =
    props;

  return (
    <>
      {oauth.connected ? null : <OAuthBlock oauth={oauth} now={now} />}
      <GpsBlock
        gps={gps}
        ageMs={gpsAgeMs}
        timeoutSeconds={gpsTimeoutSeconds}
        maxAccuracy={maxGpsAccuracyMeters}
      />
      <WaypointBlock
        waypoint={waypoint}
        original={props.originalDistanceMeters}
        originalIsObserved={props.originalIsObserved}
        now={now}
      />
      <SlotsBlock slots={slots} />
      <QuotesBlock quotes={quotes} now={now} />
      {oauth.connected ? <OAuthBlock oauth={oauth} now={now} /> : null}
    </>
  );
}

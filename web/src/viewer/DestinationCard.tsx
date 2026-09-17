/**
 * The bottom sheet: one destination at a time.
 *
 * Every number shown here is taken verbatim from the server response — the
 * browser never derives a price, a distance or a duration.
 */

import { categoryLabel, formatCountdown, formatDistance, formatDuration, formatPoints } from '../shared/format';
import type { ApiErrorCode, QuoteView } from '../shared/types';

export type CardState =
  | { kind: 'idle' }
  | { kind: 'loading'; name: string | null }
  | { kind: 'error'; message: string; code: ApiErrorCode | null }
  | { kind: 'quoted'; quote: QuoteView }
  | { kind: 'confirming'; quote: QuoteView }
  | { kind: 'awaiting'; quote: QuoteView }
  | { kind: 'active'; name: string }
  | { kind: 'completed'; name: string };

export interface DestinationCardProps {
  state: CardState;
  /** Ticking clock from App, so the countdown does not own a timer. */
  now: number;
  /** Set when quoting is impossible (GPS down, closed, job running). */
  blockedMessage: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  onIdShare: () => void;
  onClose: () => void;
}

function Head(props: { label: string; title: string; category?: string | null; onClose: () => void }) {
  const category = categoryLabel(props.category);
  return (
    <div className="cardHead">
      <div className="cardHeadText">
        <div className="label">{props.label}</div>
        <div className="cardTitle">{props.title}</div>
        {category && <div className="cardSub">{category}</div>}
      </div>
      <button type="button" className="cardClose" aria-label="Закрыть" onClick={props.onClose}>
        ×
      </button>
    </div>
  );
}

function Stats(props: { distanceMeters: number; durationSeconds: number; cost: number; costLabel: string }) {
  return (
    <div className="statRow">
      <div className="stat">
        <div className="label">Пешком</div>
        <div className="statValue num">{formatDistance(props.distanceMeters)}</div>
      </div>
      <div className="stat">
        <div className="label">Время</div>
        <div className="statValue num">{formatDuration(props.durationSeconds)}</div>
      </div>
      <div className="stat stat--cost">
        <div className="label">{props.costLabel}</div>
        <div className="statValue num">
          {formatPoints(props.cost)} <span className="statUnit">баллов</span>
        </div>
      </div>
    </div>
  );
}

export default function DestinationCard(props: DestinationCardProps) {
  const { state, now, blockedMessage, onConfirm, onCancel, onIdShare, onClose } = props;
  if (state.kind === 'idle') return null;

  if (state.kind === 'loading') {
    return (
      <section className="card panel" aria-busy="true">
        <div className="cardHead">
          <div className="cardHeadText">
            <div className="label">Считаем маршрут</div>
            <div className="cardTitle">{state.name ?? 'Точка на карте'}</div>
          </div>
        </div>
        <div className="statRow">
          <div className="stat">
            <div className="label">Пешком</div>
            <div className="skel skel--sm" />
          </div>
          <div className="stat">
            <div className="label">Время</div>
            <div className="skel skel--sm" />
          </div>
          <div className="stat stat--cost">
            <div className="label">Стоимость</div>
            <div className="skel skel--sm" />
          </div>
        </div>
        <div className="skel skel--btn" />
      </section>
    );
  }

  if (state.kind === 'error') {
    return (
      <section className="card panel card--bad" role="alert">
        <div className="cardHead">
          <div className="cardHeadText">
            <div className="label">Не получилось</div>
            <div className="cardMessage">{state.message}</div>
          </div>
          <button type="button" className="cardClose" aria-label="Закрыть" onClick={onClose}>
            ×
          </button>
        </div>
        {state.code === 'needs_id_share' && (
          <button type="button" className="btn btn-primary cardAction" onClick={onIdShare}>
            Разрешить доступ к аккаунту
          </button>
        )}
      </section>
    );
  }

  if (state.kind === 'active') {
    return (
      <section className="card panel card--ok">
        <Head label="Точка принята" title={state.name} onClose={onClose} />
        <div className="cardNote">Стример уже идёт. Маршрут виден на карте.</div>
      </section>
    );
  }

  if (state.kind === 'completed') {
    return (
      <section className="card panel card--ok">
        <Head label="Точка достигнута" title={state.name} onClose={onClose} />
        <div className="cardNote">Задание закрыто. Можно выбирать следующую точку.</div>
      </section>
    );
  }

  const quote = state.quote;
  const msLeft = quote.expiresAt - now;
  const expired = msLeft <= 0;

  if (state.kind === 'awaiting') {
    return (
      <section className="card panel">
        <Head
          label="Точка готова"
          title={quote.destinationName}
          category={quote.destinationCategory}
          onClose={onClose}
        />
        <Stats
          distanceMeters={quote.distanceMeters}
          durationSeconds={quote.durationSeconds}
          cost={quote.cost}
          costLabel="Цена"
        />
        <div className="payBlock">
          <div className="payHint">Чтобы подтвердить: открой награды за баллы канала Twitch и активируй</div>
          <div className="reward mono">{quote.rewardTitle ?? `WAYPOINT • ${quote.code}`}</div>
          <div className="payWhere">
            Кнопка баллов — рядом с полем ввода чата. Открыть её из расширения нельзя, это делается только
            руками.
          </div>
        </div>
        <div className="cardFootRow">
          <span className={expired ? 'cardFoot cardFoot--bad' : 'cardFoot'}>
            {expired ? 'Время вышло. Выбери точку заново' : 'Ожидаем оплату…'}
            {!expired && <span className="num cardTimer">{formatCountdown(msLeft)}</span>}
          </span>
          <button type="button" className="btn btn-ghost btn-danger cardCancel" onClick={onCancel}>
            Отменить
          </button>
        </div>
      </section>
    );
  }

  // 'quoted' | 'confirming'
  const busy = state.kind === 'confirming';
  return (
    <section className="card panel">
      <Head label="Точка" title={quote.destinationName} category={quote.destinationCategory} onClose={onClose} />
      <Stats
        distanceMeters={quote.distanceMeters}
        durationSeconds={quote.durationSeconds}
        cost={quote.cost}
        costLabel="Стоимость"
      />
      <button
        type="button"
        className="btn btn-primary cardAction"
        disabled={busy || expired || blockedMessage !== null}
        onClick={onConfirm}
      >
        {busy ? 'Резервируем…' : 'Отправить стримера сюда'}
      </button>
      <div className={expired || blockedMessage ? 'cardFoot cardFoot--bad' : 'cardFoot'}>
        {blockedMessage ??
          (expired ? (
            'Расчёт устарел. Выбери точку заново'
          ) : (
            <>
              Расчёт действует ещё <span className="num cardTimer">{formatCountdown(msLeft)}</span>
            </>
          ))}
      </div>
    </section>
  );
}

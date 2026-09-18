/**
 * The bottom sheet: one destination at a time.
 *
 * Every number shown here is taken verbatim from the server response — the
 * browser never derives a price, a distance or a duration. The one thing it
 * does work out is the GTA$ shortfall, and that only to tell the viewer how
 * much to top up: whether a purchase goes through is decided by the server.
 */

import {
  categoryLabel,
  formatCountdown,
  formatDistance,
  formatDuration,
  formatGta,
  formatPoints,
} from '../shared/format';
import type { ApiErrorCode, PaymentMode, QuoteView } from '../shared/types';
import { LINK_PROMPT } from './Wallet';
import type { WalletLoad } from './Wallet';

export type CardState =
  | { kind: 'idle' }
  | { kind: 'loading'; name: string | null }
  | { kind: 'error'; message: string; code: ApiErrorCode | null }
  /**
   * `notice`: why the viewer is looking at this quote again (a failed
   * purchase). `unsure`: a purchase of it got no answer and may have gone
   * through — only asking the server again can tell, so nothing seen locally
   * (a new active job, a lower balance, the countdown) may disable the button.
   */
  | { kind: 'quoted'; quote: QuoteView; notice?: string; unsure?: boolean }
  | { kind: 'confirming'; quote: QuoteView }
  | { kind: 'awaiting'; quote: QuoteView }
  /** A GTA$ purchase is in flight: one click, one request. */
  | { kind: 'purchasing'; quote: QuoteView }
  | { kind: 'active'; name: string; waypointId?: string; paid?: number }
  | { kind: 'completed'; name: string };

export interface CardWallet {
  load: WalletLoad;
  /** Last balance GET /api/ext/wallet returned, or null before the first. */
  balance: number | null;
}

export interface DestinationCardProps {
  state: CardState;
  /** Ticking clock from App, so the countdown does not own a timer. */
  now: number;
  /** Set when quoting is impossible (GPS down, closed, job running). */
  blockedMessage: string | null;
  /** From GET /api/ext/state; null until it has loaded. */
  paymentMode: PaymentMode | null;
  wallet: CardWallet;
  onConfirm: () => void;
  onPurchase: () => void;
  onTopUp: () => void;
  onRequote: () => void;
  onCancel: () => void;
  onIdShare: () => void;
  onClose: () => void;
}

/**
 * The quote itself says what it is priced in. The mode only fills in for a
 * quote from a server that does not say yet.
 */
export function isGtaQuote(quote: QuoteView, paymentMode: PaymentMode | null): boolean {
  if (quote.currency === 'GTA_DOLLAR' || quote.currency === 'CHANNEL_POINTS') {
    return quote.currency === 'GTA_DOLLAR';
  }
  return paymentMode === 'gta_dollar';
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

function GtaQuote(props: {
  quote: QuoteView;
  busy: boolean;
  msLeft: number;
  notice: string | null;
  unsure: boolean;
  blockedMessage: string | null;
  wallet: CardWallet;
  onPurchase: () => void;
  onTopUp: () => void;
  onClose: () => void;
}) {
  const { quote, busy, msLeft, notice, unsure, wallet } = props;
  const expired = msLeft <= 0;
  const balance = wallet.balance;
  // While a purchase is in flight or went unanswered, a lower balance may be
  // that very purchase and the job now running may be ours: neither is shown
  // as a reason this quote cannot be bought.
  const pending = busy || unsure;
  const blockedMessage = pending ? null : props.blockedMessage;
  const shortfall = balance !== null && !pending ? quote.cost - balance : 0;
  const insufficient = shortfall > 0;
  // Before the first wallet read there is nothing to compare against; after a
  // failed one the server gets to decide, so the button stays usable.
  const walletPending = balance === null && wallet.load === 'loading';

  const balanceText = balance !== null ? formatGta(balance) : walletPending ? 'GTA$ …' : formatGta(null);

  // A shortfall already explains a refused purchase, with the exact amount.
  const foot = blockedMessage ?? (insufficient ? null : notice);
  const disabled = busy || (!unsure && (expired || blockedMessage !== null || insufficient || walletPending));

  return (
    <section className="card panel" aria-busy={busy}>
      <Head label="Точка" title={quote.destinationName} category={quote.destinationCategory} onClose={props.onClose} />
      <div className="cardMeta num">
        {formatDistance(quote.distanceMeters)} · {formatDuration(quote.durationSeconds)}
      </div>
      <div className="gtaPrice">
        <div className="gtaRow gtaRow--price">
          <span className="gtaRowLabel">Цена:</span>
          <span className="gtaRowValue num">{formatGta(quote.cost)}</span>
        </div>
        <div className="gtaRow">
          <span className="gtaRowLabel">Ваш баланс:</span>
          <span className="gtaRowValue num">{balanceText}</span>
        </div>
      </div>
      <button
        type="button"
        className="btn btn-primary cardAction gtaBuy"
        disabled={disabled}
        onClick={props.onPurchase}
      >
        {busy ? (
          'Оплачиваем…'
        ) : (
          <>
            ОТПРАВИТЬ СТРИМЕРА — <span className="gtaAmount">{formatGta(quote.cost)}</span>
          </>
        )}
      </button>
      {insufficient && (
        <div className="gtaShort">
          <span className="gtaShortText num">Не хватает {formatGta(shortfall)}</span>
          <button type="button" className="walletBtn walletBtn--accent" onClick={props.onTopUp}>
            + ПОПОЛНИТЬ
          </button>
        </div>
      )}
      <div className={expired || foot ? 'cardFoot cardFoot--bad' : 'cardFoot'}>
        {foot ??
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

export default function DestinationCard(props: DestinationCardProps) {
  const { state, now, blockedMessage, paymentMode, wallet, onConfirm, onCancel, onIdShare, onClose } = props;
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
    // With GTA$ the identity share is what opens the wallet, so it is asked
    // for in the same words as the wallet chip.
    const linkForGta = state.code === 'needs_id_share' && paymentMode === 'gta_dollar';
    // Codes where the same place, quoted again, is the whole fix.
    const requote = state.code === 'price_changed' || state.code === 'payment_mode' || state.code === 'quote_expired';
    return (
      <section className="card panel card--bad" role="alert">
        <div className="cardHead">
          <div className="cardHeadText">
            <div className="label">Не получилось</div>
            <div className="cardMessage">{linkForGta ? LINK_PROMPT : state.message}</div>
          </div>
          <button type="button" className="cardClose" aria-label="Закрыть" onClick={onClose}>
            ×
          </button>
        </div>
        {state.code === 'needs_id_share' && (
          <button type="button" className="btn btn-primary cardAction" onClick={onIdShare}>
            {linkForGta ? 'ПОДКЛЮЧИТЬ' : 'Разрешить доступ к аккаунту'}
          </button>
        )}
        {requote && (
          <button type="button" className="btn btn-primary cardAction" onClick={props.onRequote}>
            Пересчитать цену
          </button>
        )}
      </section>
    );
  }

  if (state.kind === 'active') {
    return (
      <section className="card panel card--ok">
        <Head label="Точка принята" title={state.name} onClose={onClose} />
        {state.paid !== undefined && <div className="cardMeta num">Оплачено: {formatGta(state.paid)}</div>}
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

  if (state.kind === 'purchasing' || (state.kind === 'quoted' && isGtaQuote(quote, paymentMode))) {
    return (
      <GtaQuote
        quote={quote}
        busy={state.kind === 'purchasing'}
        msLeft={msLeft}
        notice={state.kind === 'quoted' ? state.notice ?? null : null}
        unsure={state.kind === 'quoted' && state.unsure === true}
        blockedMessage={blockedMessage}
        wallet={wallet}
        onPurchase={props.onPurchase}
        onTopUp={props.onTopUp}
        onClose={onClose}
      />
    );
  }

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

  // Legacy Channel Points flow: 'quoted' | 'confirming'
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

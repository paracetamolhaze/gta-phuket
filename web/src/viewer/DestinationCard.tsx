/**
 * The bottom sheet: one destination at a time.
 *
 * Every number shown here is taken verbatim from the server response — the
 * browser never derives a price, a distance or a duration. The one thing it
 * does work out is whether the balance covers the price, and that only to
 * offer a top-up instead of a button that is bound to fail: whether a
 * purchase goes through is decided by the server.
 */

import {
  categoryLabel,
  formatApproxDuration,
  formatCountdown,
  formatGta,
  formatKm,
  formatPoints,
} from '../shared/format';
import type { ApiErrorCode, PaymentMode, QuoteView } from '../shared/types';
import { INSUFFICIENT_MESSAGE, TOP_UP_LABEL, balanceText } from './Wallet';
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
  /** `balance`: what the purchase response said is left, when it was ours. */
  | { kind: 'active'; name: string; waypointId?: string; paid?: number; balance?: number }
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

/** Codes that are not a failure but a missing Twitch identity. */
const IDENTITY_CODES: ReadonlySet<ApiErrorCode> = new Set<ApiErrorCode>(['needs_id_share', 'needs_login']);

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" className="cardClose" aria-label="Закрыть" onClick={onClose}>
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path d="M6 6l12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
      </svg>
    </button>
  );
}

function Head(props: { label?: string; title: string; category?: string | null; onClose: () => void }) {
  const category = categoryLabel(props.category);
  return (
    <div className="cardHead">
      <div className="cardHeadText">
        {props.label && <div className="label">{props.label}</div>}
        <div className="cardTitle">{props.title}</div>
        {category && <div className="cardSub">{category}</div>}
      </div>
      <CloseButton onClose={props.onClose} />
    </div>
  );
}

/** `1.4 км · ~19 мин`, with an icon each so the pair reads without labels. */
function RouteFacts(props: { distanceMeters: number; durationSeconds: number }) {
  return (
    <div className="routeFacts num">
      <span className="routeFact">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
          <circle cx="13" cy="4.2" r="2" fill="currentColor" />
          <path
            d="M10.4 21l1.7-6.2 2.6 2.4V21M8 12.2l1.6-4.1 3.3-.7 2.4 3.3 2.7 1.1M12.1 14.8l.8-7.4"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
        {formatKm(props.distanceMeters)}
      </span>
      <span className="routeFact">
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
          <circle cx="12" cy="12" r="8.2" stroke="currentColor" strokeWidth="1.8" fill="none" />
          <path d="M12 7.6V12l3 2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
        </svg>
        {formatApproxDuration(props.durationSeconds)}
      </span>
    </div>
  );
}

function Countdown({ msLeft }: { msLeft: number }) {
  return (
    <>
      Цена действует ещё <span className="num cardTimer">{formatCountdown(msLeft)}</span>
    </>
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
  onRequote: () => void;
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
  const insufficient = balance !== null && !pending && quote.cost > balance;
  // Before the first wallet read there is nothing to compare against; after a
  // failed one the server gets to decide, so the button stays usable.
  const walletPending = balance === null && wallet.load === 'loading';
  // A dead quote is fixed by pricing the same place again, not by a dead button.
  const requote = expired && !pending && blockedMessage === null && !insufficient;

  const disabled = busy || (!unsure && (expired || blockedMessage !== null || walletPending));
  // A refused purchase leaves "not enough GTA$" on the card; once a top-up
  // has made the balance cover the price, that notice would contradict the
  // balance line right above it.
  const shortfallSettled = notice === INSUFFICIENT_MESSAGE && balance !== null && quote.cost <= balance;
  const foot = blockedMessage ?? (insufficient || shortfallSettled ? null : notice);

  return (
    <section className="card card--quote panel" aria-busy={busy}>
      <Head title={quote.destinationName} category={quote.destinationCategory} onClose={props.onClose} />
      <RouteFacts distanceMeters={quote.distanceMeters} durationSeconds={quote.durationSeconds} />

      <div className="gtaPrice">
        <div className="gtaPriceValue num">{formatGta(quote.cost)}</div>
        <div className={insufficient ? 'gtaBalance gtaBalance--short num' : 'gtaBalance num'}>
          Ваш баланс: {balanceText(wallet.load, balance)}
        </div>
      </div>

      {insufficient ? (
        <>
          <div className="cardAlert" role="alert">
            {INSUFFICIENT_MESSAGE}
          </div>
          <button type="button" className="btn btn-primary cardAction" onClick={props.onTopUp}>
            {TOP_UP_LABEL}
          </button>
        </>
      ) : requote ? (
        <button type="button" className="btn btn-primary cardAction" onClick={props.onRequote}>
          Обновить цену
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-primary cardAction gtaBuy"
          disabled={disabled}
          aria-busy={busy}
          onClick={props.onPurchase}
        >
          {busy && <span className="btnSpinner" aria-hidden="true" />}
          ОТПРАВИТЬ СТРИМЕРА
        </button>
      )}

      {!insufficient && (
        <div className={foot || expired ? 'cardFoot cardFoot--bad' : 'cardFoot'}>
          {foot ?? (expired ? 'Цена устарела.' : <Countdown msLeft={msLeft} />)}
        </div>
      )}
      {unsure && !busy && <div className="cardNote">Повторное нажатие не спишет GTA$ дважды.</div>}
    </section>
  );
}

export default function DestinationCard(props: DestinationCardProps) {
  const { state, now, blockedMessage, paymentMode, wallet, onConfirm, onCancel, onIdShare, onClose } = props;
  if (state.kind === 'idle') return null;

  if (state.kind === 'loading') {
    return (
      <section className="card card--quote panel" aria-busy="true">
        <div className="cardHead">
          <div className="cardHeadText">
            <div className="cardTitle">{state.name ?? 'Точка на карте'}</div>
            <div className="cardSub">Считаем маршрут…</div>
          </div>
          <CloseButton onClose={onClose} />
        </div>
        <div className="skel skel--sm" />
        <div className="skel skel--price" />
        <div className="skel skel--btn" />
      </section>
    );
  }

  if (state.kind === 'error') {
    const identity = state.code !== null && IDENTITY_CODES.has(state.code);
    // Codes where the same place, quoted again, is the whole fix.
    const requote = state.code === 'price_changed' || state.code === 'payment_mode' || state.code === 'quote_expired';
    return (
      <section className={identity ? 'card panel' : 'card panel card--bad'} role="alert">
        <div className="cardHead">
          <div className="cardHeadText">
            {!identity && <div className="label">Не получилось</div>}
            <div className="cardMessage">{state.message}</div>
          </div>
          <CloseButton onClose={onClose} />
        </div>
        {state.code === 'needs_id_share' && (
          <button type="button" className="btn btn-primary cardAction" onClick={onIdShare}>
            ПОДКЛЮЧИТЬ
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
      <section className="card card--ok panel" role="status">
        <div className="cardHead">
          <div className="cardHeadText">
            <div className="cardStatus cardStatus--ok">ТОЧКА ПРИНЯТА</div>
            <div className="cardTitle">{state.name}</div>
          </div>
          <CloseButton onClose={onClose} />
        </div>
        {state.balance !== undefined && (
          <div className="gtaRest num">
            <span className="gtaRestLabel">Остаток:</span>
            <span className="gtaRestValue">{formatGta(state.balance)}</span>
          </div>
        )}
        <div className="cardNote">Стример уже в пути. Маршрут — на карте.</div>
      </section>
    );
  }

  if (state.kind === 'completed') {
    return (
      <section className="card card--ok panel" role="status">
        <div className="cardHead">
          <div className="cardHeadText">
            <div className="cardStatus cardStatus--ok">ТОЧКА ДОСТИГНУТА</div>
            <div className="cardTitle">{state.name}</div>
          </div>
          <CloseButton onClose={onClose} />
        </div>
        <div className="cardNote">Задание выполнено. Можно выбирать следующую точку.</div>
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
        onRequote={props.onRequote}
        onClose={onClose}
      />
    );
  }

  // Legacy Channel Points flow (payment mode `channel_points_reward`).
  if (state.kind === 'awaiting') {
    return (
      <section className="card panel">
        <Head label="Точка готова" title={quote.destinationName} category={quote.destinationCategory} onClose={onClose} />
        <RouteFacts distanceMeters={quote.distanceMeters} durationSeconds={quote.durationSeconds} />
        <div className="payBlock">
          <div className="payHint">Чтобы подтвердить, откройте награды за баллы канала и активируйте</div>
          {/* The reward's own title: the only way to find it in Twitch's list. */}
          <div className="reward mono">{quote.rewardTitle ?? `WAYPOINT • ${quote.code}`}</div>
          <div className="payWhere">Кнопка баллов — рядом с полем ввода чата.</div>
        </div>
        <div className="cardFootRow">
          <span className={expired ? 'cardFoot cardFoot--bad' : 'cardFoot'}>
            {expired ? 'Время вышло. Выберите точку заново.' : 'Ожидаем оплату…'}
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
    <section className="card card--quote panel">
      <Head title={quote.destinationName} category={quote.destinationCategory} onClose={onClose} />
      <RouteFacts distanceMeters={quote.distanceMeters} durationSeconds={quote.durationSeconds} />
      <div className="gtaPrice">
        <div className="gtaPriceValue num">
          {formatPoints(quote.cost)} <span className="statUnit">баллов</span>
        </div>
      </div>
      <button
        type="button"
        className="btn btn-primary cardAction"
        disabled={busy || expired || blockedMessage !== null}
        aria-busy={busy}
        onClick={onConfirm}
      >
        {busy && <span className="btnSpinner" aria-hidden="true" />}
        ОТПРАВИТЬ СТРИМЕРА
      </button>
      <div className={expired || blockedMessage ? 'cardFoot cardFoot--bad' : 'cardFoot'}>
        {blockedMessage ?? (expired ? 'Цена устарела. Выберите точку заново.' : <Countdown msLeft={msLeft} />)}
      </div>
    </section>
  );
}

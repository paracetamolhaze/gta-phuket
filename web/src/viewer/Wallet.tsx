/**
 * GTA$ inside the overlay: the balance chip, the top-up dialog and the toast.
 *
 * None of these hold a balance of their own. App re-reads GET /api/ext/wallet
 * and passes the number down; a realtime event only ever triggers that read.
 * The rate and the reward cost come from the server's `economy` block — the
 * admin can change both at any time, so neither is ever written in here.
 */

import { formatGta, formatGtaDelta, formatInteger } from '../shared/format';
import type { EconomyInfo, WalletTransactionType } from '../shared/types';

/** The exchange terms the dialog explains; `EconomyInfo` has every field. */
export type ExchangeOffer = Pick<
  EconomyInfo,
  'rewardTitle' | 'rewardCost' | 'gtaPerRedemption' | 'exchangeRate' | 'available'
>;

/** The two ways a viewer without a wallet identity is told what is missing. */
export const LINK_PROMPT = 'Подключите Twitch, чтобы использовать GTA$';
export const LOGIN_PROMPT = 'Войдите в Twitch, чтобы использовать GTA$';
/** The one label of every top-up button, in the chip and on the card. */
export const TOP_UP_LABEL = '+ ПОПОЛНИТЬ';
/** Shown instead of the send button when the balance cannot cover the price. */
export const INSUFFICIENT_MESSAGE = 'Недостаточно GTA$.';

/** Where the wallet read stands for the current viewer. */
export type WalletLoad = 'idle' | 'loading' | 'ready' | 'error' | 'needs_id_share' | 'needs_login';

/** A credit or refund to announce, already re-read from the server. */
export interface WalletCredit {
  transactionId: string;
  type: WalletTransactionType;
  amount: number;
  balance: number;
}

/**
 * The balance as text. A failed re-read keeps the last balance the server
 * confirmed; only a viewer who never got one sees the dash, and a first read
 * still in flight shows an ellipsis rather than a zero that is not true.
 */
export function balanceText(load: WalletLoad, balance: number | null): string {
  if (balance !== null) return formatGta(balance);
  return load === 'error' ? formatGta(null) : 'GTA$ …';
}

// ---------------------------------------------------------------------------
// chip
// ---------------------------------------------------------------------------

export interface WalletChipProps {
  load: WalletLoad;
  /** Last balance the server returned, or null before the first read. */
  balance: number | null;
  onTopUp: () => void;
  onIdShare: () => void;
}

export function WalletChip({ load, balance, onTopUp, onIdShare }: WalletChipProps) {
  if (load === 'needs_login') {
    // Logged out: the map is theirs to browse, the wallet is not. Twitch's own
    // "Log in" is the only way forward, so there is no button to press here.
    return (
      <div className="walletChip walletChip--prompt walletChip--note panel">
        <span className="walletPrompt">{LOGIN_PROMPT}</span>
      </div>
    );
  }

  if (load === 'needs_id_share') {
    return (
      <div className="walletChip walletChip--prompt panel">
        <span className="walletPrompt">{LINK_PROMPT}</span>
        <button type="button" className="walletBtn walletBtn--accent" onClick={onIdShare}>
          ПОДКЛЮЧИТЬ
        </button>
      </div>
    );
  }

  return (
    <div className="walletChip panel">
      <span className="walletBalance num" title="Ваш баланс GTA$" aria-live="polite">
        {balanceText(load, balance)}
      </span>
      <button type="button" className="walletBtn walletBtn--accent" onClick={onTopUp}>
        {TOP_UP_LABEL}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// top-up dialog
// ---------------------------------------------------------------------------

export interface TopUpDialogProps {
  /** From GET /api/ext/state → economy; null until the state has loaded. */
  offer: ExchangeOffer | null;
  /** Set once an EXCHANGE_CREDIT landed while the dialog was open. */
  credit: WalletCredit | null;
  /** The live balance, so the dialog shows what a credit changed without a reload. */
  load: WalletLoad;
  balance: number | null;
  onClose: () => void;
}

/**
 * Says where to go, never pretends to take the viewer there: an extension
 * cannot open Twitch's Rewards tray, so there is deliberately no button for it.
 */
export function TopUpDialog({ offer, credit, load, balance, onClose }: TopUpDialogProps) {
  return (
    <section className="topUp panel" role="dialog" aria-modal="false" aria-labelledby="topUpTitle">
      <div className="topUpHead">
        <div className="topUpTitle" id="topUpTitle">
          ПОПОЛНЕНИЕ GTA$
        </div>
        <button type="button" className="topUpClose" aria-label="Закрыть" onClick={onClose}>
          ×
        </button>
      </div>

      {credit && (
        <div className="topUpCredit" role="status" aria-live="polite">
          <span className="topUpCreditAmount num">{formatGtaDelta(credit.amount)}</span>
          <span className="topUpCreditNote">Зачислено</span>
        </div>
      )}

      {offer ? (
        <>
          <div className="topUpText">Используйте награду Twitch:</div>
          <div className="topUpReward">«{offer.rewardTitle}»</div>
          <div className="topUpRate num">
            {formatInteger(offer.rewardCost)} ETH → {formatGta(offer.gtaPerRedemption)}
          </div>
          <div className="topUpUnit num">1 ETH = {formatInteger(offer.exchangeRate)} GTA$</div>
          {offer.available ? (
            <div className="topUpHint">
              Награды канала открываются кнопкой баллов рядом с полем ввода чата. GTA$ придут сюда сами.
            </div>
          ) : (
            <div className="topUpHint topUpHint--bad">Обмен сейчас недоступен. Попробуйте позже.</div>
          )}
        </>
      ) : (
        <>
          <div className="topUpText">Используйте награду Twitch:</div>
          <div className="skel skel--sm" />
          <div className="skel skel--sm" />
        </>
      )}

      <div className={credit ? 'topUpBalance topUpBalance--fresh num' : 'topUpBalance num'}>
        <span>Ваш баланс:</span>
        <span className="topUpBalanceValue">{balanceText(load, balance)}</span>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// toast
// ---------------------------------------------------------------------------

export function WalletToast({ credit, placement }: { credit: WalletCredit; placement: 'map' | 'collapsed' }) {
  return (
    <div className={`walletToast walletToast--${placement} panel`} role="status" aria-live="polite">
      {credit.type === 'MISSION_REFUND' && <span className="label">Возврат за задание</span>}
      <span className="walletToastAmount num">{formatGtaDelta(credit.amount)}</span>
      <span className="walletToastBalance num">Баланс: {formatGta(credit.balance)}</span>
    </div>
  );
}

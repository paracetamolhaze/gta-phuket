/**
 * GTA$ inside the overlay: the balance chip, the top-up dialog and the toast.
 *
 * None of these hold a balance of their own. App re-reads GET /api/ext/wallet
 * and passes the number down; a realtime event only ever triggers that read.
 * The rate and the reward cost come from the server's `economy` block — the
 * admin can change both at any time, so neither is ever written in here.
 */

import { formatGta, formatGtaDelta, formatInteger } from '../shared/format';
import type { WalletTransactionType, WalletView } from '../shared/types';

/** The exchange terms; `EconomyInfo` from the state has every field of it. */
type ExchangeOffer = WalletView['exchange'];

/** The two ways a viewer without a wallet identity is told what is missing. */
export const LINK_PROMPT = 'Чтобы использовать GTA$, подключите Twitch';
export const LOGIN_PROMPT = 'Войдите в Twitch, чтобы использовать GTA$';

/** Where the wallet read stands for the current viewer. */
export type WalletLoad = 'idle' | 'loading' | 'ready' | 'error' | 'needs_id_share' | 'needs_login';

/** A credit or refund to announce, already re-read from the server. */
export interface WalletCredit {
  transactionId: string;
  type: WalletTransactionType;
  amount: number;
  balance: number;
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

  // A failed re-read keeps the last balance the server confirmed; only a
  // viewer who never got one sees the dash.
  const value = balance !== null ? formatGta(balance) : load === 'error' ? formatGta(null) : 'GTA$ …';
  return (
    <div className="walletChip panel">
      <span className="walletBalance num" title="Ваш баланс GTA$" aria-live="polite">
        {value}
      </span>
      <button type="button" className="walletBtn walletBtn--accent" onClick={onTopUp}>
        + ПОПОЛНИТЬ
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
  onClose: () => void;
}

/**
 * Says where to go, never pretends to take the viewer there: an extension
 * cannot open Twitch's Rewards tray, so there is deliberately no button for it.
 */
export function TopUpDialog({ offer, credit, onClose }: TopUpDialogProps) {
  return (
    <section className="topUp panel" role="dialog" aria-label="Пополнение GTA$">
      <div className="topUpHead">
        <div className="topUpTitle">ПОПОЛНЕНИЕ GTA$</div>
        <button type="button" className="topUpClose" aria-label="Закрыть" onClick={onClose}>
          ×
        </button>
      </div>

      {credit ? (
        <div className="topUpCredit" role="status">
          <div className="topUpCreditAmount num">{formatGtaDelta(credit.amount)}</div>
          <div className="topUpCreditBalance num">Баланс: {formatGta(credit.balance)}</div>
          <button type="button" className="btn btn-primary topUpDone" onClick={onClose}>
            Готово
          </button>
        </div>
      ) : offer ? (
        <>
          <div className="topUpText">Используйте награду Twitch:</div>
          <div className="topUpReward">«{offer.rewardTitle}»</div>
          <div className="topUpRate num">
            {formatInteger(offer.rewardCost)} ETH → {formatInteger(offer.gtaPerRedemption)} GTA$
          </div>
          {offer.available ? (
            <div className="topUpHint">Откройте награды Twitch и используйте «{offer.rewardTitle}».</div>
          ) : (
            <div className="topUpHint topUpHint--bad">
              Награда обмена сейчас недоступна на Twitch. Попробуйте позже.
            </div>
          )}
        </>
      ) : (
        <>
          <div className="topUpText">Используйте награду Twitch:</div>
          <div className="skel skel--sm" />
          <div className="skel skel--sm" />
        </>
      )}
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

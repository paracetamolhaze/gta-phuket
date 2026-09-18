import { query } from '../db/pool.js';
import { logger } from '../logger.js';
import { K } from '../redis/keys.js';
import { tryAcquireLock, withLock } from '../redis/lock.js';
import { emitToViewer } from '../realtime/bus.js';
import { getSettings, saveSettings, type SettingsPatch } from '../domain/settings.js';
import {
  creditExchange,
  listPendingFulfillments,
  recordFulfillment,
  recordFulfillmentFailure,
} from '../domain/wallet.js';
import {
  AppError,
  type ChannelSettings,
  type EconomyInfo,
  type FulfillmentStatus,
  type RedemptionEvent,
} from '../domain/types.js';
import {
  createCustomReward,
  getCustomReward,
  getRedemption,
  listManagedRewards,
  twitchStatusOf,
  updateCustomReward,
  updateRedemptionStatus,
  type CustomReward,
  type UpdateRewardInput,
} from './helix.js';

/**
 * The one real Channel Points reward of the GTA$ economy.
 *
 * Viewers redeem «Обмен ETH на GTA DOLLAR» in Twitch's own Rewards UI; the
 * EventSub notification credits their wallet, and only then is the redemption
 * marked FULFILLED. It is created with our own client id and the broadcaster
 * token, which is what lets this backend fulfil its redemptions at all.
 */

export const EXCHANGE_REWARD_TITLE = 'Обмен ETH на GTA DOLLAR';
export const EXCHANGE_REWARD_COLOR = '#1FA35C';

export function exchangePrompt(rate: number): string {
  return (
    `Обменять ETH на GTA$ по курсу 1 ETH = ${rate} GTA$. ` +
    'GTA$ зачисляются на ваш кошелёк в карте GTA Phuket.'
  );
}

export interface ExchangeRewardRecord {
  channelId: string;
  twitchRewardId: string;
  title: string;
  cost: number;
}

export async function getExchangeReward(channelId: string): Promise<ExchangeRewardRecord | null> {
  const { rows } = await query<{ twitch_reward_id: string; title: string; cost: number }>(
    'SELECT twitch_reward_id, title, cost FROM gta_exchange_rewards WHERE channel_id = $1',
    [channelId],
  );
  const row = rows[0];
  return row
    ? { channelId, twitchRewardId: row.twitch_reward_id, title: row.title, cost: row.cost }
    : null;
}

async function storeExchangeReward(channelId: string, reward: CustomReward): Promise<void> {
  await query(
    `INSERT INTO gta_exchange_rewards (channel_id, twitch_reward_id, title, cost)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (channel_id) DO UPDATE
       SET twitch_reward_id = EXCLUDED.twitch_reward_id,
           title = EXCLUDED.title,
           cost = EXCLUDED.cost,
           updated_at = now()`,
    [channelId, reward.id, reward.title, reward.cost],
  );
}

/** Exchange terms as the extension shows them. */
export async function getEconomyInfo(
  channelId: string,
  settings?: ChannelSettings,
): Promise<EconomyInfo> {
  const current = settings ?? (await getSettings(channelId));
  const reward = await getExchangeReward(channelId);
  // What Twitch actually charges is the stored reward's cost; the setting is
  // only the target until a sync has pushed it.
  const rewardCost = reward?.cost ?? current.exchangeRewardCost;
  return {
    symbol: 'GTA$',
    exchangeRate: current.gtaDollarsPerChannelPoint,
    rewardTitle: reward?.title ?? EXCHANGE_REWARD_TITLE,
    rewardCost,
    gtaPerRedemption: rewardCost * current.gtaDollarsPerChannelPoint,
    available: reward !== null,
  };
}

// ---------------------------------------------------------------------------
// Create / reconcile
// ---------------------------------------------------------------------------

export interface EnsureExchangeRewardResult {
  action: 'created' | 'adopted' | 'updated' | 'unchanged';
  reward: { id: string; title: string; cost: number; isEnabled: boolean };
}

interface WantedTerms {
  title: string;
  cost: number;
  prompt: string;
}

function wantedTerms(settings: ChannelSettings): WantedTerms {
  return {
    title: EXCHANGE_REWARD_TITLE,
    cost: settings.exchangeRewardCost,
    prompt: exchangePrompt(settings.gtaDollarsPerChannelPoint),
  };
}

/**
 * Bring the live reward in line with the settings. The prompt states the
 * rate, so it is kept in step with it as well as cost, title and enabled.
 */
async function reconcile(
  channelId: string,
  live: CustomReward,
  wanted: WantedTerms,
  action: EnsureExchangeRewardResult['action'],
): Promise<EnsureExchangeRewardResult> {
  const patch: UpdateRewardInput = {};
  if (live.title !== wanted.title) patch.title = wanted.title;
  if (live.cost !== wanted.cost) patch.cost = wanted.cost;
  if (live.prompt !== wanted.prompt) patch.prompt = wanted.prompt;
  if (!live.is_enabled) patch.isEnabled = true;

  let current = live;
  if (Object.keys(patch).length > 0) {
    current = await updateCustomReward(channelId, live.id, patch);
    if (action === 'unchanged') action = 'updated';
  }
  await storeExchangeReward(channelId, current);
  return {
    action,
    reward: { id: current.id, title: current.title, cost: current.cost, isEnabled: current.is_enabled },
  };
}

/**
 * Make sure the channel has exactly our one exchange reward, as configured.
 *
 *  1. Known id → read it back and reconcile it.
 *  2. Unknown (or deleted on Twitch) → create it.
 *  3. Twitch refuses the create as a duplicate title → only then look for it
 *     by title, among the rewards our own client id manages, and adopt it.
 *     That is the one place a reward is ever identified by title.
 *
 * Called at boot, after the broadcaster OAuth callback and from the admin.
 */
export async function ensureExchangeReward(channelId: string): Promise<EnsureExchangeRewardResult> {
  return withLock(
    K.lockExchangeReward(channelId),
    async () => {
      const settings = await getSettings(channelId);
      const wanted = wantedTerms(settings);

      const stored = await getExchangeReward(channelId);
      if (stored) {
        const live = await getCustomReward(channelId, stored.twitchRewardId);
        if (live) return reconcile(channelId, live, wanted, 'unchanged');
        // Deleted in the Twitch dashboard. The row goes too, so the extension
        // stops offering an exchange that cannot happen until it is recreated.
        logger.warn(
          { channelId, rewardId: stored.twitchRewardId },
          'exchange reward is gone from Twitch, creating it again',
        );
        await query('DELETE FROM gta_exchange_rewards WHERE channel_id = $1', [channelId]);
      }

      let reward: CustomReward;
      let action: EnsureExchangeRewardResult['action'] = 'created';
      try {
        reward = await createCustomReward(channelId, {
          title: wanted.title,
          cost: wanted.cost,
          prompt: wanted.prompt,
          isEnabled: true,
          backgroundColor: EXCHANGE_REWARD_COLOR,
        });
        logger.info({ channelId, rewardId: reward.id }, 'exchange reward created');
      } catch (err) {
        if (twitchStatusOf(err) !== 400) throw err;
        const mine = (await listManagedRewards(channelId)).find((r) => r.title === wanted.title);
        if (!mine) throw err;
        reward = mine;
        action = 'adopted';
        logger.info({ channelId, rewardId: reward.id }, 'existing exchange reward adopted');
      }

      await storeExchangeReward(channelId, reward);
      return reconcile(channelId, reward, wanted, action);
    },
    { ttlMs: 30_000, waitMs: 15_000 },
  );
}

/**
 * Save a settings patch, pushing any change to the exchange terms to Twitch
 * first. Every admin save of settings goes through here.
 *
 * A patch that touches the terms runs under the same lock as
 * ensureExchangeReward. Otherwise a sync that read the reward before this
 * save could store its stale snapshot over the new cost (and the map would
 * quote viewers the old price), or PATCH Twitch back to the old cost once it
 * saw the new one. Settings are re-read inside the lock for the same reason.
 */
export async function saveSettingsWithExchangeTerms(
  channelId: string,
  patch: SettingsPatch,
): Promise<ChannelSettings> {
  const touchesTerms =
    patch.exchangeRewardCost !== undefined || patch.gtaDollarsPerChannelPoint !== undefined;
  if (!touchesTerms) return saveSettings(channelId, patch);

  return withLock(
    K.lockExchangeReward(channelId),
    async () => {
      const before = await getSettings(channelId);
      await pushExchangeTerms(channelId, before, { ...before, ...patch });
      return saveSettings(channelId, patch);
    },
    {
      ttlMs: 30_000,
      waitMs: 15_000,
      onBusy: () =>
        new AppError('rate_limited', 'Награда обмена сейчас синхронизируется. Повторите через минуту', 429),
    },
  );
}

/**
 * Push changed exchange terms to Twitch before they are saved. Only ever
 * called under the exchange reward lock, by saveSettingsWithExchangeTerms.
 *
 * A cost Twitch refuses must not be saved, or the map would promise viewers a
 * price the reward does not charge: that error is thrown, and the caller
 * saves nothing. A rate change only rewrites the prompt; if that PATCH fails
 * the rate is still saved (credits read it at processing time) and the next
 * sync repairs the prompt.
 */
async function pushExchangeTerms(
  channelId: string,
  before: ChannelSettings,
  next: ChannelSettings,
): Promise<void> {
  const costChanged = next.exchangeRewardCost !== before.exchangeRewardCost;
  const rateChanged = next.gtaDollarsPerChannelPoint !== before.gtaDollarsPerChannelPoint;
  if (!costChanged && !rateChanged) return;

  const stored = await getExchangeReward(channelId);
  // Nothing on Twitch yet: the first ensureExchangeReward creates it at the new terms.
  if (!stored) return;

  try {
    const updated = await updateCustomReward(channelId, stored.twitchRewardId, {
      cost: next.exchangeRewardCost,
      prompt: exchangePrompt(next.gtaDollarsPerChannelPoint),
    });
    await storeExchangeReward(channelId, updated);
  } catch (err) {
    if (costChanged) throw err;
    logger.warn({ err, channelId }, 'exchange reward prompt not updated on Twitch');
  }
}

// ---------------------------------------------------------------------------
// Redemption → credit → fulfil
// ---------------------------------------------------------------------------

export async function getExchangeRewardId(channelId: string): Promise<string | null> {
  return (await getExchangeReward(channelId))?.twitchRewardId ?? null;
}

export type ExchangeOutcome =
  | { result: 'credited'; transactionId: string; amount: number; balance: number }
  | { result: 'duplicate' }
  | { result: 'ignored'; reason: string };

/**
 * Credit one exchange redemption.
 *
 * The amount is what Twitch actually charged times the rate at processing
 * time, never anything the viewer said. If the credit transaction throws, it
 * throws out of here: nothing is fulfilled, the stored EventSub event stays
 * unprocessed and the existing retry machinery runs it again — which is safe,
 * because the redemption id is unique in the ledger.
 */
export async function creditExchangeRedemption(
  channelId: string,
  event: RedemptionEvent,
): Promise<ExchangeOutcome> {
  if (!/^[0-9]{1,20}$/.test(event.userId)) {
    logger.warn({ redemption: event.redemptionId }, 'exchange redemption without a numeric user id');
    return { result: 'ignored', reason: 'redemption has no numeric user id' };
  }
  if (!Number.isSafeInteger(event.rewardCost) || event.rewardCost <= 0) {
    logger.warn({ redemption: event.redemptionId, cost: event.rewardCost }, 'exchange redemption with a bad cost');
    return { result: 'ignored', reason: 'redemption cost is not a positive integer' };
  }

  const settings = await getSettings(channelId);
  const amount = event.rewardCost * settings.gtaDollarsPerChannelPoint;

  const credit = await creditExchange({
    channelId,
    twitchUserId: event.userId,
    redemptionId: event.redemptionId,
    rewardId: event.rewardId,
    channelPointsCost: event.rewardCost,
    amount,
    metadata: { rate: settings.gtaDollarsPerChannelPoint, redeemedAt: event.redeemedAt },
  });
  if (credit.outcome === 'duplicate') return { result: 'duplicate' };

  logger.info(
    { user: event.userId, redemption: event.redemptionId, amount, balance: credit.balance },
    'GTA$ exchange credited',
  );

  // Committed. From here on nothing may throw: the credit stands whatever
  // Twitch says, and a failed fulfilment is the retry sweep's job.
  emitToViewer(channelId, event.userId, 'wallet:updated', {
    type: 'EXCHANGE_CREDIT',
    amount,
    balance: credit.balance,
    transactionId: credit.transactionId,
  });
  await fulfilExchangeCredit({
    id: credit.transactionId,
    channelId,
    twitchRewardId: event.rewardId,
    twitchRedemptionId: event.redemptionId,
  });

  return {
    result: 'credited',
    transactionId: credit.transactionId,
    amount,
    balance: credit.balance,
  };
}

/**
 * Tell Twitch to keep the ETH of a committed credit. Never throws.
 *
 * A 400/404 is ambiguous — already FULFILLED, or cancelled by a moderator in
 * the request queue — so it is settled by reading the redemption back. A
 * cancelled one is recorded as CANCELED_EXTERNALLY for the admin; its GTA$ are
 * not clawed back automatically.
 */
export async function fulfilExchangeCredit(tx: {
  id: string;
  channelId: string;
  twitchRewardId: string | null;
  twitchRedemptionId: string | null;
}): Promise<FulfillmentStatus | null> {
  if (!tx.twitchRewardId || !tx.twitchRedemptionId) return null;
  const { channelId, twitchRewardId: rewardId, twitchRedemptionId: redemptionId } = tx;

  try {
    try {
      await updateRedemptionStatus(channelId, rewardId, redemptionId, 'FULFILLED');
      await recordFulfillment(tx.id, 'FULFILLED');
      return 'FULFILLED';
    } catch (err) {
      const status = twitchStatusOf(err);
      if (status === 400 || status === 404) {
        const current = await getRedemption(channelId, rewardId, redemptionId).catch(() => null);
        if (current?.status === 'FULFILLED') {
          await recordFulfillment(tx.id, 'FULFILLED');
          return 'FULFILLED';
        }
        if (current?.status === 'CANCELED') {
          await recordFulfillment(tx.id, 'CANCELED_EXTERNALLY');
          logger.warn(
            { redemption: redemptionId, transactionId: tx.id },
            'exchange redemption was canceled on Twitch after the GTA$ credit — needs a look',
          );
          return 'CANCELED_EXTERNALLY';
        }
      }

      const failure = await recordFulfillmentFailure(
        tx.id,
        err instanceof Error ? err.message : String(err),
      );
      logger.warn(
        { err, redemption: redemptionId, attempts: failure?.attempts },
        failure?.status === 'FAILED'
          ? 'exchange redemption could not be fulfilled — giving up, needs a look'
          : 'exchange redemption not fulfilled yet, will retry',
      );
      return failure?.status ?? null;
    }
  } catch (err) {
    // Bookkeeping itself failed (database). The row stays PENDING and the
    // sweep tries again; the credit is not affected either way.
    logger.error({ err, transactionId: tx.id }, 'fulfilment bookkeeping failed');
    return null;
  }
}

/**
 * The maintenance sweep: retry fulfilment of committed credits that Twitch has
 * not acknowledged. One sweep at a time; a busy lock just skips this round.
 */
export async function retryPendingFulfillments(
  channelId: string,
  minAgeSeconds = 30,
  limit = 20,
): Promise<number> {
  const lock = await tryAcquireLock(K.lockFulfillment(channelId), 120_000);
  if (!lock) return 0;
  try {
    const due = await listPendingFulfillments(channelId, minAgeSeconds, limit);
    for (const tx of due) await fulfilExchangeCredit(tx);
    return due.length;
  } finally {
    await lock.release();
  }
}

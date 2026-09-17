import { query, withTransaction } from '../db/pool.js';
import { logger } from '../logger.js';
import { K } from '../redis/keys.js';
import { withLock } from '../redis/lock.js';
import { releaseSlotReward, rowToSlot, type SlotRow } from '../twitch/rewards.js';
import { AppError, type RewardSlot } from './types.js';

/**
 * Leasing a slot has two layers on purpose:
 *
 *  - Postgres `FOR UPDATE SKIP LOCKED` is what actually makes the lease
 *    atomic, even across API processes and even if Redis is restarted.
 *  - A short Redis lock serialises the Twitch API call that follows, so two
 *    workers do not PATCH rewards at the same instant and trip rate limits.
 */

export async function countFreeSlots(
  channelId: string,
  poolSize: number,
): Promise<{ free: number; total: number }> {
  const { rows } = await query<{ free: string; total: string }>(
    `SELECT
       count(*) FILTER (WHERE status = 'FREE') AS free,
       count(*) AS total
     FROM twitch_reward_slots
     WHERE channel_id = $1 AND slot_index <= $2`,
    [channelId, poolSize],
  );
  const row = rows[0];
  return { free: Number(row?.free ?? 0), total: Number(row?.total ?? 0) };
}

/** Atomically take one FREE slot, or return null when the pool is exhausted. */
export async function leaseSlot(
  channelId: string,
  quoteId: string,
  userId: string,
  poolSize: number,
): Promise<RewardSlot | null> {
  return withLock(
    K.lockSlots(channelId),
    async () =>
      withTransaction(async (client) => {
        const { rows } = await client.query<SlotRow>(
          `UPDATE twitch_reward_slots
             SET status = 'RESERVED',
                 quote_id = $2,
                 reserved_for_user = $3,
                 reserved_at = now(),
                 updated_at = now()
           WHERE id = (
             SELECT id FROM twitch_reward_slots
              WHERE channel_id = $1
                AND status = 'FREE'
                AND slot_index <= $4
              ORDER BY slot_index
              FOR UPDATE SKIP LOCKED
              LIMIT 1
           )
           RETURNING *`,
          [channelId, quoteId, userId, poolSize],
        );
        const row = rows[0];
        return row ? rowToSlot(row) : null;
      }),
    {
      ttlMs: 10_000,
      waitMs: 4000,
      onBusy: () =>
        new AppError('no_free_slots', 'Сейчас слишком много запросов. Попробуй через несколько секунд', 503),
    },
  );
}

export async function getSlot(slotId: string): Promise<RewardSlot | null> {
  const { rows } = await query<SlotRow>('SELECT * FROM twitch_reward_slots WHERE id = $1', [slotId]);
  const row = rows[0];
  return row ? rowToSlot(row) : null;
}

export async function findSlotByRewardId(
  channelId: string,
  rewardId: string,
): Promise<RewardSlot | null> {
  const { rows } = await query<SlotRow>(
    'SELECT * FROM twitch_reward_slots WHERE channel_id = $1 AND twitch_reward_id = $2',
    [channelId, rewardId],
  );
  const row = rows[0];
  return row ? rowToSlot(row) : null;
}

/** Mark the slot free in the database. Does not talk to Twitch. */
export async function markSlotFree(slotId: string): Promise<void> {
  await query(
    `UPDATE twitch_reward_slots
       SET status = 'FREE', quote_id = NULL, reserved_for_user = NULL,
           reserved_at = NULL, enabled = FALSE, updated_at = now()
     WHERE id = $1`,
    [slotId],
  );
}

export async function markSlotConsumed(slotId: string): Promise<void> {
  await query(
    `UPDATE twitch_reward_slots SET status = 'CONSUMED', enabled = FALSE, updated_at = now()
     WHERE id = $1`,
    [slotId],
  );
}

/**
 * Take a slot out of the viewer's reward list and hand it back to the pool.
 * A Twitch failure still frees the slot locally (it is flagged BROKEN by
 * releaseSlotReward) so one API hiccup cannot permanently shrink the pool.
 */
export async function releaseSlot(
  channelId: string,
  slot: RewardSlot,
  reason: string,
): Promise<void> {
  try {
    await releaseSlotReward(channelId, slot);
    await markSlotFree(slot.id);
  } catch (err) {
    logger.warn({ err, slotId: slot.id, reason }, 'slot release degraded');
    await query(
      `UPDATE twitch_reward_slots
         SET quote_id = NULL, reserved_for_user = NULL, reserved_at = NULL, updated_at = now()
       WHERE id = $1`,
      [slot.id],
    );
  }
}

export async function listReservedSlots(channelId: string): Promise<RewardSlot[]> {
  const { rows } = await query<SlotRow>(
    `SELECT * FROM twitch_reward_slots WHERE channel_id = $1 AND status = 'RESERVED' ORDER BY slot_index`,
    [channelId],
  );
  return rows.map(rowToSlot);
}

/** Free every reserved slot except one — used the moment a waypoint activates. */
export async function releaseAllReservedExcept(
  channelId: string,
  keepSlotId: string | null,
): Promise<RewardSlot[]> {
  const reserved = await listReservedSlots(channelId);
  const toRelease = reserved.filter((s) => s.id !== keepSlotId);
  for (const slot of toRelease) {
    await releaseSlot(channelId, slot, 'another waypoint became active');
  }
  return toRelease;
}

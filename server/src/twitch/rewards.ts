import { randomUUID } from 'node:crypto';
import { query } from '../db/pool.js';
import { logger } from '../logger.js';
import { AppError, type RewardSlot } from '../domain/types.js';
import { TWITCH_MAX_COST, TWITCH_MIN_COST } from '../domain/pricing.js';
import {
  createCustomReward,
  listManagedRewards,
  updateCustomReward,
  type CustomReward,
} from './helix.js';

/**
 * Twitch has no "charge this viewer N points" API, so the only way to take
 * Channel Points is to put a Custom Reward in front of the viewer at exactly
 * the right price. Rewards are a limited, slow-to-create resource, so the app
 * keeps a small pool and rewrites its titles and costs instead of creating a
 * reward per request.
 */

export const SLOT_TITLE_PREFIX = 'IRL WAYPOINT';
export const IDLE_PROMPT =
  'Этой наградой управляет карта на стриме. Выбери точку на карте — она включится сама.';

export function idleTitle(index: number): string {
  return `${SLOT_TITLE_PREFIX} ${String(index).padStart(2, '0')}`;
}

export function activeTitle(code: string): string {
  return `WAYPOINT • ${code}`;
}

export interface SlotRow {
  id: string;
  channel_id: string;
  slot_index: number;
  twitch_reward_id: string;
  status: string;
  quote_id: string | null;
  reserved_for_user: string | null;
  current_title: string;
  current_cost: number;
  enabled: boolean;
  updated_at: Date;
}

export function rowToSlot(row: SlotRow): RewardSlot {
  return {
    id: row.id,
    channelId: row.channel_id,
    index: row.slot_index,
    twitchRewardId: row.twitch_reward_id,
    status: row.status as RewardSlot['status'],
    quoteId: row.quote_id,
    reservedForUserId: row.reserved_for_user,
    currentTitle: row.current_title,
    currentCost: row.current_cost,
    enabled: row.enabled,
    updatedAt: row.updated_at.getTime(),
  };
}

export async function listSlots(channelId: string): Promise<RewardSlot[]> {
  const { rows } = await query<SlotRow>(
    'SELECT * FROM twitch_reward_slots WHERE channel_id = $1 ORDER BY slot_index',
    [channelId],
  );
  return rows.map(rowToSlot);
}

/**
 * Bring the pool in line with `poolSize`.
 *
 * Existing rewards are matched by title so a restart (or a re-run after a crash
 * mid-create) adopts what is already on the channel instead of duplicating it.
 * Rewards are never deleted automatically: shrinking the pool only disables the
 * extra slots, because deleting a reward also deletes its redemption history.
 */
export async function ensureRewardPool(
  channelId: string,
  poolSize: number,
): Promise<{
  created: number;
  updated: number;
  total: number;
  rewardsCreated: number;
  recovered: number;
}> {
  const size = Math.max(1, Math.min(40, Math.trunc(poolSize)));

  let existing: CustomReward[] = [];
  try {
    existing = await listManagedRewards(channelId);
  } catch (err) {
    logger.warn({ err, channelId }, 'could not list managed rewards');
    throw err;
  }

  const byTitle = new Map(existing.map((r) => [r.title, r]));
  const dbSlots = await listSlots(channelId);
  const byIndex = new Map(dbSlots.map((s) => [s.index, s]));
  const knownRewardIds = new Set(existing.map((r) => r.id));

  let created = 0;
  let updated = 0;
  let rewardsCreated = 0;
  let recovered = 0;

  for (let index = 1; index <= size; index += 1) {
    const title = idleTitle(index);
    const slot = byIndex.get(index);

    // Reuse the reward Twitch already has under this title, if any.
    let reward = byTitle.get(title) ?? null;
    if (!reward && slot && knownRewardIds.has(slot.twitchRewardId)) {
      reward = existing.find((r) => r.id === slot.twitchRewardId) ?? null;
    }

    if (!reward) {
      reward = await createCustomReward(channelId, {
        title,
        cost: TWITCH_MIN_COST,
        prompt: IDLE_PROMPT,
        isEnabled: false,
        backgroundColor: '#FFC247',
      });
      rewardsCreated += 1;
      logger.info({ channelId, index, rewardId: reward.id }, 'twitch reward created');
    }

    if (slot) {
      if (slot.twitchRewardId !== reward.id) {
        await query(
          `UPDATE twitch_reward_slots
             SET twitch_reward_id = $1, current_title = $2, updated_at = now()
           WHERE id = $3`,
          [reward.id, reward.title, slot.id],
        );
        updated += 1;
      }
    } else {
      await query(
        `INSERT INTO twitch_reward_slots
           (id, channel_id, slot_index, twitch_reward_id, status, current_title, current_cost, enabled)
         VALUES ($1, $2, $3, $4, 'FREE', $5, $6, $7)
         ON CONFLICT (channel_id, slot_index) DO UPDATE
           SET twitch_reward_id = EXCLUDED.twitch_reward_id, updated_at = now()`,
        [randomUUID(), channelId, index, reward.id, reward.title, reward.cost, reward.is_enabled],
      );
      created += 1;
    }
  }

  // Slots stuck in BROKEN or CONSUMED (a Twitch call failed while releasing
  // them) would otherwise shrink the pool forever. Anything not attached to a
  // live quote is pushed back to Twitch and returned to the pool.
  const stuck = (await listSlots(channelId)).filter(
    (s) => s.index <= size && (s.status === 'BROKEN' || s.status === 'CONSUMED'),
  );
  for (const slot of stuck) {
    const { rows } = await query<{ id: string }>(
      `SELECT id FROM waypoint_quotes
        WHERE slot_id = $1 AND status IN ('QUOTED', 'AWAITING_REDEMPTION')
        LIMIT 1`,
      [slot.id],
    );
    if (rows.length) continue;
    try {
      await releaseSlotReward(channelId, slot);
      await query(
        `UPDATE twitch_reward_slots
            SET status = 'FREE', quote_id = NULL, reserved_for_user = NULL,
                reserved_at = NULL, enabled = FALSE, updated_at = now()
          WHERE id = $1`,
        [slot.id],
      );
      recovered += 1;
      logger.info({ channelId, index: slot.index }, 'reward slot recovered');
    } catch (err) {
      logger.warn({ err, slotId: slot.id }, 'could not recover slot');
    }
  }

  // Slots above the new size stop being offered but keep their history.
  const extra = dbSlots.filter((s) => s.index > size);
  for (const slot of extra) {
    if (slot.status === 'RESERVED') continue; // let the in-flight quote finish
    await releaseSlotReward(channelId, slot).catch((err) => {
      logger.warn({ err, slotId: slot.id }, 'could not disable extra slot');
    });
  }

  return { created, updated, total: size, rewardsCreated, recovered };
}

/**
 * Point a slot at a concrete quote: right title, right price, visible to viewers.
 * Nothing is charged here — Twitch charges when the viewer redeems it.
 */
export async function activateSlotReward(
  channelId: string,
  slot: RewardSlot,
  code: string,
  cost: number,
  destinationName: string,
): Promise<void> {
  const safeCost = Math.max(TWITCH_MIN_COST, Math.min(TWITCH_MAX_COST, Math.trunc(cost)));
  if (safeCost !== Math.trunc(cost)) {
    throw new AppError('internal', `Cost ${cost} is outside the range Twitch accepts`, 500);
  }

  const title = activeTitle(code);
  await updateCustomReward(channelId, slot.twitchRewardId, {
    title,
    cost: safeCost,
    prompt: `Отправить стримера сюда: ${destinationName}`.slice(0, 200),
    isEnabled: true,
    isPaused: false,
  });

  await query(
    `UPDATE twitch_reward_slots
       SET current_title = $1, current_cost = $2, enabled = TRUE, updated_at = now()
     WHERE id = $3`,
    [title, safeCost, slot.id],
  );
}

/** Take a slot back out of the viewer's reward list. */
export async function releaseSlotReward(channelId: string, slot: RewardSlot): Promise<void> {
  const title = idleTitle(slot.index);
  try {
    await updateCustomReward(channelId, slot.twitchRewardId, {
      title,
      cost: TWITCH_MIN_COST,
      prompt: IDLE_PROMPT,
      isEnabled: false,
      isPaused: true,
    });
  } catch (err) {
    // The slot must still be marked free locally, otherwise a Twitch hiccup
    // permanently shrinks the pool. It is re-synced by /api/admin/slots/sync.
    logger.warn({ err, slotId: slot.id }, 'could not disable reward on Twitch');
    await query(
      `UPDATE twitch_reward_slots SET status = 'BROKEN', updated_at = now() WHERE id = $1`,
      [slot.id],
    );
    throw err;
  }

  await query(
    `UPDATE twitch_reward_slots
       SET current_title = $1, current_cost = $2, enabled = FALSE, updated_at = now()
     WHERE id = $3`,
    [title, TWITCH_MIN_COST, slot.id],
  );
}

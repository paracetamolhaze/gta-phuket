import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { query, withTransaction } from '../db/pool.js';
import { redis } from '../redis/client.js';
import { K } from '../redis/keys.js';
import { withLock } from '../redis/lock.js';
import { emitRealtime } from '../realtime/bus.js';
import { getSettings } from '../domain/settings.js';
import { sanitizeRouteGeometry } from '../domain/privacy.js';
import { getQuote, getQuoteBySlot, setQuoteStatus } from '../domain/quotes.js';
import {
  findSlotByRewardId,
  markSlotFree,
  releaseAllReservedExcept,
  releaseSlot,
} from '../domain/slots.js';
import {
  getActiveWaypoint,
  insertActiveWaypoint,
  primeLiveNav,
  toView,
} from '../domain/waypoints.js';
import type { ActiveWaypointView, RedemptionEvent } from '../domain/types.js';
import {
  createEventSubSubscription,
  deleteEventSubSubscription,
  listEventSubSubscriptions,
  updateRedemptionStatus,
} from './helix.js';
import { releaseSlotReward } from './rewards.js';

export const MESSAGE_TYPE_HEADER = 'twitch-eventsub-message-type';
export const MESSAGE_ID_HEADER = 'twitch-eventsub-message-id';
export const MESSAGE_TIMESTAMP_HEADER = 'twitch-eventsub-message-timestamp';
export const MESSAGE_SIGNATURE_HEADER = 'twitch-eventsub-message-signature';
export const SUBSCRIPTION_TYPE_HEADER = 'twitch-eventsub-subscription-type';

export const REDEMPTION_ADD = 'channel.channel_points_custom_reward_redemption.add';
export const REDEMPTION_UPDATE = 'channel.channel_points_custom_reward_redemption.update';

/** Twitch rejects replays older than 10 minutes; so do we. */
const MAX_MESSAGE_AGE_MS = 10 * 60 * 1000;
const DEDUPE_TTL_SECONDS = 15 * 60;

export interface EventSubHeaders {
  messageId: string;
  messageType: string;
  timestamp: string;
  signature: string;
  subscriptionType?: string;
}

export function readEventSubHeaders(
  headers: Record<string, string | string[] | undefined>,
): EventSubHeaders | null {
  const pick = (name: string): string => {
    const raw = headers[name];
    return Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
  };
  const out: EventSubHeaders = {
    messageId: pick(MESSAGE_ID_HEADER),
    messageType: pick(MESSAGE_TYPE_HEADER),
    timestamp: pick(MESSAGE_TIMESTAMP_HEADER),
    signature: pick(MESSAGE_SIGNATURE_HEADER),
    subscriptionType: pick(SUBSCRIPTION_TYPE_HEADER) || undefined,
  };
  if (!out.messageId || !out.messageType || !out.timestamp || !out.signature) return null;
  return out;
}

export function computeSignature(
  messageId: string,
  timestamp: string,
  rawBody: Buffer | string,
  secret = env.TWITCH_EVENTSUB_SECRET,
): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(messageId);
  hmac.update(timestamp);
  hmac.update(rawBody);
  return `sha256=${hmac.digest('hex')}`;
}

export function verifySignature(
  headers: EventSubHeaders,
  rawBody: Buffer | string,
  secret = env.TWITCH_EVENTSUB_SECRET,
): boolean {
  const ts = Date.parse(headers.timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_MESSAGE_AGE_MS) return false;

  const expected = computeSignature(headers.messageId, headers.timestamp, rawBody, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(headers.signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Two-layer idempotency. Redis answers the hot path; the table survives a
 * Redis flush, so a redelivery hours later still cannot create a second
 * waypoint. Returns true when this message has not been handled before.
 */
export async function claimMessage(
  messageId: string,
  subscriptionType: string,
  channelId: string | null,
  payload: unknown,
): Promise<boolean> {
  const fresh = await redis.set(K.eventSeen(messageId), '1', 'EX', DEDUPE_TTL_SECONDS, 'NX');
  if (fresh !== 'OK') return false;

  try {
    const { rowCount } = await query(
      `INSERT INTO eventsub_events (message_id, subscription_type, channel_id, payload)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (message_id) DO NOTHING`,
      [messageId, subscriptionType, channelId, JSON.stringify(payload)],
    );
    return (rowCount ?? 0) > 0;
  } catch (err) {
    // If the durable record cannot be written, drop the Redis marker so the
    // retry Twitch is guaranteed to send is not silently swallowed.
    await redis.del(K.eventSeen(messageId));
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Redemption handling
// ---------------------------------------------------------------------------

export type RedemptionOutcome =
  | { result: 'activated'; waypointId: string; quoteId: string }
  | { result: 'refunded'; reason: string; quoteId: string | null }
  | { result: 'ignored'; reason: string }
  | { result: 'duplicate' };

interface RawRedemption {
  id: string;
  broadcaster_user_id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  user_input: string;
  status: string;
  redeemed_at: string;
  reward: { id: string; title: string; cost: number; prompt: string };
}

export function parseRedemption(eventId: string, raw: unknown): RedemptionEvent | null {
  const e = raw as Partial<RawRedemption> | undefined;
  if (!e || typeof e.id !== 'string' || !e.reward || typeof e.reward.id !== 'string') return null;
  return {
    eventId,
    redemptionId: e.id,
    broadcasterUserId: String(e.broadcaster_user_id ?? ''),
    userId: String(e.user_id ?? ''),
    userLogin: String(e.user_login ?? ''),
    userName: String(e.user_name ?? ''),
    rewardId: e.reward.id,
    rewardTitle: String(e.reward.title ?? ''),
    rewardCost: Number(e.reward.cost ?? 0),
    userInput: String(e.user_input ?? ''),
    status: String(e.status ?? ''),
    redeemedAt: String(e.redeemed_at ?? new Date().toISOString()),
  };
}

async function recordRedemption(input: {
  event: RedemptionEvent;
  channelId: string;
  slotId: string | null;
  quoteId: string | null;
  resolution: string;
  reason: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO twitch_redemptions
       (id, channel_id, reward_id, slot_id, quote_id, twitch_user_id, twitch_user_name,
        cost, resolution, reason, redeemed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (id) DO NOTHING`,
    [
      input.event.redemptionId,
      input.channelId,
      input.event.rewardId,
      input.slotId,
      input.quoteId,
      input.event.userId,
      input.event.userName || input.event.userLogin || null,
      input.event.rewardCost,
      input.resolution,
      input.reason,
      input.event.redeemedAt,
    ],
  );
}

/**
 * Give the points back. Only possible while the redemption is UNFULFILLED.
 * Returns false when Twitch refused, so the caller records the truth instead of
 * telling the viewer they were refunded when they were not.
 */
async function refund(
  channelId: string,
  event: RedemptionEvent,
  reason: string,
): Promise<boolean> {
  try {
    await updateRedemptionStatus(channelId, event.rewardId, event.redemptionId, 'CANCELED');
    logger.info({ reason, user: event.userId, redemption: event.redemptionId }, 'redemption refunded');
    emitRealtime(channelId, 'reward:refunded', { quoteId: null, userId: event.userId, reason });
    return true;
  } catch (err) {
    // Recorded as FAILED for the admin retry rather than silently written off.
    logger.error({ err, redemption: event.redemptionId }, 'refund failed, points are still spent');
    return false;
  }
}

/**
 * The single place a waypoint can become ACTIVE.
 *
 * Nothing here trusts the extension: the quote, its price, its owner and its
 * deadline all come from our own database, and the fact of payment comes from
 * a signature-verified Twitch event.
 */
export async function handleRedemption(event: RedemptionEvent): Promise<RedemptionOutcome> {
  const channelId = event.broadcasterUserId || env.TWITCH_CHANNEL_ID;

  if (env.TWITCH_CHANNEL_ID && channelId !== env.TWITCH_CHANNEL_ID) {
    return { result: 'ignored', reason: 'redemption for another channel' };
  }

  // A second delivery of the same redemption must never do work twice.
  const firstTime = await redis.set(
    K.redemptionSeen(event.redemptionId),
    '1',
    'EX',
    DEDUPE_TTL_SECONDS,
    'NX',
  );
  if (firstTime !== 'OK') return { result: 'duplicate' };

  const slot = await findSlotByRewardId(channelId, event.rewardId);
  if (!slot) {
    // Someone else's reward on the same channel. Not ours to fulfil or refund.
    return { result: 'ignored', reason: 'reward is not part of the waypoint pool' };
  }

  const settings = await getSettings(channelId);

  return withLock(
    K.lockActivation(channelId),
    async (): Promise<RedemptionOutcome> => {
      const quote =
        (slot.quoteId ? await getQuote(slot.quoteId) : null) ?? (await getQuoteBySlot(slot.id));

      /**
       * `releaseQuote` separates "this redemption killed the quote" from
       * "a stranger grabbed a reward that is still legitimately reserved for
       * someone else". In the second case the slot and the quote are left
       * alone: otherwise anyone could cancel a pending waypoint for free by
       * redeeming the reward and taking the refund.
       */
      const reject = async (
        reason: string,
        releaseQuote: boolean,
      ): Promise<RedemptionOutcome> => {
        const refunded = await refund(channelId, event, reason);
        await recordRedemption({
          event,
          channelId,
          slotId: slot.id,
          quoteId: quote?.id ?? null,
          resolution: refunded ? 'CANCELED' : 'FAILED',
          reason,
        });

        if (releaseQuote && slot.status === 'RESERVED') {
          if (quote && quote.status === 'AWAITING_REDEMPTION') {
            await setQuoteStatus(quote.id, 'CANCELED', ['AWAITING_REDEMPTION']);
            emitRealtime(channelId, 'quote:canceled', { quoteId: quote.id, reason });
          }
          await releaseSlot(channelId, slot, reason).catch(() => undefined);
        }
        return { result: 'refunded', reason, quoteId: quote?.id ?? null };
      };

      if (!quote) return reject('no quote is attached to this reward', true);
      if (quote.channelId !== channelId) return reject('quote belongs to another channel', true);
      if (quote.status !== 'AWAITING_REDEMPTION') {
        return reject(`quote is ${quote.status.toLowerCase()}, not awaiting payment`, true);
      }
      if (quote.twitchUserId !== event.userId) {
        // The wrong viewer grabbed the reward. Refund them, but leave the
        // reward standing: the viewer who reserved it still has not paid.
        return reject('this reward was reserved for another viewer', false);
      }
      if (quote.expiresAt <= Date.now()) {
        return reject('quote expired before payment arrived', true);
      }
      if (event.rewardCost !== quote.channelPointsCost) {
        return reject('redeemed cost does not match the quoted price', true);
      }
      if (await getActiveWaypoint(channelId)) {
        return reject('another waypoint is already active', true);
      }
      if (!settings.waypointsOpen) return reject('waypoints are closed', true);

      // Everything checks out: take the points and create the job atomically.
      let activated: {
        id: string;
        view: ActiveWaypointView;
        waypoint: Awaited<ReturnType<typeof insertActiveWaypoint>>;
      };
      try {
        activated = await withTransaction(async (client) => {
          const { rows } = await client.query(
            `UPDATE waypoint_quotes SET status = 'PAID'
              WHERE id = $1 AND status = 'AWAITING_REDEMPTION'
              RETURNING id`,
            [quote.id],
          );
          if (!rows[0]) throw new Error('quote changed state during activation');

          const waypoint = await insertActiveWaypoint(client, quote);

          await client.query(
            `INSERT INTO twitch_redemptions
               (id, channel_id, reward_id, slot_id, quote_id, twitch_user_id, twitch_user_name,
                cost, resolution, reason, redeemed_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'FULFILLED',NULL,$9)`,
            [
              event.redemptionId,
              channelId,
              event.rewardId,
              slot.id,
              quote.id,
              event.userId,
              event.userName || event.userLogin || null,
              event.rewardCost,
              event.redeemedAt,
            ],
          );

          await client.query(
            `UPDATE twitch_reward_slots SET status = 'CONSUMED', enabled = FALSE, updated_at = now()
              WHERE id = $1`,
            [slot.id],
          );

          // Nothing with an external side effect belongs inside the
          // transaction: a failed COMMIT must not leave a broadcast or a Redis
          // key claiming a waypoint that does not exist.
          return { id: waypoint.id, view: toView(waypoint, null), waypoint };
        });
      } catch (err) {
        logger.error({ err, quoteId: quote.id }, 'activation transaction failed');
        return reject('activation failed on our side', true);
      }

      await primeLiveNav(activated.waypoint);
      emitRealtime(channelId, 'waypoint:activated', activated.view, 'trusted');
      emitRealtime(
        channelId,
        'waypoint:activated',
        {
          ...activated.view,
          routeGeometry:
            sanitizeRouteGeometry(activated.view.routeGeometry, settings) ??
            activated.view.routeGeometry,
          liveRouteGeometry: null,
        },
        'viewers',
      );

      emitRealtime(channelId, 'reward:redeemed', {
        quoteId: quote.id,
        userId: event.userId,
        cost: event.rewardCost,
      });

      // Keep the points: FULFILLED is the acknowledgement Twitch expects.
      // The row stays PENDING until Twitch agrees, so an admin refund can still
      // find a redemption that is in fact still refundable.
      try {
        await updateRedemptionStatus(channelId, event.rewardId, event.redemptionId, 'FULFILLED');
        await query(`UPDATE twitch_redemptions SET resolution = 'FULFILLED' WHERE id = $1`, [
          event.redemptionId,
        ]);
      } catch (err) {
        logger.error({ err, redemption: event.redemptionId }, 'could not mark redemption fulfilled');
      }

      // Take the reward back out of the menu and hand the slot to the pool.
      try {
        await releaseSlotReward(channelId, slot);
        await markSlotFree(slot.id);
      } catch (err) {
        logger.warn({ err, slotId: slot.id }, 'consumed slot not reset on Twitch');
      }

      // One job at a time: everyone else still waiting gets their points back.
      const released = await releaseAllReservedExcept(channelId, slot.id);
      for (const other of released) {
        if (other.quoteId) {
          await query(
            `UPDATE waypoint_quotes SET status = 'CANCELED'
              WHERE id = $1 AND status = 'AWAITING_REDEMPTION'`,
            [other.quoteId],
          );
          emitRealtime(channelId, 'quote:canceled', {
            quoteId: other.quoteId,
            reason: 'another viewer paid first',
          });
        }
      }

      return { result: 'activated', waypointId: activated.id, quoteId: quote.id };
    },
    {
      ttlMs: 20_000,
      waitMs: 10_000,
      onBusy: () => new Error('activation lock is busy'),
    },
  );
}

// ---------------------------------------------------------------------------
// Subscription management
// ---------------------------------------------------------------------------

export function eventSubCallbackUrl(): string {
  return `${env.PUBLIC_API_URL.replace(/\/$/, '')}/api/eventsub/twitch`;
}

/**
 * Make sure exactly the subscriptions we need exist, pointing at this
 * deployment's callback. Stale callbacks (an old ngrok URL) are removed.
 */
export async function ensureEventSubSubscriptions(
  channelId: string,
): Promise<{ created: string[]; removed: string[]; kept: string[] }> {
  const callback = eventSubCallbackUrl();
  const wanted = [REDEMPTION_ADD, REDEMPTION_UPDATE];

  const existing = await listEventSubSubscriptions();
  const created: string[] = [];
  const removed: string[] = [];
  const kept: string[] = [];

  for (const sub of existing) {
    const mine =
      wanted.includes(sub.type) && sub.condition.broadcaster_user_id === channelId;
    if (!mine) continue;
    const healthy = sub.transport.callback === callback && sub.status === 'enabled';
    if (healthy) {
      kept.push(sub.type);
    } else {
      await deleteEventSubSubscription(sub.id).catch((err) =>
        logger.warn({ err, id: sub.id }, 'could not delete stale subscription'),
      );
      removed.push(sub.type);
    }
  }

  for (const type of wanted) {
    if (kept.includes(type)) continue;
    const sub = await createEventSubSubscription({
      type,
      version: '1',
      condition: { broadcaster_user_id: channelId },
      callback,
      secret: env.TWITCH_EVENTSUB_SECRET,
    });
    created.push(sub.type);
  }

  logger.info({ channelId, created, removed, kept, callback }, 'eventsub subscriptions synced');
  return { created, removed, kept };
}

/** Housekeeping for the durable idempotency table. */
export async function pruneEventSubEvents(days = 7): Promise<number> {
  const { rowCount } = await query(
    `DELETE FROM eventsub_events WHERE received_at < now() - ($1 || ' days')::interval`,
    [String(Math.max(1, Math.trunc(days)))],
  );
  return rowCount ?? 0;
}

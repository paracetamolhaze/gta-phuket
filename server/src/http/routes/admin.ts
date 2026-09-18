import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../env.js';
import { logger } from '../../logger.js';
import { query } from '../../db/pool.js';
import { getGpsState } from '../../domain/gps.js';
import { getSettings, settingsPatchSchema, setWaypointsOpen } from '../../domain/settings.js';
import { listRecentQuotes } from '../../domain/quotes.js';
import { countFreeSlots } from '../../domain/slots.js';
import { listSlots, ensureRewardPool } from '../../twitch/rewards.js';
import {
  cancelWaypoint,
  completeWaypoint,
  getActiveWaypoint,
  getActiveWaypointView,
} from '../../domain/waypoints.js';
import { emitSlotCounts, releaseQuoteResources } from '../../domain/waypointFlow.js';
import { getQuote } from '../../domain/quotes.js';
import { loadBroadcasterTokens } from '../../twitch/tokens.js';
import { ensureEventSubSubscriptions } from '../../twitch/eventsub.js';
import {
  getCustomReward,
  listEventSubSubscriptions,
  updateRedemptionStatus,
} from '../../twitch/helix.js';
import {
  ensureExchangeReward,
  getExchangeReward,
  saveSettingsWithExchangeTerms,
} from '../../twitch/exchangeReward.js';
import { emitRealtime, emitToViewer } from '../../realtime/bus.js';
import { paymentMode } from '../../domain/paymentMode.js';
import {
  adjustBalance,
  checkLedgerConsistency,
  economyTotals,
  fulfillmentCounts,
  listRecentLedger,
} from '../../domain/wallet.js';
import { AppError } from '../../domain/types.js';
import { checkAdminPassword, obsUrl, requireAdmin, signAdminToken } from '../auth.js';
import { useDevHelix } from '../../twitch/devHelix.js';
import { enforceRateLimit } from '../rateLimit.js';

function channel(): string {
  return env.TWITCH_CHANNEL_ID || 'dev';
}

const cancelSchema = z.object({
  reason: z.string().max(200).optional(),
  refund: z.boolean().optional(),
});

const economyPatchSchema = z
  .object({
    gtaDollarsPerChannelPoint: z.number().int().min(1).max(1000),
    exchangeRewardCost: z.number().int().min(1).max(1_000_000),
  })
  .partial()
  .strict();

const adjustSchema = z.object({
  twitchUserId: z.string().regex(/^[0-9]{1,20}$/),
  amount: z
    .number()
    .int()
    .min(-1_000_000_000)
    .max(1_000_000_000)
    .refine((v) => v !== 0, 'amount must not be zero'),
  reason: z.string().min(1).max(200),
});

/** The GTA DOLLAR ECONOMY panel, in one read. */
async function economyView(channelId: string) {
  const settings = await getSettings(channelId);
  const [stored, totals, ledger, fulfilments, recent] = await Promise.all([
    getExchangeReward(channelId),
    economyTotals(channelId),
    checkLedgerConsistency(channelId),
    fulfillmentCounts(channelId),
    listRecentLedger(channelId, 20),
  ]);

  // Enabled is Twitch's state, not ours, so it is read live. Not being able to
  // ask is reported as such (null, and the reason) rather than dressed up as
  // "disabled".
  let reward: { id: string; title: string; cost: number; enabledOnTwitch: boolean | null } | null =
    null;
  let rewardCheckError: string | null = null;
  if (stored) {
    let enabledOnTwitch: boolean | null = null;
    try {
      enabledOnTwitch = (await getCustomReward(channelId, stored.twitchRewardId))?.is_enabled === true;
    } catch (err) {
      rewardCheckError = (err as Error).message;
    }
    reward = { id: stored.twitchRewardId, title: stored.title, cost: stored.cost, enabledOnTwitch };
  }

  const rewardCost = stored?.cost ?? settings.exchangeRewardCost;
  return {
    paymentMode: paymentMode(),
    exchangeRate: settings.gtaDollarsPerChannelPoint,
    reward,
    gtaPerRedemption: rewardCost * settings.gtaDollarsPerChannelPoint,
    totals,
    ledgerConsistent: ledger.consistent,
    pendingFulfillments: fulfilments.pending,
    failedFulfillments: fulfilments.failed,
    canceledExternally: fulfilments.canceledExternally,
    recent: recent.map((t) => ({
      createdAt: new Date(t.createdAt).toISOString(),
      type: t.type,
      amount: t.amount,
      twitchUserId: t.twitchUserId,
      balanceAfter: t.balanceAfter,
    })),
    settings: {
      gtaDollarsPerChannelPoint: settings.gtaDollarsPerChannelPoint,
      exchangeRewardCost: settings.exchangeRewardCost,
    },
    rewardCheckError,
  };
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/admin/login', async (req) => {
    await enforceRateLimit('adminlogin', req.ip, 10);
    const { password } = z.object({ password: z.string().max(400) }).parse(req.body);
    if (!checkAdminPassword(password)) {
      throw new AppError('unauthorized', 'Неверный пароль', 401);
    }
    return { token: signAdminToken() };
  });

  app.get('/api/admin/state', async (req) => {
    requireAdmin(req);
    const channelId = channel();
    const settings = await getSettings(channelId);

    const [gps, activeWaypoint, slots, counts, quotes, tokens] = await Promise.all([
      getGpsState(channelId, settings),
      getActiveWaypointView(channelId),
      listSlots(channelId),
      countFreeSlots(channelId, settings.rewardSlotPoolSize),
      listRecentQuotes(channelId, 15),
      loadBroadcasterTokens(channelId),
    ]);

    let eventsub: { count: number; types: string[] } = { count: 0, types: [] };
    if (tokens) {
      try {
        const subs = (await listEventSubSubscriptions()).filter(
          (s) => s.condition.broadcaster_user_id === channelId,
        );
        eventsub = { count: subs.length, types: subs.map((s) => `${s.type} (${s.status})`) };
      } catch (err) {
        logger.debug({ err }, 'eventsub listing failed');
      }
    }

    return {
      channelId,
      serverTime: Date.now(),
      gps,
      activeWaypoint,
      settings,
      slots: {
        free: counts.free,
        total: counts.total,
        items: slots.map((s) => ({
          index: s.index,
          status: s.status,
          currentTitle: s.currentTitle,
          currentCost: s.currentCost,
          enabled: s.enabled,
          quoteId: s.quoteId,
          reservedForUser: s.reservedForUserId,
        })),
      },
      quotes: quotes.map((q) => ({
        id: q.id,
        code: q.code,
        status: q.status,
        destinationName: q.destinationName,
        cost: q.channelPointsCost,
        currency: q.currency,
        twitchUserName: q.twitchUserName ?? q.twitchUserId,
        distanceMeters: Math.round(q.routeDistanceMeters),
        createdAt: q.createdAt,
        expiresAt: q.expiresAt,
      })),
      obsUrl: obsUrl(),
      // The unit the pricing settings are in: GTA$ or Channel Points.
      paymentMode: paymentMode(),
      oauth: {
        connected: Boolean(tokens),
        devStub: useDevHelix(),
        scopes: tokens?.scopes ?? [],
        expiresAt: tokens?.expiresAt ?? null,
        eventsub,
        callbackUrl: `${env.PUBLIC_API_URL.replace(/\/$/, '')}/api/eventsub/twitch`,
      },
      devMode: env.devModeEnabled,
    };
  });

  app.get('/api/admin/settings', async (req) => {
    requireAdmin(req);
    return getSettings(channel());
  });

  app.put('/api/admin/settings', async (req) => {
    requireAdmin(req);
    const patch = settingsPatchSchema.parse(req.body);
    const channelId = channel();
    const before = await getSettings(channelId);
    const settings = await saveSettingsWithExchangeTerms(channelId, patch);

    // Growing the pool needs new rewards on Twitch before they can be leased.
    if (patch.rewardSlotPoolSize && patch.rewardSlotPoolSize !== before.rewardSlotPoolSize) {
      try {
        await ensureRewardPool(channelId, settings.rewardSlotPoolSize);
      } catch (err) {
        logger.warn({ err }, 'pool resize failed');
      }
    }

    emitRealtime(channelId, 'settings:update', settings, 'trusted');
    await emitSlotCounts(channelId);
    return settings;
  });

  app.post('/api/admin/waypoints/open', async (req) => {
    requireAdmin(req);
    const settings = await setWaypointsOpen(channel(), true);
    emitRealtime(channel(), 'settings:update', settings, 'all');
    return { ok: true };
  });

  app.post('/api/admin/waypoints/close', async (req) => {
    requireAdmin(req);
    const settings = await setWaypointsOpen(channel(), false);
    emitRealtime(channel(), 'settings:update', settings, 'all');
    return { ok: true };
  });

  app.post('/api/admin/waypoint/complete', async (req) => {
    requireAdmin(req);
    const waypoint = await completeWaypoint(channel());
    if (!waypoint) throw new AppError('not_found', 'Нет активной точки', 404);
    await emitSlotCounts(channel());
    return { ok: true, waypointId: waypoint.id };
  });

  /**
   * Cancel the running job. A refund is only possible while the redemption is
   * still UNFULFILLED on Twitch — once it is fulfilled, Twitch offers no way
   * back, and saying otherwise would be a lie to the viewer.
   */
  app.post('/api/admin/waypoint/cancel', async (req) => {
    requireAdmin(req);
    const body = cancelSchema.parse(req.body ?? {});
    const channelId = channel();

    const active = await getActiveWaypoint(channelId);
    if (!active) throw new AppError('not_found', 'Нет активной точки', 404);

    // A GTA$ waypoint has no redemption behind it: the refund is a ledger
    // entry, booked once, in the same transaction as the cancel.
    if (active.currency === 'GTA_DOLLAR') {
      const canceled = await cancelWaypoint(channelId, body.reason ?? 'canceled by admin', {
        refundGta: body.refund === true,
      });
      if (!canceled) throw new AppError('not_found', 'Нет активной точки', 404);
      await emitSlotCounts(channelId);
      return {
        ok: true,
        refunded: canceled.refund?.refunded === true,
        refundError: null,
        amount: canceled.refund?.amount ?? 0,
      };
    }

    let refunded = false;
    let refundError: string | null = null;

    if (body.refund) {
      const { rows } = await query<{ id: string; reward_id: string; resolution: string }>(
        `SELECT id, reward_id, resolution FROM twitch_redemptions
          WHERE quote_id = $1 ORDER BY processed_at DESC LIMIT 1`,
        [active.quoteId],
      );
      const redemption = rows[0];
      if (!redemption) {
        refundError = 'Оплата не найдена (возможно, это ручная точка)';
      } else if (redemption.resolution === 'FULFILLED') {
        refundError =
          'Twitch не позволяет вернуть баллы после FULFILLED — верни их вручную наградой или подарком';
      } else {
        try {
          await updateRedemptionStatus(channelId, redemption.reward_id, redemption.id, 'CANCELED');
          await query(`UPDATE twitch_redemptions SET resolution = 'CANCELED' WHERE id = $1`, [
            redemption.id,
          ]);
          refunded = true;
        } catch (err) {
          refundError = (err as Error).message;
        }
      }
    }

    await cancelWaypoint(channelId, body.reason ?? 'canceled by admin');
    await emitSlotCounts(channelId);
    return { ok: true, refunded, refundError };
  });

  /**
   * Drop the route. Channel Points are left alone (that refund is a Twitch
   * call, and a reset must not depend on Twitch answering), but GTA$ are not:
   * a GTA$ job is a ledger entry away from being paid back, and an emergency
   * reset is no reason for a viewer to lose money for a job that never
   * happened. The refund's unique index keeps it once-only. Cancelling a GTA$
   * job without a refund stays possible, deliberately, through the cancel.
   */
  app.post('/api/admin/waypoint/clear', async (req) => {
    requireAdmin(req);
    const channelId = channel();
    const active = await getActiveWaypoint(channelId);
    const canceled = active
      ? await cancelWaypoint(channelId, 'cleared by admin', { refundGta: true })
      : null;

    // Any quote still waiting for payment is released too, so the pool is clean.
    const pending = await listRecentQuotes(channelId, 50);
    for (const quote of pending) {
      if (quote.status === 'QUOTED' || quote.status === 'AWAITING_REDEMPTION') {
        await releaseQuoteResources(quote, 'cleared by admin');
      }
    }
    await emitSlotCounts(channelId);
    return {
      ok: true,
      refunded: canceled?.refund?.refunded === true,
      amount: canceled?.refund?.amount ?? 0,
    };
  });

  app.post('/api/admin/slots/sync', async (req) => {
    requireAdmin(req);
    const channelId = channel();
    const settings = await getSettings(channelId);
    const result = await ensureRewardPool(channelId, settings.rewardSlotPoolSize);
    await emitSlotCounts(channelId);
    return result;
  });

  app.post('/api/admin/eventsub/sync', async (req) => {
    requireAdmin(req);
    return ensureEventSubSubscriptions(channel());
  });

  // ---- GTA DOLLAR economy -------------------------------------------------

  app.get('/api/admin/economy', async (req) => {
    requireAdmin(req);
    return economyView(channel());
  });

  app.put('/api/admin/economy', async (req) => {
    requireAdmin(req);
    const patch = economyPatchSchema.parse(req.body ?? {});
    const channelId = channel();
    const settings = await saveSettingsWithExchangeTerms(channelId, patch);
    emitRealtime(channelId, 'settings:update', settings, 'trusted');
    return economyView(channelId);
  });

  app.post('/api/admin/economy/exchange-reward/sync', async (req) => {
    requireAdmin(req);
    return ensureExchangeReward(channel());
  });

  /**
   * Manual ledger correction, e.g. taking back GTA$ whose exchange redemption
   * a moderator cancelled on Twitch (never done automatically). Not one of the
   * contract's endpoints, but the only honest way to act on that alert.
   */
  app.post('/api/admin/economy/adjust', async (req) => {
    requireAdmin(req);
    const body = adjustSchema.parse(req.body ?? {});
    const channelId = channel();
    const result = await adjustBalance({ channelId, ...body });
    emitToViewer(channelId, body.twitchUserId, 'wallet:updated', {
      type: 'ADMIN_ADJUSTMENT',
      amount: body.amount,
      balance: result.balance,
      transactionId: result.transactionId,
    });
    logger.info({ user: body.twitchUserId, amount: body.amount }, 'GTA$ adjusted by admin');
    return { ok: true, ...result };
  });

  app.get('/api/admin/quote/:id', async (req) => {
    requireAdmin(req);
    const { id } = req.params as { id: string };
    const quote = await getQuote(id);
    if (!quote) throw new AppError('not_found', 'Расчёт не найден', 404);
    return quote;
  });
}

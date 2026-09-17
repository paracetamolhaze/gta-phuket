import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../env.js';
import { logger } from '../../logger.js';
import { query } from '../../db/pool.js';
import { redis } from '../../redis/client.js';
import { getSettings } from '../../domain/settings.js';
import { clearGps, getGpsState, gpsInputSchema, ingestGps } from '../../domain/gps.js';
import { getQuote, listRecentQuotes } from '../../domain/quotes.js';
import { listSlots } from '../../twitch/rewards.js';
import { getActiveWaypointView, refreshLiveNavigation } from '../../domain/waypoints.js';
import { broadcastGps } from '../../realtime/gpsBroadcast.js';
import { signDevExtensionJwt } from '../../twitch/extJwt.js';
import { computeSignature } from '../../twitch/eventsub.js';
import { resetDevHelix, useDevHelix } from '../../twitch/devHelix.js';
import {
  placeSimulator,
  setSimulatorSpeed,
  simulatorStatus,
  startSimulator,
  stopSimulator,
} from '../../jobs/gpsSimulator.js';
import { AppError } from '../../domain/types.js';

function channel(): string {
  return env.TWITCH_CHANNEL_ID || 'dev';
}

const tokenSchema = z.object({
  userId: z.string().regex(/^\d+$/).optional(),
  role: z.enum(['viewer', 'moderator', 'broadcaster', 'external']).optional(),
  linked: z.boolean().optional(),
});

const simStartSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  speedMps: z.number().min(0.2).max(5).optional(),
});

const redeemSchema = z.object({
  quoteId: z.string().optional(),
  rewardId: z.string().optional(),
  userId: z.string().optional(),
  cost: z.number().int().optional(),
});

/**
 * Development-only surface.
 *
 * Registered only when DEV_MODE=true and NODE_ENV is not production, so in a
 * real deployment these paths simply do not exist. Every button here goes
 * through the same production code as the real thing — the simulated
 * redemption is a properly signed EventSub payload delivered to the real
 * webhook, not a shortcut into the activation logic.
 */
export async function registerDevRoutes(app: FastifyInstance): Promise<void> {
  if (!env.devModeEnabled) {
    logger.info('dev routes disabled');
    return;
  }
  logger.warn('DEV MODE: /api/dev/* is enabled. Never run this in production.');

  app.get('/api/dev/state', async () => {
    const channelId = channel();
    const settings = await getSettings(channelId);
    const quotes = await listRecentQuotes(channelId, 10);
    const pending = quotes.find((q) => q.status === 'AWAITING_REDEMPTION') ?? null;

    return {
      channelId,
      devHelix: useDevHelix(),
      gps: await getGpsState(channelId, settings),
      simulator: simulatorStatus(channelId),
      activeWaypoint: await getActiveWaypointView(channelId),
      pendingQuote: pending
        ? {
            quoteId: pending.id,
            code: pending.code,
            cost: pending.channelPointsCost,
            destinationName: pending.destinationName,
            twitchUserId: pending.twitchUserId,
            expiresAt: pending.expiresAt,
          }
        : null,
      quotes: quotes.map((q) => ({
        id: q.id,
        code: q.code,
        status: q.status,
        cost: q.channelPointsCost,
        destinationName: q.destinationName,
        twitchUserId: q.twitchUserId,
      })),
      slots: (await listSlots(channelId)).map((s) => ({
        index: s.index,
        status: s.status,
        title: s.currentTitle,
        cost: s.currentCost,
        enabled: s.enabled,
      })),
    };
  });

  /** A real extension JWT, signed with the real secret, for the local player. */
  app.post('/api/dev/ext-token', async (req) => {
    const body = tokenSchema.parse(req.body ?? {});
    const token = signDevExtensionJwt({
      channelId: channel(),
      userId: body.userId ?? '100000001',
      role: body.role ?? 'viewer',
      linked: body.linked !== false,
    });
    return { token, channelId: channel(), userId: body.userId ?? '100000001' };
  });

  app.post('/api/dev/gps', async (req) => {
    const channelId = channel();
    const raw = req.body as Record<string, unknown>;
    const input = gpsInputSchema.parse({
      ...raw,
      timestamp: typeof raw?.timestamp === 'number' ? raw.timestamp : Date.now(),
      accuracy: typeof raw?.accuracy === 'number' ? raw.accuracy : 6,
    });

    const settings = await getSettings(channelId);
    const sample = await ingestGps(channelId, null, input);
    await placeSimulator(channelId, { lat: sample.lat, lng: sample.lng });
    await broadcastGps(channelId, sample, settings);
    await refreshLiveNavigation(channelId, sample, settings);
    return { ok: true, sample };
  });

  app.post('/api/dev/gps/sim/start', async (req) => {
    const body = simStartSchema.parse(req.body ?? {});
    await startSimulator({
      channelId: channel(),
      start: { lat: body.lat, lng: body.lng },
      speedMps: body.speedMps,
    });
    return { ok: true, ...simulatorStatus(channel()) };
  });

  app.post('/api/dev/gps/sim/speed', async (req) => {
    const { speedMps } = z.object({ speedMps: z.number().min(0.2).max(5) }).parse(req.body ?? {});
    setSimulatorSpeed(channel(), speedMps);
    return { ok: true, ...simulatorStatus(channel()) };
  });

  app.post('/api/dev/gps/sim/stop', async () => {
    stopSimulator(channel());
    return { ok: true };
  });

  /**
   * Stand in for a viewer spending Channel Points.
   *
   * Builds the exact payload Twitch sends, signs it with the EventSub secret
   * and posts it to our own webhook, so signature checking, deduplication,
   * user matching and the activation transaction all run for real.
   */
  app.post('/api/dev/redeem', async (req) => {
    const body = redeemSchema.parse(req.body ?? {});
    const channelId = channel();

    let rewardId = body.rewardId ?? null;
    let userId = body.userId ?? null;
    let cost = body.cost ?? null;

    if (body.quoteId) {
      const quote = await getQuote(body.quoteId);
      if (!quote) throw new AppError('quote_not_found', 'Расчёт не найден', 404);
      if (!quote.slotId) {
        throw new AppError(
          'quote_conflict',
          'У расчёта нет слота — сначала нажми подтверждение во вьювере',
          409,
        );
      }
      const slot = (await listSlots(channelId)).find((s) => s.id === quote.slotId);
      if (!slot) throw new AppError('not_found', 'Слот не найден', 404);
      rewardId = slot.twitchRewardId;
      userId = userId ?? quote.twitchUserId;
      cost = cost ?? quote.channelPointsCost;
    }

    if (!rewardId || !userId || cost === null) {
      throw new AppError(
        'invalid_request',
        'Нужен quoteId (или rewardId + userId + cost)',
        422,
      );
    }

    const payload = {
      subscription: {
        id: randomUUID(),
        type: 'channel.channel_points_custom_reward_redemption.add',
        version: '1',
        status: 'enabled',
        cost: 0,
        condition: { broadcaster_user_id: channelId },
        transport: { method: 'webhook', callback: 'dev' },
        created_at: new Date().toISOString(),
      },
      event: {
        id: randomUUID(),
        broadcaster_user_id: channelId,
        broadcaster_user_login: 'dev',
        broadcaster_user_name: 'dev',
        user_id: userId,
        user_login: `viewer_${userId}`,
        user_name: `Viewer ${userId}`,
        user_input: '',
        status: 'unfulfilled',
        redeemed_at: new Date().toISOString(),
        reward: { id: rewardId, title: 'WAYPOINT', cost, prompt: '' },
      },
    };

    const rawBody = JSON.stringify(payload);
    const messageId = randomUUID();
    const timestamp = new Date().toISOString();
    const signature = computeSignature(messageId, timestamp, rawBody);

    const selfUrl = `http://127.0.0.1:${env.PORT}/api/eventsub/twitch`;
    const res = await fetch(selfUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Twitch-Eventsub-Message-Id': messageId,
        'Twitch-Eventsub-Message-Timestamp': timestamp,
        'Twitch-Eventsub-Message-Signature': signature,
        'Twitch-Eventsub-Message-Type': 'notification',
        'Twitch-Eventsub-Subscription-Type': 'channel.channel_points_custom_reward_redemption.add',
      },
      body: rawBody,
    });

    return {
      ok: res.ok,
      status: res.status,
      deliveredTo: selfUrl,
      note: 'Отправлено через настоящий подписанный EventSub webhook',
    };
  });

  app.post('/api/dev/reset', async () => {
    const channelId = channel();
    stopSimulator(channelId);

    await query(`UPDATE waypoints SET status = 'CANCELED', canceled_at = now(),
                 cancel_reason = 'dev reset' WHERE channel_id = $1 AND status = 'ACTIVE'`, [channelId]);
    await query(
      `UPDATE waypoint_quotes SET status = 'CANCELED'
        WHERE channel_id = $1 AND status IN ('QUOTED','AWAITING_REDEMPTION')`,
      [channelId],
    );
    await query(
      `UPDATE twitch_reward_slots
          SET status = 'FREE', quote_id = NULL, reserved_for_user = NULL,
              reserved_at = NULL, enabled = FALSE, updated_at = now()
        WHERE channel_id = $1`,
      [channelId],
    );
    await clearGps(channelId);

    const keys = await redis.keys('gta:*');
    if (keys.length) await redis.del(...keys);
    resetDevHelix();

    logger.warn({ channelId }, 'dev reset: waypoints, quotes, slots and GPS cleared');
    return { ok: true };
  });
}

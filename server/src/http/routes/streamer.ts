import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../env.js';
import { query } from '../../db/pool.js';
import { getSettings } from '../../domain/settings.js';
import { getGpsState } from '../../domain/gps.js';
import { completeWaypoint, getActiveWaypointView } from '../../domain/waypoints.js';
import { emitSlotCounts } from '../../domain/waypointFlow.js';
import { AppError } from '../../domain/types.js';
import {
  checkPairingCode,
  hashDeviceToken,
  requireDevice,
  signDeviceToken,
} from '../auth.js';
import { enforceRateLimit } from '../rateLimit.js';

const pairSchema = z.object({
  code: z.string().min(1).max(200),
  label: z.string().max(60).optional(),
});

export async function registerStreamerRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Pair a phone. The code is a shared secret typed once; what the phone keeps
   * afterwards is a per-device token that can be revoked on its own.
   */
  app.post('/api/streamer/pair', async (req) => {
    await enforceRateLimit('pair', req.ip, 10);

    const body = pairSchema.parse(req.body);
    if (!checkPairingCode(body.code)) {
      throw new AppError('unauthorized', 'Неверный код подключения', 401);
    }

    const channelId = env.TWITCH_CHANNEL_ID || 'dev';
    await query(
      `INSERT INTO channels (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
      [channelId],
    );

    const deviceId = randomUUID();
    const token = signDeviceToken({ deviceId, channelId });

    await query(
      `INSERT INTO streamer_devices (id, channel_id, label, token_hash)
       VALUES ($1, $2, $3, $4)`,
      [deviceId, channelId, body.label?.slice(0, 60) ?? 'phone', hashDeviceToken(token)],
    );

    return { deviceToken: token, channelId, deviceId };
  });

  app.get('/api/streamer/state', async (req) => {
    const claims = await requireDevice(req);
    const settings = await getSettings(claims.channelId);
    return {
      gps: await getGpsState(claims.channelId, settings),
      activeWaypoint: await getActiveWaypointView(claims.channelId),
      waypointsOpen: settings.waypointsOpen,
      gpsTimeoutSeconds: settings.gpsTimeoutSeconds,
    };
  });

  /** The streamer declaring the job done is what frees the channel for the next one. */
  app.post('/api/streamer/waypoint/complete', async (req) => {
    const claims = await requireDevice(req);
    const waypoint = await completeWaypoint(claims.channelId);
    if (!waypoint) throw new AppError('not_found', 'Нет активной точки', 404);
    await emitSlotCounts(claims.channelId);
    return { ok: true, waypointId: waypoint.id };
  });

  app.post('/api/streamer/unpair', async (req) => {
    const claims = await requireDevice(req);
    await query('UPDATE streamer_devices SET revoked = TRUE WHERE id = $1', [claims.deviceId]);
    return { ok: true };
  });
}

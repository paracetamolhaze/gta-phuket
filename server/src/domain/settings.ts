import { z } from 'zod';
import { query } from '../db/pool.js';
import { redis } from '../redis/client.js';
import { K } from '../redis/keys.js';
import { DEFAULT_SETTINGS, type ChannelSettings } from './types.js';

const lngLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);

const restrictedZoneSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  polygon: z.array(lngLat).min(3).max(500),
});

/**
 * Every field is optional so PATCH-style updates are natural; bounds here are
 * the real guard rails, because the admin UI is not a trusted validator.
 */
export const settingsPatchSchema = z
  .object({
    baseCost: z.number().int().min(0).max(1_000_000),
    pointsPer100Meters: z.number().int().min(0).max(1_000_000),
    minimumCost: z.number().int().min(1).max(1_000_000),
    maximumCost: z.number().int().min(1).max(1_000_000),
    roundTo: z.number().int().min(1).max(100_000),

    maxWalkingDistanceMeters: z.number().int().min(100).max(50_000),
    quoteTtlSeconds: z.number().int().min(15).max(600),
    rewardSlotPoolSize: z.number().int().min(1).max(40),
    gpsTimeoutSeconds: z.number().int().min(5).max(300),
    maxGpsAccuracyMeters: z.number().int().min(5).max(2000),
    maxSnapDistanceMeters: z.number().int().min(10).max(2000),

    waypointsOpen: z.boolean(),

    viewerLocationDelaySeconds: z.number().int().min(0).max(600),
    viewerLocationPrecision: z.number().int().min(0).max(6),
    restrictedZones: z.array(restrictedZoneSchema).max(50),

    quotesPerMinute: z.number().int().min(1).max(600),
    searchesPerMinute: z.number().int().min(1).max(600),

    gtaDollarsPerChannelPoint: z.number().int().min(1).max(1000),
    // Twitch's own limits for a Custom Reward cost.
    exchangeRewardCost: z.number().int().min(1).max(1_000_000),
  })
  .partial()
  .strict();

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

const CACHE_TTL_SECONDS = 300;

function normalise(settings: ChannelSettings): ChannelSettings {
  const next = { ...settings };
  // maximumCost below minimumCost would make calculatePrice clamp to a value
  // no admin asked for, so fix the ordering once, here.
  if (next.maximumCost < next.minimumCost) next.maximumCost = next.minimumCost;
  return next;
}

export async function getSettings(channelId: string): Promise<ChannelSettings> {
  const cached = await redis.get(K.settings(channelId));
  if (cached) {
    try {
      return normalise({ ...DEFAULT_SETTINGS, ...(JSON.parse(cached) as Partial<ChannelSettings>) });
    } catch {
      // fall through to the database
    }
  }

  const { rows } = await query<{ settings: Partial<ChannelSettings> }>(
    'SELECT settings FROM channel_settings WHERE channel_id = $1',
    [channelId],
  );
  const stored = rows[0]?.settings ?? {};
  const merged = normalise({ ...DEFAULT_SETTINGS, ...stored });
  await redis.set(K.settings(channelId), JSON.stringify(merged), 'EX', CACHE_TTL_SECONDS);
  return merged;
}

export async function saveSettings(
  channelId: string,
  patch: SettingsPatch,
): Promise<ChannelSettings> {
  const current = await getSettings(channelId);
  const merged = normalise({ ...current, ...patch });

  await query(
    `INSERT INTO channel_settings (channel_id, settings, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (channel_id)
     DO UPDATE SET settings = $2::jsonb, updated_at = now()`,
    [channelId, JSON.stringify(merged)],
  );
  await redis.set(K.settings(channelId), JSON.stringify(merged), 'EX', CACHE_TTL_SECONDS);
  return merged;
}

export async function invalidateSettings(channelId: string): Promise<void> {
  await redis.del(K.settings(channelId));
}

/** Convenience for the very common "is the shop open" check. */
export async function setWaypointsOpen(channelId: string, open: boolean): Promise<ChannelSettings> {
  return saveSettings(channelId, { waypointsOpen: open });
}

import { z } from 'zod';
import { query } from '../db/pool.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { redis } from '../redis/client.js';
import { K } from '../redis/keys.js';
import { inBounds, isValidLat, isValidLng, roundLatLng } from './geo.js';
import {
  AppError,
  type ChannelSettings,
  type GpsSample,
  type GpsState,
  type PublicGps,
} from './types.js';

// ---------------------------------------------------------------------------
// REVIEW DEMO GPS
// ---------------------------------------------------------------------------
//
// Twitch reviews the extension on the live channel, usually while the streamer
// is not walking around Phuket. With no fresh fix every quote fails with
// gps_unavailable and the reviewer never sees a route or a price. With
// REVIEW_DEMO_MODE on, every GPS read that quotes and displays use
// (getGpsState, requireFreshGps, getPublicGps: so quotes, /api/ext/state, OBS,
// sockets, admin and config) answers with a fixed, always-fresh fix at
// REVIEW_DEMO_LAT / REVIEW_DEMO_LNG instead.
//
// Twitch reviewers cannot be identified by id (their accounts are not
// published and the extension JWT carries no "reviewer" marker), so the switch
// is channel-wide: every viewer sees the demo position while it is on. It is
// meant for the review window only.
//
// The demo fix is computed on every read and never written to Redis or
// Postgres. The streamer's real fixes keep being ingested and stored as usual,
// they are just not used while the demo is on, so the two never mix, and
// turning the flag off brings the live position back on the very next read.

/** Accuracy reported for the demo fix: plausible for a phone, well inside any limit. */
const REVIEW_DEMO_ACCURACY_M = 10;

export function reviewDemoActive(): boolean {
  return env.reviewDemo.active;
}

/** The synthetic fix, stamped "now" so it can never go stale. */
function reviewDemoSample(now = Date.now()): GpsSample {
  return {
    lat: env.reviewDemo.lat,
    lng: env.reviewDemo.lng,
    accuracy: REVIEW_DEMO_ACCURACY_M,
    heading: null,
    speed: null,
    timestamp: now,
    receivedAt: now,
    source: 'review_demo',
  };
}

// Once per process, at boot: this module is loaded by every route that reads
// GPS, and a demo left on by accident must be obvious in the api log.
if (reviewDemoActive()) {
  logger.warn(
    { lat: env.reviewDemo.lat, lng: env.reviewDemo.lng },
    'REVIEW DEMO GPS ACTIVE: quotes and maps use a fixed demo position for every viewer; live GPS is stored but not used',
  );
}

export const gpsInputSchema = z.object({
  lat: z.number().refine(isValidLat, 'lat out of range'),
  lng: z.number().refine(isValidLng, 'lng out of range'),
  accuracy: z.number().min(0).max(100_000).default(9999),
  heading: z.number().min(0).max(360).nullable().optional(),
  speed: z.number().min(0).max(120).nullable().optional(),
  timestamp: z.number().int().positive(),
});

export type GpsInput = z.infer<typeof gpsInputSchema>;

/** How long a sample stays in the delay buffer. */
const BUFFER_TTL_SECONDS = 900;
/** Only write one row per this many ms; the live position lives in Redis. */
const PERSIST_INTERVAL_MS = 5000;

const CLOCK_SKEW_FUTURE_MS = 60_000;
const CLOCK_SKEW_PAST_MS = 300_000;

const lastPersistedAt = new Map<string, number>();

export class GpsRejected extends AppError {
  constructor(reason: string) {
    super('invalid_request', `GPS sample rejected: ${reason}`, 422);
  }
}

/**
 * Accept a fix from the streamer's phone.
 *
 * The device clock is not trusted for staleness — `receivedAt` is — but an
 * absurd device timestamp still means the sample is not what it claims to be.
 *
 * Returns the fix now in effect: the one just stored, or the review demo fix
 * while REVIEW_DEMO_MODE is on. Every caller fans the result straight out
 * (broadcastGps, refreshLiveNavigation), and a real position must not leak
 * into a demo session through them.
 */
export async function ingestGps(
  channelId: string,
  deviceId: string | null,
  input: GpsInput,
): Promise<GpsSample> {
  const now = Date.now();

  if (input.timestamp > now + CLOCK_SKEW_FUTURE_MS) {
    throw new GpsRejected('timestamp is in the future');
  }
  if (input.timestamp < now - CLOCK_SKEW_PAST_MS) {
    throw new GpsRejected('timestamp is too old');
  }
  if (!inBounds({ lat: input.lat, lng: input.lng })) {
    throw new GpsRejected('position is outside the Phuket service area');
  }

  const sample: GpsSample = {
    lat: input.lat,
    lng: input.lng,
    accuracy: input.accuracy,
    heading: input.heading ?? null,
    speed: input.speed ?? null,
    timestamp: input.timestamp,
    receivedAt: now,
  };

  const payload = JSON.stringify(sample);
  const pipeline = redis.multi();
  pipeline.set(K.gpsLatest(channelId), payload, 'EX', BUFFER_TTL_SECONDS);
  pipeline.zadd(K.gpsBuffer(channelId), now, payload);
  pipeline.zremrangebyscore(K.gpsBuffer(channelId), 0, now - BUFFER_TTL_SECONDS * 1000);
  pipeline.expire(K.gpsBuffer(channelId), BUFFER_TTL_SECONDS);
  await pipeline.exec();

  const lastWrite = lastPersistedAt.get(channelId) ?? 0;
  if (now - lastWrite >= PERSIST_INTERVAL_MS) {
    lastPersistedAt.set(channelId, now);
    query(
      `INSERT INTO gps_samples
         (channel_id, device_id, lat, lng, accuracy, heading, speed, device_time, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0), to_timestamp($9 / 1000.0))`,
      [
        channelId,
        deviceId,
        sample.lat,
        sample.lng,
        sample.accuracy,
        sample.heading,
        sample.speed,
        sample.timestamp,
        sample.receivedAt,
      ],
    ).catch((err) => logger.warn({ err }, 'could not persist gps sample'));

    if (deviceId) {
      query('UPDATE streamer_devices SET last_seen_at = now() WHERE id = $1', [deviceId]).catch(
        () => undefined,
      );
    }
  }

  return reviewDemoActive() ? reviewDemoSample(now) : sample;
}

export async function getLatestSample(channelId: string): Promise<GpsSample | null> {
  const raw = await redis.get(K.gpsLatest(channelId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GpsSample;
  } catch {
    return null;
  }
}

export function classify(sample: GpsSample | null, settings: ChannelSettings, now = Date.now()): GpsState {
  // The label comes from the sample itself, so the demo fix that ingestGps
  // hands to broadcastGps is reported as such.
  const source = sample?.source ?? 'live';
  if (!sample) return { status: 'missing', sample: null, ageMs: null, source };
  const ageMs = now - sample.receivedAt;
  if (ageMs > settings.gpsTimeoutSeconds * 1000) return { status: 'stale', sample, ageMs, source };
  if (sample.accuracy > settings.maxGpsAccuracyMeters) {
    return { status: 'inaccurate', sample, ageMs, source };
  }
  return { status: 'ok', sample, ageMs, source };
}

export async function getGpsState(
  channelId: string,
  settings: ChannelSettings,
): Promise<GpsState> {
  if (reviewDemoActive()) {
    // Not even read: the stored live fix plays no part while the demo is on.
    const now = Date.now();
    return { status: 'ok', sample: reviewDemoSample(now), ageMs: 0, source: 'review_demo' };
  }
  return classify(await getLatestSample(channelId), settings);
}

/**
 * The origin used for routing and pricing. Viewers can never supply this.
 * While REVIEW_DEMO_MODE is on it is the demo fix (see the top of this file).
 */
export async function requireFreshGps(
  channelId: string,
  settings: ChannelSettings,
): Promise<GpsSample> {
  const state = await getGpsState(channelId, settings);
  if (state.status === 'ok' && state.sample) return state.sample;

  const reason =
    state.status === 'missing'
      ? 'GPS временно недоступен'
      : state.status === 'stale'
        ? 'GPS временно недоступен (сигнал устарел)'
        : 'GPS временно недоступен (низкая точность)';
  throw new AppError('gps_unavailable', reason, 409, { status: state.status, ageMs: state.ageMs });
}

/**
 * The viewer-facing position.
 *
 * `viewerLocationDelaySeconds` picks the newest sample that is already at least
 * that old, so a viewer watching the stream cannot use the map to be ahead of
 * the broadcast. `viewerLocationPrecision` rounds it.
 */
export async function getPublicGps(
  channelId: string,
  settings: ChannelSettings,
): Promise<PublicGps> {
  if (reviewDemoActive()) {
    // A fixed point reveals nothing about where the streamer really is, so
    // the viewer delay has nothing to protect; the rounding still applies so
    // the shape matches what viewers get live.
    const demo = roundLatLng(
      { lat: env.reviewDemo.lat, lng: env.reviewDemo.lng },
      settings.viewerLocationPrecision,
    );
    return {
      status: 'ok',
      lat: demo.lat,
      lng: demo.lng,
      heading: null,
      speed: null,
      ageMs: 0,
      source: 'review_demo',
    };
  }

  const now = Date.now();
  const latest = await getLatestSample(channelId);
  const liveState = classify(latest, settings, now);

  if (!latest || liveState.status === 'missing') {
    return {
      status: 'missing',
      lat: null,
      lng: null,
      heading: null,
      speed: null,
      ageMs: null,
      source: 'live',
    };
  }

  let shown: GpsSample = latest;
  const delayMs = Math.max(0, settings.viewerLocationDelaySeconds) * 1000;

  if (delayMs > 0) {
    const cutoff = now - delayMs;
    const rows = await redis.zrevrangebyscore(K.gpsBuffer(channelId), cutoff, '-inf', 'LIMIT', 0, 1);
    const raw = rows[0];
    if (raw) {
      try {
        shown = JSON.parse(raw) as GpsSample;
      } catch {
        shown = latest;
      }
    } else {
      // Nothing old enough yet: withhold the position rather than leak a live one.
      return {
        status: liveState.status,
        lat: null,
        lng: null,
        heading: null,
        speed: null,
        ageMs: liveState.ageMs,
        source: 'live',
      };
    }
  }

  const rounded = roundLatLng(
    { lat: shown.lat, lng: shown.lng },
    settings.viewerLocationPrecision,
  );

  return {
    // Status always describes the live fix — a delayed position must not look
    // healthy when the phone has actually dropped off.
    status: liveState.status,
    lat: rounded.lat,
    lng: rounded.lng,
    heading: shown.heading,
    speed: shown.speed,
    ageMs: liveState.ageMs,
    source: 'live',
  };
}

export async function clearGps(channelId: string): Promise<void> {
  await redis.del(K.gpsLatest(channelId), K.gpsBuffer(channelId));
  lastPersistedAt.delete(channelId);
}

/** Drop GPS history past the retention window. */
export async function pruneGpsSamples(retentionHours: number): Promise<number> {
  const { rowCount } = await query(
    `DELETE FROM gps_samples WHERE received_at < now() - ($1 || ' hours')::interval`,
    [String(Math.max(1, Math.trunc(retentionHours)))],
  );
  return rowCount ?? 0;
}

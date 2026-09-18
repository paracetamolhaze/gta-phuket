import pg from 'pg';
import { env } from '../../src/env.js';

/**
 * Integration tests talk to a real Postgres and a real Redis, because the
 * things they are checking — SKIP LOCKED slot leasing, partial unique indexes,
 * SET NX idempotency — are properties of those engines, and a fake would only
 * test the fake.
 *
 * When neither is reachable the suites skip themselves instead of failing, so
 * `npm test` still runs the pure logic on a laptop with nothing started.
 */

let cachedProbe: Promise<boolean> | null = null;

async function createTestDatabaseIfMissing(): Promise<void> {
  const url = new URL(env.DATABASE_URL);
  const dbName = url.pathname.replace(/^\//, '');
  if (!dbName) return;

  const adminUrl = new URL(env.DATABASE_URL);
  adminUrl.pathname = '/postgres';

  const client = new pg.Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (rows.length === 0) {
      // Identifiers cannot be parameterised; dbName comes from our own config.
      await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
    }
  } finally {
    await client.end();
  }
}

export function servicesAvailable(): Promise<boolean> {
  cachedProbe ??= (async () => {
    try {
      await createTestDatabaseIfMissing();
      const { waitForDatabase, runMigrations } = await import('../../src/db/migrate.js');
      const { waitForRedis, redis } = await import('../../src/redis/client.js');
      await waitForDatabase(3, 500);
      await waitForRedis(3, 500);
      await runMigrations();
      await redis.flushdb();
      return true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `\n[integration] Postgres/Redis unavailable, skipping integration suites.\n` +
          `  ${(err as Error).message}\n` +
          `  Start them with: docker compose up -d postgres redis\n`,
      );
      return false;
    }
  })();
  return cachedProbe;
}

export const TEST_CHANNEL = env.TWITCH_CHANNEL_ID || '900000001';

/** Wipe every table this system writes to and re-seed the channel. */
export async function resetDatabase(): Promise<void> {
  const { query } = await import('../../src/db/pool.js');
  const { redis } = await import('../../src/redis/client.js');
  const { resetDevHelix } = await import('../../src/twitch/devHelix.js');

  await query(`TRUNCATE
      twitch_redemptions, waypoints, waypoint_quotes, twitch_reward_slots,
      eventsub_events, gps_samples, streamer_devices, oauth_states,
      broadcaster_oauth, channel_settings, channels,
      ext_diag_events, ext_request_log
    RESTART IDENTITY CASCADE`);
  await query('INSERT INTO channels (id) VALUES ($1) ON CONFLICT DO NOTHING', [TEST_CHANNEL]);
  await redis.flushdb();
  resetDevHelix();
}

/** Create the reward pool through the normal path (dev Helix stub). */
export async function seedRewardPool(size = 3): Promise<void> {
  const { ensureRewardPool } = await import('../../src/twitch/rewards.js');
  const { saveSettings } = await import('../../src/domain/settings.js');
  await saveSettings(TEST_CHANNEL, { rewardSlotPoolSize: size });
  await ensureRewardPool(TEST_CHANNEL, size);
}

export async function pushGps(lat: number, lng: number, accuracy = 6): Promise<void> {
  const { ingestGps } = await import('../../src/domain/gps.js');
  await ingestGps(TEST_CHANNEL, null, {
    lat,
    lng,
    accuracy,
    heading: 0,
    speed: 1.2,
    timestamp: Date.now(),
  });
}

export async function closeServices(): Promise<void> {
  const { closePool } = await import('../../src/db/pool.js');
  const { closeRedis } = await import('../../src/redis/client.js');
  await Promise.allSettled([closePool(), closeRedis()]);
}

/** Patong, the default starting point for every routing test. */
export const PATONG = { lat: 7.8961, lng: 98.2958 };
export const JUNGCEYLON = { lat: 7.8921, lng: 98.2966 };

import { defineConfig } from 'vitest/config';

/**
 * Unit tests (pricing, geometry, JWT, EventSub signatures) need nothing.
 * Integration tests need Postgres and Redis; they skip themselves with a clear
 * message when those are not reachable, and run for real under
 * `docker compose --profile test run --rm test`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 40_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent',
      DEV_MODE: 'true',
      TWITCH_CHANNEL_ID: process.env.TWITCH_CHANNEL_ID ?? '900000001',
      TWITCH_EXT_SECRET: process.env.TWITCH_EXT_SECRET ?? 'dGVzdC1leHRlbnNpb24tc2VjcmV0LTEyMzQ1',
      TWITCH_EVENTSUB_SECRET: process.env.TWITCH_EVENTSUB_SECRET ?? 'test-eventsub-secret-value',
      ADMIN_SESSION_SECRET: process.env.ADMIN_SESSION_SECRET ?? 'test-admin-secret',
      STREAMER_DEVICE_SECRET: process.env.STREAMER_DEVICE_SECRET ?? 'test-pair-code',
      MAPBOX_SERVER_TOKEN: process.env.MAPBOX_SERVER_TOKEN ?? 'test-mapbox-token',
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgres://gta:gta@localhost:55432/gta_phuket_test',
      REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:63790/1',
    },
  },
});

import { buildApp } from './app.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { query, closePool } from './db/pool.js';
import { runMigrations, waitForDatabase } from './db/migrate.js';
import { closeRedis, waitForRedis } from './redis/client.js';
import { getSettings } from './domain/settings.js';
import { createRealtimeServer } from './realtime/io.js';
import { setRealtimeTransport } from './realtime/bus.js';
import { startMaintenanceJobs, stopMaintenanceJobs } from './jobs/maintenance.js';
import { stopAllSimulators } from './jobs/gpsSimulator.js';
import { useDevHelix } from './twitch/devHelix.js';
import { obsUrl } from './http/auth.js';
import { ensureRewardPool } from './twitch/rewards.js';

async function bootstrap(): Promise<void> {
  const channelId = env.TWITCH_CHANNEL_ID || 'dev';

  await waitForDatabase();
  await waitForRedis();
  await runMigrations();

  await query('INSERT INTO channels (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [channelId]);
  const settings = await getSettings(channelId);

  // With no Twitch application configured, dev mode fabricates the reward pool
  // locally so the full flow is testable offline. With real credentials the
  // pool is created during the broadcaster OAuth callback instead.
  if (useDevHelix()) {
    try {
      const pool = await ensureRewardPool(channelId, settings.rewardSlotPoolSize);
      logger.warn({ pool }, 'dev reward pool ready (local stub, no real Twitch rewards)');
    } catch (err) {
      logger.error({ err }, 'dev reward pool setup failed');
    }
  }

  const app = await buildApp();
  await app.listen({ port: env.PORT, host: env.HOST });

  const io = createRealtimeServer(app.server);
  startMaintenanceJobs(channelId);

  logger.info(
    {
      port: env.PORT,
      channelId,
      devMode: env.devModeEnabled,
      twitch: useDevHelix() ? 'local stub' : env.TWITCH_CLIENT_ID ? 'configured' : 'NOT CONFIGURED',
      mapbox: env.MAPBOX_SERVER_TOKEN ? 'configured' : 'NOT CONFIGURED',
      eventsubCallback: `${env.PUBLIC_API_URL}/api/eventsub/twitch`,
      obsBrowserSource: obsUrl(),
    },
    'gta-phuket api ready',
  );

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutting down');
    stopMaintenanceJobs();
    stopAllSimulators();
    setRealtimeTransport(null);
    try {
      // Sockets first: an open WebSocket keeps the HTTP server from closing.
      io.disconnectSockets(true);
      await io.close();
      await app.close();
    } finally {
      await Promise.allSettled([closePool(), closeRedis()]);
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  logger.error({ err }, 'failed to start');
  process.exit(1);
});

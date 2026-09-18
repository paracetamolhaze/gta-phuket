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
import { ensureExchangeReward } from './twitch/exchangeReward.js';
import { loadBroadcasterTokens } from './twitch/tokens.js';
import { paymentMode } from './domain/paymentMode.js';
import { startRequestLogIngest } from './diag/ingest.js';

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

  // After the HTTP listener, and never fatal: without it only the extension
  // request log goes quiet, and Caddy keeps serving (soft_start) regardless.
  const requestLog =
    env.EXT_LOG_INGEST_PORT > 0 ? await startRequestLogIngest({ port: env.EXT_LOG_INGEST_PORT }) : null;

  const io = createRealtimeServer(app.server);
  startMaintenanceJobs(channelId);

  // The GTA$ exchange reward, in the background and never fatal: a Twitch
  // hiccup must not keep the map offline, and the admin can re-run it with
  // «СИНХР. НАГРАДУ ОБМЕНА». Only against the local stub, or against real
  // Twitch once the broadcaster has connected (before that there is no token
  // to create a reward with).
  void (async () => {
    const connected = env.realTwitch && Boolean(await loadBroadcasterTokens(channelId));
    if (!useDevHelix() && !connected) return;
    const result = await ensureExchangeReward(channelId);
    logger.info(
      { action: result.action, rewardId: result.reward.id, cost: result.reward.cost },
      'GTA$ exchange reward ready',
    );
  })().catch((err) => logger.error({ err }, 'GTA$ exchange reward setup failed at boot'));

  logger.info(
    {
      port: env.PORT,
      channelId,
      devMode: env.devModeEnabled,
      twitch: useDevHelix() ? 'local stub' : env.TWITCH_CLIENT_ID ? 'configured' : 'NOT CONFIGURED',
      mapbox: env.MAPBOX_SERVER_TOKEN ? 'configured' : 'NOT CONFIGURED',
      eventsubCallback: `${env.PUBLIC_API_URL}/api/eventsub/twitch`,
      paymentMode: paymentMode(),
      obsBrowserSource: obsUrl(),
      extRequestLog: requestLog ? `tcp :${requestLog.port}` : 'off',
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
      await requestLog?.close();
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

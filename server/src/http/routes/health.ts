import type { FastifyInstance } from 'fastify';
import { env } from '../../env.js';
import { pool } from '../../db/pool.js';
import { redis } from '../../redis/client.js';
import { useDevHelix } from '../../twitch/devHelix.js';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async (_req, reply) => {
    const checks: Record<string, string> = {};
    let healthy = true;

    // In production this endpoint is reachable by anyone, so it reports
    // liveness without the driver error strings that describe the internals.
    const describe = (err: unknown): string =>
      env.isProduction ? 'unavailable' : (err as Error).message;

    try {
      await pool.query('SELECT 1');
      checks.postgres = 'ok';
    } catch (err) {
      checks.postgres = describe(err);
      healthy = false;
    }

    try {
      await redis.ping();
      checks.redis = 'ok';
    } catch (err) {
      checks.redis = describe(err);
      healthy = false;
    }

    checks.twitch = useDevHelix() ? 'dev-stub' : env.TWITCH_CLIENT_ID ? 'configured' : 'missing';
    checks.mapbox = env.MAPBOX_SERVER_TOKEN || env.MAPBOX_PUBLIC_TOKEN ? 'configured' : 'missing';

    return reply.code(healthy ? 200 : 503).send({
      ok: healthy,
      devMode: env.devModeEnabled,
      checks,
      time: Date.now(),
    });
  });
}

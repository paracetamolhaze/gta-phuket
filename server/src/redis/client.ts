import Redis from 'ioredis';
import { env } from '../env.js';
import { logger } from '../logger.js';

function create(label: string): Redis {
  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
    enableReadyCheck: true,
  });
  client.on('error', (err) => logger.error({ err, label }, 'redis error'));
  return client;
}

/** Command connection. */
export const redis = create('main');

/**
 * Separate connection for pub/sub: a subscribed ioredis client refuses normal
 * commands, so fan-out between API instances needs its own socket.
 */
export const redisSub = create('sub');
export const redisPub = create('pub');

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([redis.quit(), redisSub.quit(), redisPub.quit()]);
}

export async function waitForRedis(attempts = 30, delayMs = 1000): Promise<void> {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      await redis.ping();
      return;
    } catch (err) {
      if (i === attempts) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

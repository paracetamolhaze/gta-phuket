import { redis } from '../redis/client.js';
import { K } from '../redis/keys.js';
import { AppError } from '../domain/types.js';

/**
 * Fixed-window counter. Coarser than a sliding log, but it is one round trip
 * and the thing it protects against is a viewer spamming paid Mapbox calls,
 * not a precisely metered API tier.
 */
export async function consumeRateLimit(
  bucket: string,
  subject: string,
  limit: number,
  windowSeconds = 60,
): Promise<{ allowed: boolean; remaining: number; resetSeconds: number }> {
  const key = K.rate(bucket, subject);
  const results = await redis.multi().incr(key).ttl(key).exec();

  const countRaw = results?.[0]?.[1];
  const ttlRaw = results?.[1]?.[1];
  const count = typeof countRaw === 'number' ? countRaw : Number(countRaw ?? 1);
  let ttl = typeof ttlRaw === 'number' ? ttlRaw : Number(ttlRaw ?? -1);

  if (ttl < 0) {
    await redis.expire(key, windowSeconds);
    ttl = windowSeconds;
  }

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    resetSeconds: ttl,
  };
}

export async function enforceRateLimit(
  bucket: string,
  subject: string,
  limit: number,
  windowSeconds = 60,
): Promise<void> {
  const result = await consumeRateLimit(bucket, subject, limit, windowSeconds);
  if (!result.allowed) {
    throw new AppError(
      'rate_limited',
      `Слишком часто. Попробуй через ${result.resetSeconds} с`,
      429,
      { retryAfterSeconds: result.resetSeconds },
    );
  }
}

import { randomUUID } from 'node:crypto';
import { redis } from './client.js';

/**
 * Minimal single-node Redlock: SET NX PX to take, compare-and-delete to release.
 * Enough for one Redis instance, which is what compose runs.
 */
export interface Lock {
  key: string;
  token: string;
  release: () => Promise<void>;
}

const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

export async function tryAcquireLock(key: string, ttlMs = 5000): Promise<Lock | null> {
  const token = randomUUID();
  const ok = await redis.set(key, token, 'PX', ttlMs, 'NX');
  if (ok !== 'OK') return null;
  return {
    key,
    token,
    release: async () => {
      await redis.eval(RELEASE_SCRIPT, 1, key, token);
    },
  };
}

export async function acquireLock(
  key: string,
  ttlMs = 5000,
  waitMs = 3000,
  pollMs = 25,
): Promise<Lock | null> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const lock = await tryAcquireLock(key, ttlMs);
    if (lock) return lock;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Run `fn` while holding `key`; throws `onBusy()` when the lock is unavailable. */
export async function withLock<T>(
  key: string,
  fn: () => Promise<T>,
  opts: { ttlMs?: number; waitMs?: number; onBusy?: () => Error } = {},
): Promise<T> {
  const lock = await acquireLock(key, opts.ttlMs ?? 5000, opts.waitMs ?? 3000);
  if (!lock) {
    throw opts.onBusy ? opts.onBusy() : new Error(`could not acquire lock ${key}`);
  }
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

import { env } from '../env.js';
import { logger } from '../logger.js';
import { getSettings } from '../domain/settings.js';
import { getGpsState } from '../domain/gps.js';
import { pruneGpsSamples } from '../domain/gps.js';
import { emitSlotCounts, expireStaleQuotes } from '../domain/waypointFlow.js';
import { query } from '../db/pool.js';
import { getSlot, releaseSlot } from '../domain/slots.js';
import { pruneEventSubEvents, retryPendingEvents } from '../twitch/eventsub.js';
import { broadcastGpsStale } from '../realtime/gpsBroadcast.js';

const QUOTE_SWEEP_MS = 5000;
const EVENT_RETRY_MS = 15_000;
const GPS_WATCH_MS = 5000;
const SLOT_REAP_MS = 30_000;
const RETENTION_MS = 60 * 60 * 1000;

let timers: NodeJS.Timeout[] = [];
let lastGpsHealthy = true;

/**
 * Background upkeep: expiring quotes (which returns reward slots and refunds
 * nothing, because nothing was charged), noticing a dropped phone, and keeping
 * the GPS history inside its retention window.
 */
export function startMaintenanceJobs(channelId: string): void {
  stopMaintenanceJobs();

  timers.push(
    setInterval(() => {
      void expireStaleQuotes(channelId).catch((err) =>
        logger.debug({ err }, 'quote sweep failed'),
      );
    }, QUOTE_SWEEP_MS),
  );

  timers.push(
    setInterval(() => {
      void (async () => {
        const settings = await getSettings(channelId);
        const state = await getGpsState(channelId, settings);
        const healthy = state.status === 'ok';
        // Edge-triggered: one event when it drops, one when it comes back.
        if (!healthy && lastGpsHealthy) broadcastGpsStale(channelId, state.ageMs);
        lastGpsHealthy = healthy;
      })().catch((err) => logger.debug({ err }, 'gps watch failed'));
    }, GPS_WATCH_MS),
  );

  // A crash between leaseSlot and attachSlot leaves a RESERVED slot that no
  // quote points at, which the quote-driven sweep can never see. reserved_at is
  // the only handle on it.
  // The webhook acknowledges Twitch before the work runs, so anything that
  // failed afterwards is finished here instead of being lost with the response.
  timers.push(
    setInterval(() => {
      void retryPendingEvents(30, 10)
        .then((n) => {
          if (n) logger.warn({ count: n }, 'retried eventsub events');
        })
        .catch((err) => logger.debug({ err }, 'eventsub retry sweep failed'));
    }, EVENT_RETRY_MS),
  );

  timers.push(
    setInterval(() => {
      void (async () => {
        const settings = await getSettings(channelId);
        const graceSeconds = settings.quoteTtlSeconds + 60;
        const { rows } = await query<{ id: string }>(
          `SELECT s.id FROM twitch_reward_slots s
            WHERE s.channel_id = $1
              AND s.status = 'RESERVED'
              AND s.reserved_at < now() - ($2 || ' seconds')::interval
              AND NOT EXISTS (
                SELECT 1 FROM waypoint_quotes q
                 WHERE q.slot_id = s.id
                   AND q.status IN ('QUOTED', 'AWAITING_REDEMPTION')
              )`,
          [channelId, String(graceSeconds)],
        );
        for (const row of rows) {
          const slot = await getSlot(row.id);
          if (!slot) continue;
          await releaseSlot(channelId, slot, 'orphaned reservation');
          logger.warn({ slotId: slot.id, index: slot.index }, 'orphaned reward slot reclaimed');
        }
        if (rows.length) await emitSlotCounts(channelId);
      })().catch((err) => logger.debug({ err }, 'slot reaper failed'));
    }, SLOT_REAP_MS),
  );

  timers.push(
    setInterval(() => {
      void (async () => {
        const gps = await pruneGpsSamples(env.GPS_RETENTION_HOURS);
        const events = await pruneEventSubEvents(7);
        if (gps || events) logger.info({ gps, events }, 'retention sweep');
      })().catch((err) => logger.debug({ err }, 'retention sweep failed'));
    }, RETENTION_MS),
  );

  for (const t of timers) t.unref?.();
  logger.info({ channelId }, 'maintenance jobs started');
}

export function stopMaintenanceJobs(): void {
  for (const t of timers) clearInterval(t);
  timers = [];
}

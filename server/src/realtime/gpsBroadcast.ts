import { emitRealtime } from './bus.js';
import { classify, getPublicGps } from '../domain/gps.js';
import type { ChannelSettings, GpsSample } from '../domain/types.js';

/**
 * Fan a fix out to both audiences with the right amount of truth in each:
 * OBS, the phone and the admin see the exact position, the Twitch extension
 * sees whatever the privacy settings allow.
 */
export async function broadcastGps(
  channelId: string,
  sample: GpsSample,
  settings: ChannelSettings,
): Promise<void> {
  emitRealtime(channelId, 'gps:update', classify(sample, settings), 'trusted');
  emitRealtime(channelId, 'gps:update', await getPublicGps(channelId, settings), 'viewers');
}

/** Tell everyone the fix went missing so the UIs can disable buying. */
export function broadcastGpsStale(channelId: string, ageMs: number | null): void {
  emitRealtime(channelId, 'gps:stale', { ageMs }, 'all');
}

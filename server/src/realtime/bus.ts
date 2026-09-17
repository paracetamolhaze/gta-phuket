import type { RealtimeEventName, RealtimeEvents } from '../domain/types.js';

/**
 * Thin indirection so domain code can publish realtime events without
 * importing the socket server (which itself needs the domain to build a
 * snapshot). The transport is installed once, at boot, by realtime/io.ts.
 */

export type Audience = 'all' | 'viewers' | 'trusted';

export interface RealtimeTransport {
  emit<K extends RealtimeEventName>(
    channelId: string,
    event: K,
    payload: RealtimeEvents[K],
    audience: Audience,
  ): void;
}

let transport: RealtimeTransport | null = null;

export function setRealtimeTransport(next: RealtimeTransport | null): void {
  transport = next;
}

/**
 * `audience`:
 *   viewers — the Twitch extension only (privacy-filtered data)
 *   trusted — OBS, streamer phone and admin (exact data)
 *   all     — both
 */
export function emitRealtime<K extends RealtimeEventName>(
  channelId: string,
  event: K,
  payload: RealtimeEvents[K],
  audience: Audience = 'all',
): void {
  transport?.emit(channelId, event, payload, audience);
}

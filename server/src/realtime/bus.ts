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
  /**
   * One viewer only: the sockets that proved, with a verified extension JWT,
   * that they are this numeric Twitch user. Wallet events go here and nowhere
   * else, because a balance is nobody else's business.
   */
  emitToViewer<K extends RealtimeEventName>(
    channelId: string,
    userId: string,
    event: K,
    payload: RealtimeEvents[K],
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

export function emitToViewer<K extends RealtimeEventName>(
  channelId: string,
  userId: string,
  event: K,
  payload: RealtimeEvents[K],
): void {
  transport?.emitToViewer(channelId, userId, event, payload);
}

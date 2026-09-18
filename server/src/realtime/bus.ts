import type { RealtimeEventName, RealtimeEvents } from '../domain/types.js';
import { noteAcceptance } from '../diag/acceptance.js';

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
  /** How many sockets are in that viewer's wallet room right now (monitoring). */
  countViewerSockets?(channelId: string, userId: string): number;
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

  // Acceptance monitor only: record that the signal went out, and to how many
  // of that viewer's sockets. Never affects delivery.
  if (event === 'wallet:updated') {
    const p = payload as Partial<RealtimeEvents['wallet:updated']>;
    noteAcceptance({
      kind: 'wallet_updated_emitted',
      channelId,
      userId,
      type: typeof p.type === 'string' ? p.type : null,
      amount: typeof p.amount === 'number' ? p.amount : null,
      balance: typeof p.balance === 'number' ? p.balance : null,
      transactionId: typeof p.transactionId === 'string' ? p.transactionId : null,
      viewerSockets: transport?.countViewerSockets?.(channelId, userId) ?? null,
    });
  }
}

import { io, type Socket } from 'socket.io-client';
import { API_BASE } from './api';
import type { RealtimeEvents } from './types';

export type SocketRole = 'viewer' | 'obs' | 'streamer' | 'admin';

export interface SocketOptions {
  role: SocketRole;
  channelId?: string;
  /**
   * A fixed token, or a function read on every (re)connect. The viewer passes
   * a function: Twitch rotates the extension JWT and issues a new one after
   * requestIdShare, and a reconnect has to present the current token, not the
   * one the socket happened to be created with.
   */
  token?: string | null | (() => string | null);
}

/**
 * socket.io already reconnects with backoff; the phone additionally goes to
 * sleep, so `forceNew` is off and the same manager is reused across wakeups.
 */
export function connectSocket(opts: SocketOptions): Socket {
  const { role, channelId, token } = opts;
  // socket.io calls a function `auth` before every connection attempt, the
  // automatic reconnects included; an object is sent as it was at creation.
  const auth =
    typeof token === 'function'
      ? (cb: (data: object) => void): void => cb({ role, channelId, token: token() ?? undefined })
      : { role, channelId, token: token ?? undefined };
  return io(API_BASE || undefined, {
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    auth,
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
    timeout: 10_000,
  });
}

/** Typed `on` helper: `bind(socket, 'gps:update', fn)`. */
export function bind<K extends keyof RealtimeEvents>(
  socket: Socket,
  event: K,
  handler: (payload: RealtimeEvents[K]) => void,
): () => void {
  socket.on(event as string, handler as (...args: unknown[]) => void);
  return () => socket.off(event as string, handler as (...args: unknown[]) => void);
}

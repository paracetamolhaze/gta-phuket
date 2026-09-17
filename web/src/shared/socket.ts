import { io, type Socket } from 'socket.io-client';
import { API_BASE } from './api';
import type { RealtimeEvents } from './types';

export type SocketRole = 'viewer' | 'obs' | 'streamer' | 'admin';

export interface SocketOptions {
  role: SocketRole;
  channelId?: string;
  token?: string | null;
}

/**
 * socket.io already reconnects with backoff; the phone additionally goes to
 * sleep, so `forceNew` is off and the same manager is reused across wakeups.
 */
export function connectSocket(opts: SocketOptions): Socket {
  return io(API_BASE || undefined, {
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    auth: { role: opts.role, channelId: opts.channelId, token: opts.token ?? undefined },
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

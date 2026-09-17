import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { redisPub, redisSub } from '../redis/client.js';
import { K } from '../redis/keys.js';
import { getSettings } from '../domain/settings.js';
import { getGpsState, getPublicGps, gpsInputSchema, ingestGps } from '../domain/gps.js';
import { getActiveWaypointView, refreshLiveNavigation } from '../domain/waypoints.js';
import { sanitizeRouteGeometry } from '../domain/privacy.js';
import { isObsToken, verifyAdminToken, verifyDeviceToken } from '../http/auth.js';
import type { RealtimeEventName, RealtimeEvents, SnapshotPayload } from '../domain/types.js';
import { setRealtimeTransport, type Audience } from './bus.js';
import { broadcastGps } from './gpsBroadcast.js';

const VIEWERS = (channelId: string): string => `ch:${channelId}:viewers`;
const TRUSTED = (channelId: string): string => `ch:${channelId}:trusted`;

interface SocketData {
  role: 'viewer' | 'obs' | 'streamer' | 'admin';
  channelId: string;
  deviceId: string | null;
}

interface FanoutMessage {
  channelId: string;
  event: string;
  payload: unknown;
  audience: Audience;
  origin: string;
}

const INSTANCE_ID = `${process.pid}-${Math.floor(Date.now() / 1000)}`;

export function createRealtimeServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    path: '/socket.io',
    // The extension is served from Twitch's CDN, so its origin is not ours.
    // Nothing here is authorised by origin; every privileged action needs a token.
    cors: { origin: true, credentials: false },
    pingInterval: 20_000,
    pingTimeout: 25_000,
    maxHttpBufferSize: 1e5,
  });

  io.use((socket, next) => {
    try {
      const auth = (socket.handshake.auth ?? {}) as Record<string, unknown>;
      const roleRaw = typeof auth.role === 'string' ? auth.role : 'viewer';
      const token = typeof auth.token === 'string' ? auth.token : null;
      const channelId =
        (typeof auth.channelId === 'string' && auth.channelId) || env.TWITCH_CHANNEL_ID || 'dev';

      const data: SocketData = { role: 'viewer', channelId, deviceId: null };

      if (roleRaw === 'streamer') {
        if (!token) throw new Error('streamer socket needs a device token');
        const claims = verifyDeviceToken(token);
        data.role = 'streamer';
        data.channelId = claims.channelId;
        data.deviceId = claims.deviceId;
      } else if (roleRaw === 'admin') {
        if (!token) throw new Error('admin socket needs a token');
        verifyAdminToken(token);
        data.role = 'admin';
      } else if (roleRaw === 'obs') {
        // The OBS source draws the exact position into the outgoing video, so
        // it is a privileged client and must present the OBS token. Without it
        // the socket still connects, but joins the viewer room and therefore
        // sees only the privacy-filtered feed.
        data.role = isObsToken(token) ? 'obs' : 'viewer';
      }

      socket.data = data;
      next();
    } catch (err) {
      next(err instanceof Error ? err : new Error('socket auth failed'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const data = socket.data as SocketData;
    const trusted = data.role !== 'viewer';
    socket.join(trusted ? TRUSTED(data.channelId) : VIEWERS(data.channelId));

    void sendSnapshot(socket).catch((err) =>
      logger.warn({ err }, 'could not send realtime snapshot'),
    );

    socket.on('ping:rtt', (cb: unknown) => {
      if (typeof cb === 'function') (cb as (t: number) => void)(Date.now());
    });

    if (data.role === 'streamer') {
      socket.on('gps:push', async (raw: unknown, ack?: unknown) => {
        try {
          const input = gpsInputSchema.parse(raw);
          const settings = await getSettings(data.channelId);
          const sample = await ingestGps(data.channelId, data.deviceId, input);

          await broadcastGps(data.channelId, sample, settings);
          await refreshLiveNavigation(data.channelId, sample, settings);
          if (typeof ack === 'function') (ack as (r: unknown) => void)({ ok: true });
        } catch (err) {
          logger.debug({ err }, 'gps push rejected');
          if (typeof ack === 'function') {
            (ack as (r: unknown) => void)({ ok: false, error: (err as Error).message });
          }
        }
      });
    }

    socket.on('disconnect', (reason) => {
      logger.debug({ role: data.role, reason }, 'socket disconnected');
    });
  });

  // ---- cross-instance fan-out -------------------------------------------
  void redisSub.subscribe(K.realtimeChannel).catch((err) => {
    logger.warn({ err }, 'realtime pubsub subscribe failed');
  });
  redisSub.on('message', (channel, raw) => {
    if (channel !== K.realtimeChannel) return;
    try {
      const msg = JSON.parse(raw) as FanoutMessage;
      if (msg.origin === INSTANCE_ID) return;
      deliver(io, msg.channelId, msg.event, msg.payload, msg.audience);
    } catch (err) {
      logger.debug({ err }, 'bad realtime fanout message');
    }
  });

  setRealtimeTransport({
    emit(channelId, event, payload, audience) {
      deliver(io, channelId, event, payload, audience);
      publish(channelId, event, payload, audience);
    },
  });

  return io;
}

function deliver(
  io: Server,
  channelId: string,
  event: string,
  payload: unknown,
  audience: Audience,
): void {
  if (audience === 'all' || audience === 'viewers') {
    io.to(VIEWERS(channelId)).emit(event, payload);
  }
  if (audience === 'all' || audience === 'trusted') {
    io.to(TRUSTED(channelId)).emit(event, payload);
  }
}

function publish(channelId: string, event: string, payload: unknown, audience: Audience): void {
  const msg: FanoutMessage = { channelId, event, payload, audience, origin: INSTANCE_ID };
  void redisPub.publish(K.realtimeChannel, JSON.stringify(msg)).catch(() => undefined);
}

async function sendSnapshot(socket: Socket): Promise<void> {
  const data = socket.data as SocketData;
  const settings = await getSettings(data.channelId);
  const trusted = data.role !== 'viewer';

  const activeWaypoint = await getActiveWaypointView(data.channelId);
  if (activeWaypoint && !trusted) {
    // The route polyline starts at the streamer's exact position, so it goes
    // through the same filter as the GPS feed before a viewer sees it.
    activeWaypoint.routeGeometry =
      sanitizeRouteGeometry(activeWaypoint.routeGeometry, settings) ?? activeWaypoint.routeGeometry;
    activeWaypoint.liveRouteGeometry = sanitizeRouteGeometry(
      activeWaypoint.liveRouteGeometry,
      settings,
    );
  }

  const snapshot: SnapshotPayload = {
    channelId: data.channelId,
    serverTime: Date.now(),
    waypointsOpen: settings.waypointsOpen,
    gps: trusted
      ? await getGpsState(data.channelId, settings)
      : await getPublicGps(data.channelId, settings),
    activeWaypoint,
  };
  if (data.role === 'admin') snapshot.settings = settings;

  socket.emit('state:snapshot', snapshot);
}

/** Used by HTTP routes that change state outside the socket path. */
export function emitTyped<K extends RealtimeEventName>(
  io: Server,
  channelId: string,
  event: K,
  payload: RealtimeEvents[K],
  audience: Audience = 'all',
): void {
  deliver(io, channelId, event, payload, audience);
  publish(channelId, event, payload, audience);
}

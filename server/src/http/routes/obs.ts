import type { FastifyInstance } from 'fastify';
import { env } from '../../env.js';
import { PHUKET } from '../../domain/geo.js';
import { getSettings } from '../../domain/settings.js';
import { getGpsState } from '../../domain/gps.js';
import { getActiveWaypointView } from '../../domain/waypoints.js';
import { getPublicGps } from '../../domain/gps.js';
import { sanitizeRouteGeometry } from '../../domain/privacy.js';
import { isObsToken } from '../auth.js';

function channel(): string {
  return env.TWITCH_CHANNEL_ID || 'dev';
}

/**
 * The OBS browser source runs on the streaming machine, and what it draws is
 * burnt into the video, so it legitimately needs the EXACT position — the
 * broadcast delay is what protects the streamer there, not a server-side one.
 *
 * That makes it privileged, so exact data requires the OBS token (printed at
 * startup and shown in the admin console). Without a token the endpoint still
 * answers, but only with the same privacy-filtered position viewers already
 * have, so a leaked URL reveals nothing new.
 */
export async function registerObsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/obs/config', async (req) => {
    const { token } = req.query as { token?: string };
    return {
      mapboxToken: env.MAPBOX_PUBLIC_TOKEN,
      styleUrl: env.OBS_MAPBOX_STYLE_URL || env.MAPBOX_STYLE_URL,
      channelId: channel(),
      bounds: PHUKET,
      trusted: isObsToken(token),
    };
  });

  app.get('/api/obs/state', async (req) => {
    const { token } = req.query as { token?: string };
    const trusted = isObsToken(token);
    const channelId = channel();
    const settings = await getSettings(channelId);

    const waypoint = await getActiveWaypointView(channelId);
    if (waypoint && !trusted) {
      waypoint.routeGeometry =
        sanitizeRouteGeometry(waypoint.routeGeometry, settings) ?? waypoint.routeGeometry;
      waypoint.liveRouteGeometry = sanitizeRouteGeometry(waypoint.liveRouteGeometry, settings);
    }

    return {
      channelId,
      serverTime: Date.now(),
      trusted,
      gps: trusted
        ? await getGpsState(channelId, settings)
        : await getPublicGps(channelId, settings),
      activeWaypoint: waypoint,
      waypointsOpen: settings.waypointsOpen,
      gpsTimeoutSeconds: settings.gpsTimeoutSeconds,
    };
  });
}

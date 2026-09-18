import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../db/pool.js';
import { logger } from '../logger.js';
import { redis } from '../redis/client.js';
import { K } from '../redis/keys.js';
import { emitRealtime, emitToViewer } from '../realtime/bus.js';
import { getWalkingRoute } from '../maps/mapbox.js';
import { sanitizeRouteGeometry } from './privacy.js';
import { decodePolyline6, haversineMeters, remainingDistanceAlongPath } from './geo.js';
import { refundWaypoint, type RefundOutcome } from './wallet.js';
import type {
  ActiveWaypointView,
  ChannelSettings,
  GpsSample,
  Quote,
  Waypoint,
  WaypointStatus,
} from './types.js';

interface WaypointRow {
  id: string;
  channel_id: string;
  quote_id: string;
  twitch_user_id: string;
  twitch_user_name: string | null;
  dest_lat: number;
  dest_lng: number;
  dest_name: string;
  dest_category: string | null;
  distance_meters: number;
  duration_seconds: number;
  route_geometry: string;
  points_paid: number;
  currency: string;
  status: string;
  cancel_reason: string | null;
  activated_at: Date;
  completed_at: Date | null;
  canceled_at: Date | null;
}

function rowToWaypoint(row: WaypointRow): Waypoint {
  return {
    id: row.id,
    channelId: row.channel_id,
    quoteId: row.quote_id,
    twitchUserId: row.twitch_user_id,
    twitchUserName: row.twitch_user_name,
    destination: { lat: row.dest_lat, lng: row.dest_lng },
    destinationName: row.dest_name,
    destinationCategory: row.dest_category,
    routeDistanceMeters: row.distance_meters,
    routeDurationSeconds: row.duration_seconds,
    routeGeometry: row.route_geometry,
    channelPointsPaid: row.points_paid,
    currency: row.currency === 'GTA_DOLLAR' ? 'GTA_DOLLAR' : 'CHANNEL_POINTS',
    status: row.status as WaypointStatus,
    activatedAt: row.activated_at.getTime(),
    completedAt: row.completed_at?.getTime() ?? null,
    canceledAt: row.canceled_at?.getTime() ?? null,
    cancelReason: row.cancel_reason,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getActiveWaypoint(channelId: string): Promise<Waypoint | null> {
  const { rows } = await query<WaypointRow>(
    `SELECT * FROM waypoints WHERE channel_id = $1 AND status = 'ACTIVE' LIMIT 1`,
    [channelId],
  );
  const row = rows[0];
  return row ? rowToWaypoint(row) : null;
}

export async function hasActiveWaypoint(channelId: string): Promise<boolean> {
  const { rows } = await query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM waypoints WHERE channel_id = $1 AND status = 'ACTIVE') AS exists`,
    [channelId],
  );
  return rows[0]?.exists === true;
}

interface LiveNav {
  liveRouteGeometry: string | null;
  remainingDistanceMeters: number | null;
  remainingDurationSeconds: number | null;
  updatedAt: number;
}

async function readLiveNav(channelId: string): Promise<LiveNav | null> {
  const raw = await redis.get(K.activeWaypoint(channelId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LiveNav;
  } catch {
    return null;
  }
}

async function writeLiveNav(channelId: string, nav: LiveNav): Promise<void> {
  await redis.set(K.activeWaypoint(channelId), JSON.stringify(nav), 'EX', 6 * 3600);
}

export function toView(waypoint: Waypoint, nav: LiveNav | null): ActiveWaypointView {
  return {
    id: waypoint.id,
    destinationName: waypoint.destinationName,
    destinationCategory: waypoint.destinationCategory,
    destination: waypoint.destination,
    routeGeometry: waypoint.routeGeometry,
    totalDistanceMeters: Math.round(waypoint.routeDistanceMeters),
    totalDurationSeconds: Math.round(waypoint.routeDurationSeconds),
    liveRouteGeometry: nav?.liveRouteGeometry ?? null,
    remainingDistanceMeters: nav?.remainingDistanceMeters ?? Math.round(waypoint.routeDistanceMeters),
    remainingDurationSeconds:
      nav?.remainingDurationSeconds ?? Math.round(waypoint.routeDurationSeconds),
    paidBy: waypoint.twitchUserName ?? waypoint.twitchUserId,
    channelPointsPaid: waypoint.channelPointsPaid,
    currency: waypoint.currency,
    activatedAt: waypoint.activatedAt,
  };
}

/** The waypoint a quote paid for, if any. */
export async function getWaypointByQuote(quoteId: string): Promise<Waypoint | null> {
  const { rows } = await query<WaypointRow>('SELECT * FROM waypoints WHERE quote_id = $1', [
    quoteId,
  ]);
  const row = rows[0];
  return row ? rowToWaypoint(row) : null;
}

export async function getActiveWaypointView(
  channelId: string,
): Promise<ActiveWaypointView | null> {
  const waypoint = await getActiveWaypoint(channelId);
  if (!waypoint) return null;
  return toView(waypoint, await readLiveNav(channelId));
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * Insert the ACTIVE waypoint for a paid quote.
 *
 * Runs inside the caller's transaction, next to the payment bookkeeping (the
 * redemption row, or the GTA$ debit), so "paid" and "waypoint exists" commit
 * together or not at all. The partial unique index
 * `waypoints_one_active_per_channel` is what actually enforces one job at a
 * time; a losing racer gets a 23505 here. The waypoint inherits the quote's
 * currency, and `points_paid` is the quote's frozen price in it.
 */
export async function insertActiveWaypoint(
  client: PoolClient,
  quote: Quote,
): Promise<Waypoint> {
  const { rows } = await client.query<WaypointRow>(
    `INSERT INTO waypoints
       (id, channel_id, quote_id, twitch_user_id, twitch_user_name,
        dest_lat, dest_lng, dest_name, dest_category,
        distance_meters, duration_seconds, route_geometry, points_paid, status, activated_at,
        currency)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'ACTIVE', now(), $14)
     RETURNING *`,
    [
      randomUUID(),
      quote.channelId,
      quote.id,
      quote.twitchUserId,
      quote.twitchUserName,
      quote.destination.lat,
      quote.destination.lng,
      quote.destinationName,
      quote.destinationCategory,
      quote.routeDistanceMeters,
      quote.routeDurationSeconds,
      quote.routeGeometry,
      quote.channelPointsCost,
      quote.currency,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('waypoint insert returned no row');
  return rowToWaypoint(row);
}

export async function primeLiveNav(waypoint: Waypoint): Promise<void> {
  await writeLiveNav(waypoint.channelId, {
    liveRouteGeometry: waypoint.routeGeometry,
    remainingDistanceMeters: Math.round(waypoint.routeDistanceMeters),
    remainingDurationSeconds: Math.round(waypoint.routeDurationSeconds),
    updatedAt: Date.now(),
  });
}

export async function completeWaypoint(channelId: string): Promise<Waypoint | null> {
  const { rows } = await query<WaypointRow>(
    `UPDATE waypoints SET status = 'COMPLETED', completed_at = now()
      WHERE channel_id = $1 AND status = 'ACTIVE'
      RETURNING *`,
    [channelId],
  );
  const row = rows[0];
  if (!row) return null;
  await redis.del(K.activeWaypoint(channelId));
  const waypoint = rowToWaypoint(row);
  emitRealtime(channelId, 'waypoint:completed', {
    id: waypoint.id,
    quoteId: waypoint.quoteId,
    destinationName: waypoint.destinationName,
  });
  return waypoint;
}

export interface CanceledWaypoint {
  waypoint: Waypoint;
  /** Null when no GTA$ refund was asked for or none applies (Channel Points). */
  refund: RefundOutcome | null;
}

/**
 * Stop the running job.
 *
 * With `refundGta`, a waypoint bought with GTA$ gets its price back in the
 * same transaction that cancels it, so "canceled" and "refunded" cannot come
 * apart. The refund's own unique index makes it once-only whatever calls
 * this. Channel Points are never touched here: a GTA$ waypoint has no
 * redemption behind it, and a legacy one is refunded (if at all) by the admin
 * route against Twitch. Completion never refunds.
 */
export async function cancelWaypoint(
  channelId: string,
  reason: string,
  opts: { refundGta?: boolean } = {},
): Promise<CanceledWaypoint | null> {
  const canceled = await withTransaction(async (client) => {
    const { rows } = await client.query<WaypointRow>(
      `UPDATE waypoints SET status = 'CANCELED', canceled_at = now(), cancel_reason = $2
        WHERE channel_id = $1 AND status = 'ACTIVE'
        RETURNING *`,
      [channelId, reason.slice(0, 200)],
    );
    const row = rows[0];
    if (!row) return null;
    const waypoint = rowToWaypoint(row);
    const refund =
      opts.refundGta && waypoint.currency === 'GTA_DOLLAR'
        ? await refundWaypoint(client, { channelId, waypointId: waypoint.id, reason })
        : null;
    return { waypoint, refund };
  });
  if (!canceled) return null;

  // Side effects only after COMMIT: a rolled-back cancel must not have told
  // anyone the job is gone, or the buyer that they were paid back.
  await redis.del(K.activeWaypoint(channelId));
  const { waypoint, refund } = canceled;
  emitRealtime(channelId, 'waypoint:canceled', {
    id: waypoint.id,
    quoteId: waypoint.quoteId,
    reason,
  });
  if (refund?.refunded) {
    emitToViewer(channelId, refund.twitchUserId, 'wallet:updated', {
      type: 'MISSION_REFUND',
      amount: refund.amount,
      balance: refund.balance,
      transactionId: refund.transactionId,
    });
    logger.info(
      { waypointId: waypoint.id, user: refund.twitchUserId, amount: refund.amount },
      'GTA$ refunded for a canceled waypoint',
    );
  }
  return canceled;
}

export async function listRecentWaypoints(channelId: string, limit = 10): Promise<Waypoint[]> {
  const { rows } = await query<WaypointRow>(
    'SELECT * FROM waypoints WHERE channel_id = $1 ORDER BY activated_at DESC LIMIT $2',
    [channelId, limit],
  );
  return rows.map(rowToWaypoint);
}

// ---------------------------------------------------------------------------
// Live navigation
// ---------------------------------------------------------------------------

/** Full re-route no more often than this. */
const REROUTE_INTERVAL_MS = 20_000;
/** Distance from the known route that counts as a genuine detour. */
const OFF_ROUTE_METERS = 60;
/** Treat the job as visually finished inside this radius. */
export const ARRIVAL_RADIUS_METERS = 25;

/**
 * Recompute what the HUD shows after a GPS fix.
 *
 * Cheap path: project the position onto the cached route polyline. Expensive
 * path (a real Directions call): only when the streamer has wandered off the
 * line, or the cached line is old. This is what stops a 2-second GPS cadence
 * from turning into a 2-second Mapbox billing cadence.
 */
export async function refreshLiveNavigation(
  channelId: string,
  sample: GpsSample,
  settings: ChannelSettings,
): Promise<ActiveWaypointView | null> {
  const waypoint = await getActiveWaypoint(channelId);
  if (!waypoint) return null;

  const now = Date.now();
  const nav = await readLiveNav(channelId);
  const position = { lat: sample.lat, lng: sample.lng };
  const straightLine = haversineMeters(position, waypoint.destination);

  let liveRouteGeometry = nav?.liveRouteGeometry ?? waypoint.routeGeometry;
  let remainingMeters: number;
  let remainingSeconds: number;
  let offRoute = Number.POSITIVE_INFINITY;

  const path = decodePolyline6(liveRouteGeometry);
  if (path.length >= 2) {
    const projected = remainingDistanceAlongPath(path, position);
    offRoute = projected.offRouteMeters;
    remainingMeters = projected.remainingMeters;
    // Keep the original route's average pace rather than inventing one.
    const pace =
      waypoint.routeDistanceMeters > 0
        ? waypoint.routeDurationSeconds / waypoint.routeDistanceMeters
        : 1 / 1.35;
    remainingSeconds = remainingMeters * pace;
  } else {
    remainingMeters = straightLine;
    remainingSeconds = straightLine / 1.35;
  }

  const stale = !nav || now - nav.updatedAt > REROUTE_INTERVAL_MS;
  const detoured = offRoute > OFF_ROUTE_METERS;
  const arrived = straightLine <= ARRIVAL_RADIUS_METERS;

  if (!arrived && (detoured || stale)) {
    const throttleKey = K.liveRouteThrottle(channelId);
    const allowed = await redis.set(throttleKey, '1', 'PX', REROUTE_INTERVAL_MS, 'NX');
    if (allowed === 'OK') {
      try {
        const route = await getWalkingRoute(position, waypoint.destination, { cache: false });
        liveRouteGeometry = route.geometry;
        remainingMeters = route.distanceMeters;
        remainingSeconds = route.durationSeconds;
      } catch (err) {
        // A routing hiccup must not freeze the HUD; the projection above stands.
        logger.debug({ err, channelId }, 'live re-route failed, keeping projection');
      }
    }
  }

  if (arrived) {
    remainingMeters = 0;
    remainingSeconds = 0;
  }

  const next: LiveNav = {
    liveRouteGeometry,
    remainingDistanceMeters: Math.max(0, Math.round(remainingMeters)),
    remainingDurationSeconds: Math.max(0, Math.round(remainingSeconds)),
    updatedAt: nav && !stale && !detoured ? nav.updatedAt : now,
  };
  await writeLiveNav(channelId, next);

  const view = toView(waypoint, next);

  // The live route starts at the exact current position, so the viewer copy is
  // put through the same privacy filter as the GPS feed itself.
  emitRealtime(
    channelId,
    'route:update',
    {
      liveRouteGeometry: next.liveRouteGeometry,
      remainingDistanceMeters: next.remainingDistanceMeters,
      remainingDurationSeconds: next.remainingDurationSeconds,
    },
    'trusted',
  );
  emitRealtime(
    channelId,
    'route:update',
    {
      liveRouteGeometry: sanitizeRouteGeometry(next.liveRouteGeometry, settings),
      remainingDistanceMeters: next.remainingDistanceMeters,
      remainingDurationSeconds: next.remainingDurationSeconds,
    },
    'viewers',
  );
  return view;
}

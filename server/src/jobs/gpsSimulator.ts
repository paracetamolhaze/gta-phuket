import { logger } from '../logger.js';
import { getSettings } from '../domain/settings.js';
import { ingestGps } from '../domain/gps.js';
import {
  advanceAlongPath,
  bearingDegrees,
  decodePolyline6,
  haversineMeters,
} from '../domain/geo.js';
import {
  ARRIVAL_RADIUS_METERS,
  getActiveWaypoint,
  refreshLiveNavigation,
} from '../domain/waypoints.js';
import { getWalkingRoute } from '../maps/mapbox.js';
import { broadcastGps } from '../realtime/gpsBroadcast.js';
import type { LatLng, LngLat } from '../domain/types.js';

/**
 * Walks a fake streamer around Phuket so the whole chain can be exercised with
 * no phone and no stream.
 *
 * When a waypoint is active it follows the real Mapbox walking route, which is
 * what makes "remaining distance goes down" a genuine test rather than a
 * scripted animation. Development only.
 */

interface SimState {
  channelId: string;
  position: LatLng;
  speedMps: number;
  heading: number;
  path: LngLat[];
  timer: NodeJS.Timeout;
  routedForWaypointId: string | null;
}

const TICK_MS = 2000;
const sims = new Map<string, SimState>();

export function isSimulatorRunning(channelId: string): boolean {
  return sims.has(channelId);
}

export function simulatorStatus(channelId: string): {
  running: boolean;
  position: LatLng | null;
  speedMps: number | null;
} {
  const sim = sims.get(channelId);
  return {
    running: Boolean(sim),
    position: sim?.position ?? null,
    speedMps: sim?.speedMps ?? null,
  };
}

export async function startSimulator(input: {
  channelId: string;
  start: LatLng;
  speedMps?: number;
}): Promise<void> {
  stopSimulator(input.channelId);

  const state: SimState = {
    channelId: input.channelId,
    position: { ...input.start },
    speedMps: Math.min(5, Math.max(0.2, input.speedMps ?? 1.4)),
    heading: 0,
    path: [],
    routedForWaypointId: null,
    timer: setInterval(() => {
      void tick(input.channelId).catch((err) => logger.debug({ err }, 'gps sim tick failed'));
    }, TICK_MS),
  };
  sims.set(input.channelId, state);

  await push(state);
  logger.info({ channelId: input.channelId, start: input.start }, 'gps simulator started');
}

export function stopSimulator(channelId: string): void {
  const sim = sims.get(channelId);
  if (!sim) return;
  clearInterval(sim.timer);
  sims.delete(channelId);
  logger.info({ channelId }, 'gps simulator stopped');
}

export function stopAllSimulators(): void {
  for (const id of [...sims.keys()]) stopSimulator(id);
}

export function setSimulatorSpeed(channelId: string, speedMps: number): void {
  const sim = sims.get(channelId);
  if (sim) sim.speedMps = Math.min(5, Math.max(0.2, speedMps));
}

/** Teleport the simulated streamer; also used by the one-shot /api/dev/gps. */
export async function placeSimulator(channelId: string, position: LatLng): Promise<void> {
  const sim = sims.get(channelId);
  if (!sim) return;
  sim.position = { ...position };
  sim.path = [];
  sim.routedForWaypointId = null;
  await push(sim);
}

async function tick(channelId: string): Promise<void> {
  const sim = sims.get(channelId);
  if (!sim) return;

  const waypoint = await getActiveWaypoint(channelId);

  if (waypoint) {
    // Re-fetch the route when the job changes, or when the tail ran out while
    // the walker is still far from the destination. Without the distance guard
    // an arrived simulator would burn one uncached Directions call every tick.
    const arrived =
      haversineMeters(sim.position, waypoint.destination) <= ARRIVAL_RADIUS_METERS;
    if (!arrived && (sim.routedForWaypointId !== waypoint.id || sim.path.length < 2)) {
      try {
        const route = await getWalkingRoute(sim.position, waypoint.destination, { cache: false });
        sim.path = decodePolyline6(route.geometry);
        sim.routedForWaypointId = waypoint.id;
      } catch (err) {
        logger.debug({ err }, 'simulator could not route, walking straight');
        sim.path = [
          [sim.position.lng, sim.position.lat],
          [waypoint.destination.lng, waypoint.destination.lat],
        ];
        sim.routedForWaypointId = waypoint.id;
      }
    }
  } else if (sim.routedForWaypointId) {
    sim.path = [];
    sim.routedForWaypointId = null;
  }

  const stepMeters = sim.speedMps * (TICK_MS / 1000);

  if (sim.path.length >= 2) {
    const before = sim.position;
    const advanced = advanceAlongPath(sim.path, stepMeters);
    sim.position = advanced.position;
    sim.path = advanced.remaining;
    if (haversineMeters(before, sim.position) > 0.5) {
      sim.heading = bearingDegrees(before, sim.position);
    }
  } else if (waypoint) {
    // Arrived: hold still rather than drifting past the destination.
    sim.position = { ...sim.position };
  } else {
    // Idle wander so the HUD still shows a live, moving marker.
    const before = sim.position;
    sim.heading = (sim.heading + (Math.random() - 0.5) * 25 + 360) % 360;
    const rad = (sim.heading * Math.PI) / 180;
    const dLat = (stepMeters * Math.cos(rad)) / 111_320;
    const dLng =
      (stepMeters * Math.sin(rad)) / (111_320 * Math.cos((sim.position.lat * Math.PI) / 180));
    sim.position = { lat: before.lat + dLat, lng: before.lng + dLng };
  }

  await push(sim);
}

async function push(sim: SimState): Promise<void> {
  const settings = await getSettings(sim.channelId);
  const sample = await ingestGps(sim.channelId, null, {
    lat: sim.position.lat,
    lng: sim.position.lng,
    accuracy: 6,
    heading: sim.heading,
    speed: sim.speedMps,
    timestamp: Date.now(),
  });

  await broadcastGps(sim.channelId, sample, settings);
  await refreshLiveNavigation(sim.channelId, sample, settings);
}

import { decodePolyline6, encodePolyline6, haversineMeters, roundCoordinate } from './geo.js';
import type { ChannelSettings, LngLat } from './types.js';

/**
 * A walking route starts at the streamer's exact position, so handing the raw
 * polyline to a viewer would leak precisely what `viewerLocationDelaySeconds`
 * and `viewerLocationPrecision` exist to hide. Every route that leaves the
 * server towards the viewer audience goes through here first.
 *
 * With the defaults (no delay, 5 decimals ~ 1 m) this is a no-op, so the common
 * case costs nothing.
 */

/** Metres a walker covers in the delay window; deliberately generous. */
const ASSUMED_WALK_SPEED_MPS = 1.6;

export function needsRouteSanitising(settings: ChannelSettings): boolean {
  return settings.viewerLocationDelaySeconds > 0 || settings.viewerLocationPrecision < 5;
}

/**
 * Trim the head of the route by roughly the distance walked during the delay,
 * then drop coordinate precision. The result still shows where the streamer is
 * heading — which is the point — without pinpointing where they are right now.
 */
export function sanitizeRouteGeometry(
  geometry: string | null,
  settings: ChannelSettings,
): string | null {
  if (!geometry) return geometry;
  if (!needsRouteSanitising(settings)) return geometry;

  let path = decodePolyline6(geometry);
  if (path.length < 2) return geometry;

  const trimMeters = Math.max(0, settings.viewerLocationDelaySeconds) * ASSUMED_WALK_SPEED_MPS;
  if (trimMeters > 0) {
    let walked = 0;
    let cut = 0;
    for (let i = 1; i < path.length; i += 1) {
      const a = path[i - 1]!;
      const b = path[i]!;
      walked += haversineMeters({ lat: a[1], lng: a[0] }, { lat: b[1], lng: b[0] });
      if (walked >= trimMeters) {
        cut = i;
        break;
      }
    }
    // Never trim the whole route away: the destination end must survive.
    if (cut > 0 && cut < path.length - 1) path = path.slice(cut);
  }

  const decimals = settings.viewerLocationPrecision;
  if (decimals < 5) {
    const rounded: LngLat[] = [];
    for (const [lng, lat] of path) {
      const point: LngLat = [roundCoordinate(lng, decimals), roundCoordinate(lat, decimals)];
      const previous = rounded[rounded.length - 1];
      // Rounding collapses neighbours onto the same point; drop the duplicates.
      if (previous && previous[0] === point[0] && previous[1] === point[1]) continue;
      rounded.push(point);
    }
    path = rounded.length >= 2 ? rounded : path;
  }

  return encodePolyline6(path);
}

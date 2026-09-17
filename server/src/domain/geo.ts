import { PHUKET_BOUNDS } from '../env.js';
import type { BoundingBox, LatLng, LngLat, RestrictedZone } from './types.js';

const EARTH_RADIUS_M = 6_371_008.8;

export const PHUKET: BoundingBox = { ...PHUKET_BOUNDS };

export function isValidLat(lat: unknown): lat is number {
  return typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90;
}

export function isValidLng(lng: unknown): lng is number {
  return typeof lng === 'number' && Number.isFinite(lng) && lng >= -180 && lng <= 180;
}

export function isValidLatLng(p: unknown): p is LatLng {
  if (!p || typeof p !== 'object') return false;
  const { lat, lng } = p as Record<string, unknown>;
  return isValidLat(lat) && isValidLng(lng);
}

export function inBounds(p: LatLng, box: BoundingBox = PHUKET): boolean {
  return p.lng >= box.minLng && p.lng <= box.maxLng && p.lat >= box.minLat && p.lat <= box.maxLat;
}

/** Great-circle distance in metres. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const lat1 = a.lat * toRad;
  const lat2 = b.lat * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from `a` to `b`, degrees clockwise from north. */
export function bearingDegrees(a: LatLng, b: LatLng): number {
  const toRad = Math.PI / 180;
  const lat1 = a.lat * toRad;
  const lat2 = b.lat * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) / toRad + 360) % 360;
}

/**
 * Ray casting on the raw lng/lat plane. Over a polygon a few kilometres across
 * at 8 degrees north the planar approximation is far below GPS noise, and the
 * zones are hand-drawn safety boxes rather than survey data.
 */
export function pointInPolygon(point: LatLng, ring: LngLat[]): boolean {
  if (ring.length < 3) return false;
  const { lng: x, lat: y } = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const pi = ring[i];
    const pj = ring[j];
    if (!pi || !pj) continue;
    const [xi, yi] = pi;
    const [xj, yj] = pj;
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function findRestrictedZone(
  point: LatLng,
  zones: RestrictedZone[],
): RestrictedZone | null {
  for (const zone of zones) {
    if (Array.isArray(zone.polygon) && pointInPolygon(point, zone.polygon)) return zone;
  }
  return null;
}

/**
 * Drop coordinate precision for viewer-facing output.
 * 5 decimals ~ 1 m, 4 ~ 11 m, 3 ~ 110 m, 2 ~ 1.1 km.
 */
export function roundCoordinate(value: number, decimals: number): number {
  const d = Math.max(0, Math.min(8, Math.trunc(decimals)));
  const factor = 10 ** d;
  return Math.round(value * factor) / factor;
}

export function roundLatLng(p: LatLng, decimals: number): LatLng {
  return { lat: roundCoordinate(p.lat, decimals), lng: roundCoordinate(p.lng, decimals) };
}

/** Decode a Mapbox `polyline6` string into [lng, lat] pairs. */
export function decodePolyline6(encoded: string): LngLat[] {
  const factor = 1e6;
  const coords: LngLat[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    coords.push([lng / factor, lat / factor]);
  }
  return coords;
}

export function encodePolyline6(coords: LngLat[]): string {
  const factor = 1e6;
  let out = '';
  let prevLat = 0;
  let prevLng = 0;

  const write = (value: number): void => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    while (v >= 0x20) {
      out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    out += String.fromCharCode(v + 63);
  };

  for (const [lng, lat] of coords) {
    const iLat = Math.round(lat * factor);
    const iLng = Math.round(lng * factor);
    write(iLat - prevLat);
    write(iLng - prevLng);
    prevLat = iLat;
    prevLng = iLng;
  }
  return out;
}

/**
 * Walk `meters` along a polyline and return the position plus the remaining
 * tail. Used by the dev GPS simulator to move the streamer along a real route.
 */
export function advanceAlongPath(
  path: LngLat[],
  meters: number,
): { position: LatLng; remaining: LngLat[]; finished: boolean } {
  if (path.length === 0) {
    return { position: { lat: 0, lng: 0 }, remaining: [], finished: true };
  }
  const first = path[0]!;
  if (path.length === 1 || meters <= 0) {
    return { position: { lat: first[1], lng: first[0] }, remaining: path, finished: path.length <= 1 };
  }

  let budget = meters;
  let i = 0;
  while (i < path.length - 1) {
    const a = path[i]!;
    const b = path[i + 1]!;
    const segA = { lat: a[1], lng: a[0] };
    const segB = { lat: b[1], lng: b[0] };
    const segLen = haversineMeters(segA, segB);

    if (segLen >= budget) {
      const t = segLen === 0 ? 1 : budget / segLen;
      const position: LatLng = {
        lat: segA.lat + (segB.lat - segA.lat) * t,
        lng: segA.lng + (segB.lng - segA.lng) * t,
      };
      return {
        position,
        remaining: [[position.lng, position.lat], ...path.slice(i + 1)],
        finished: false,
      };
    }
    budget -= segLen;
    i += 1;
  }

  const last = path[path.length - 1]!;
  return { position: { lat: last[1], lng: last[0] }, remaining: [last], finished: true };
}

/** Total length of a polyline in metres. */
export function pathLengthMeters(path: LngLat[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1]!;
    const b = path[i]!;
    total += haversineMeters({ lat: a[1], lng: a[0] }, { lat: b[1], lng: b[0] });
  }
  return total;
}

/**
 * Project `position` onto the polyline and return how much of it is left.
 *
 * This is what keeps "remaining distance" falling smoothly between the far
 * rarer full re-routes: walking along a known route is cheap to measure
 * locally, and only a real detour justifies another Directions call.
 */
export function remainingDistanceAlongPath(
  path: LngLat[],
  position: LatLng,
): { remainingMeters: number; offRouteMeters: number; segmentIndex: number } {
  if (path.length < 2) {
    const only = path[0];
    const offRoute = only ? haversineMeters(position, { lat: only[1], lng: only[0] }) : 0;
    return { remainingMeters: 0, offRouteMeters: offRoute, segmentIndex: 0 };
  }

  let bestOffRoute = Number.POSITIVE_INFINITY;
  let bestIndex = 0;
  let bestT = 0;

  for (let i = 0; i < path.length - 1; i += 1) {
    const a = path[i]!;
    const b = path[i + 1]!;
    // Locally flat projection: longitude is compressed by cos(lat).
    const latScale = Math.cos((position.lat * Math.PI) / 180) || 1;
    const ax = a[0] * latScale;
    const ay = a[1];
    const bx = b[0] * latScale;
    const by = b[1];
    const px = position.lng * latScale;
    const py = position.lat;

    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    const projLng = (ax + dx * t) / latScale;
    const projLat = ay + dy * t;

    const off = haversineMeters(position, { lat: projLat, lng: projLng });
    if (off < bestOffRoute) {
      bestOffRoute = off;
      bestIndex = i;
      bestT = t;
    }
  }

  const a = path[bestIndex]!;
  const b = path[bestIndex + 1]!;
  const segA = { lat: a[1], lng: a[0] };
  const segB = { lat: b[1], lng: b[0] };
  const segLen = haversineMeters(segA, segB);

  let remaining = segLen * (1 - bestT);
  for (let i = bestIndex + 1; i < path.length - 1; i += 1) {
    const p = path[i]!;
    const q = path[i + 1]!;
    remaining += haversineMeters({ lat: p[1], lng: p[0] }, { lat: q[1], lng: q[0] });
  }

  return { remainingMeters: remaining, offRouteMeters: bestOffRoute, segmentIndex: bestIndex };
}

/** Collapse whitespace and strip control characters from provider-supplied text. */
export function sanitizeName(raw: unknown, maxLength = 80): string {
  if (typeof raw !== 'string') return '';
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[ --]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

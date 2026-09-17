import { createHash } from 'node:crypto';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { redis } from '../redis/client.js';
import { K } from '../redis/keys.js';
import { haversineMeters, sanitizeName } from '../domain/geo.js';
import { AppError, type LatLng, type SearchResult, type WalkingRoute } from '../domain/types.js';

const DIRECTIONS_BASE = 'https://api.mapbox.com/directions/v5/mapbox/walking';
/**
 * Search Box, not Geocoding.
 *
 * Geocoding v6 only knows administrative places, streets and addresses — its
 * feature types do not include POI at all, so "Jungceylon" returns nothing.
 * Shops, malls, bars, beaches and attractions live in the Search Box API, and
 * those are exactly what a viewer wants to send the streamer to.
 */
const SEARCHBOX_BASE = 'https://api.mapbox.com/search/searchbox/v1/forward';
/** Administrative fallback for a query Search Box does not recognise. */
const GEOCODE_BASE = 'https://api.mapbox.com/search/geocode/v6/forward';

const ROUTE_CACHE_SECONDS = 300;
const SEARCH_CACHE_SECONDS = 3600;
const REQUEST_TIMEOUT_MS = 8000;

function serverToken(): string {
  const token = env.MAPBOX_SERVER_TOKEN || env.MAPBOX_PUBLIC_TOKEN;
  if (!token) {
    throw new AppError('internal', 'MAPBOX_SERVER_TOKEN is not configured', 500);
  }
  return token;
}

async function fetchJson<T>(url: URL, label: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      logger.warn({ label, status: res.status, body: text.slice(0, 300) }, 'mapbox request failed');
      throw new AppError('provider_error', `Mapbox ${label} returned ${res.status}`, 502);
    }
    return JSON.parse(text) as T;
  } catch (err) {
    if (err instanceof AppError) throw err;
    const reason = err instanceof Error ? err.message : 'unknown error';
    throw new AppError('provider_error', `Mapbox ${label} unreachable: ${reason}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Walking directions
// ---------------------------------------------------------------------------

interface DirectionsResponse {
  code: string;
  message?: string;
  routes?: { distance: number; duration: number; geometry: string }[];
  waypoints?: { location: [number, number]; distance?: number; name?: string }[];
}

/** ~11 m buckets. Two viewers tapping the same shopfront share one API call. */
function cacheKeyFor(origin: LatLng, destination: LatLng): string {
  const q = (v: number): string => v.toFixed(4);
  const raw = `${q(origin.lat)},${q(origin.lng)}->${q(destination.lat)},${q(destination.lng)}`;
  return createHash('sha1').update(raw).digest('hex').slice(0, 24);
}

export class NoWalkingRouteError extends AppError {
  constructor(message = 'No pedestrian route to this point') {
    super('no_walking_route', message, 422);
  }
}

/**
 * Server-side only. The viewer never sends a distance or a price, so this is
 * the single source of both.
 */
export async function getWalkingRoute(
  origin: LatLng,
  destination: LatLng,
  opts: { cache?: boolean } = {},
): Promise<WalkingRoute> {
  const useCache = opts.cache !== false;
  const key = K.routeCache(cacheKeyFor(origin, destination));

  if (useCache) {
    const cached = await redis.get(key);
    if (cached) {
      try {
        return JSON.parse(cached) as WalkingRoute;
      } catch {
        // ignore a poisoned cache entry
      }
    }
  }

  const url = new URL(
    `${DIRECTIONS_BASE}/${origin.lng},${origin.lat};${destination.lng},${destination.lat}`,
  );
  url.searchParams.set('access_token', serverToken());
  url.searchParams.set('geometries', 'polyline6');
  url.searchParams.set('overview', 'full');
  url.searchParams.set('alternatives', 'false');
  url.searchParams.set('steps', 'false');
  url.searchParams.set('walking_speed', '1.35');

  const data = await fetchJson<DirectionsResponse>(url, 'directions');

  if (data.code !== 'Ok') {
    // NoRoute/NoSegment is what a tap in the sea or on an offshore rock returns.
    if (data.code === 'NoRoute' || data.code === 'NoSegment') {
      throw new NoWalkingRouteError();
    }
    throw new AppError('provider_error', `Mapbox directions: ${data.code}`, 502);
  }

  const route = data.routes?.[0];
  if (!route) throw new NoWalkingRouteError();

  const destWaypoint = data.waypoints?.[data.waypoints.length - 1];
  const snappedRaw = destWaypoint?.location;
  const snappedDestination: LatLng = snappedRaw
    ? { lat: snappedRaw[1], lng: snappedRaw[0] }
    : destination;

  // Mapbox reports the snap distance, but not on every profile/version, so fall
  // back to measuring it ourselves.
  const snapDistanceMeters =
    typeof destWaypoint?.distance === 'number'
      ? destWaypoint.distance
      : haversineMeters(destination, snappedDestination);

  const result: WalkingRoute = {
    distanceMeters: route.distance,
    durationSeconds: route.duration,
    geometry: route.geometry,
    snappedDestination,
    snapDistanceMeters,
  };

  if (useCache) {
    await redis.set(key, JSON.stringify(result), 'EX', ROUTE_CACHE_SECONDS);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Search (Search Box first, Geocoding as a fallback), restricted to Phuket
// ---------------------------------------------------------------------------

interface SearchFeature {
  properties?: {
    name?: string;
    name_preferred?: string;
    full_address?: string;
    place_formatted?: string;
    feature_type?: string;
    mapbox_id?: string;
    maki?: string;
    poi_category?: string[];
    coordinates?: { longitude: number; latitude: number };
  };
  geometry?: { coordinates?: [number, number] };
}

interface SearchResponse {
  features?: SearchFeature[];
}

function bboxParam(bbox: {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}): string {
  return `${bbox.minLng},${bbox.minLat},${bbox.maxLng},${bbox.maxLat}`;
}

function toResults(features: SearchFeature[], proximity: LatLng | null): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  for (const feature of features) {
    const props = feature.properties ?? {};
    const coords = props.coordinates
      ? { lat: props.coordinates.latitude, lng: props.coordinates.longitude }
      : feature.geometry?.coordinates
        ? { lat: feature.geometry.coordinates[1], lng: feature.geometry.coordinates[0] }
        : null;
    if (!coords || !Number.isFinite(coords.lat) || !Number.isFinite(coords.lng)) continue;

    const name = sanitizeName(props.name_preferred ?? props.name ?? '', 80);
    if (!name) continue;

    const id = props.mapbox_id ?? `${coords.lng},${coords.lat}`;
    if (seen.has(id)) continue;
    seen.add(id);

    results.push({
      id,
      name,
      category:
        sanitizeName(props.poi_category?.[0] ?? props.maki ?? props.feature_type ?? '', 40) || null,
      address: sanitizeName(props.full_address ?? props.place_formatted ?? '', 140) || null,
      lat: coords.lat,
      lng: coords.lng,
      approxDistanceMeters: proximity ? Math.round(haversineMeters(proximity, coords)) : null,
    });
  }

  return results;
}

export async function searchPlaces(
  q: string,
  opts: {
    proximity?: LatLng | null;
    bbox: { minLng: number; minLat: number; maxLng: number; maxLat: number };
    limit?: number;
    language?: string;
  },
): Promise<SearchResult[]> {
  const term = q.trim().slice(0, 120);
  if (term.length < 2) return [];

  const limit = Math.min(10, opts.limit ?? 8);
  const language = opts.language ?? 'ru';
  const proximity = opts.proximity ?? null;

  const hash = createHash('sha1')
    .update(`${term.toLowerCase()}|${language}|${limit}`)
    .digest('hex')
    .slice(0, 24);
  const key = K.searchCache(hash);

  const cached = await redis.get(key);
  if (cached) {
    try {
      // Cached without the proximity-dependent distance, so a moving streamer
      // still gets a hit; the distance is recomputed below.
      return toResults(JSON.parse(cached) as SearchFeature[], proximity);
    } catch {
      // fall through and ask Mapbox again
    }
  }

  const searchUrl = new URL(SEARCHBOX_BASE);
  searchUrl.searchParams.set('access_token', serverToken());
  searchUrl.searchParams.set('q', term);
  searchUrl.searchParams.set('limit', String(limit));
  searchUrl.searchParams.set('language', language);
  searchUrl.searchParams.set('country', 'TH');
  searchUrl.searchParams.set('bbox', bboxParam(opts.bbox));
  searchUrl.searchParams.set('types', 'poi,address,street,place,neighborhood');
  if (proximity) searchUrl.searchParams.set('proximity', `${proximity.lng},${proximity.lat}`);

  let features: SearchFeature[] = [];
  try {
    features = (await fetchJson<SearchResponse>(searchUrl, 'search')).features ?? [];
  } catch (err) {
    logger.debug({ err }, 'search box query failed, trying geocoding');
  }

  if (features.length === 0) {
    const geoUrl = new URL(GEOCODE_BASE);
    geoUrl.searchParams.set('access_token', serverToken());
    geoUrl.searchParams.set('q', term);
    geoUrl.searchParams.set('limit', String(limit));
    geoUrl.searchParams.set('language', language);
    geoUrl.searchParams.set('country', 'th');
    geoUrl.searchParams.set('bbox', bboxParam(opts.bbox));
    if (proximity) geoUrl.searchParams.set('proximity', `${proximity.lng},${proximity.lat}`);
    features = (await fetchJson<SearchResponse>(geoUrl, 'geocoding')).features ?? [];
  }

  await redis.set(key, JSON.stringify(features), 'EX', SEARCH_CACHE_SECONDS);
  return toResults(features, proximity);
}

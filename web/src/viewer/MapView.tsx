/**
 * The map. Everything else in the overlay is chrome around this.
 *
 * Nothing here computes a price or a distance: the streamer marker, the route
 * line and the destination pin are pure renderings of server state.
 */

import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import { routeToGeoJson } from '../shared/format';
import type { LatLng, PublicGps } from '../shared/types';

// ---------------------------------------------------------------------------
// Config coming from GET /api/ext/config
// ---------------------------------------------------------------------------

export interface ExtConfigBounds {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

export interface ExtConfig {
  mapboxToken: string | null;
  styleUrl: string | null;
  bounds: ExtConfigBounds | null;
  channelId: string | null;
}

export interface MapPick {
  lat: number;
  lng: number;
  name: string | null;
  category: string | null;
}

export interface MapFocus {
  lat: number;
  lng: number;
  zoom?: number;
  /** Bump to re-trigger the same coordinates. */
  nonce: number;
}

/** Patong — the default frame when the streamer has no fix yet. */
const PATONG: [number, number] = [98.2958, 7.8961];
const DEFAULT_ZOOM = 14;
const MOVE_MS = 600;

const FALLBACK_TOKEN = (import.meta.env.VITE_MAPBOX_PUBLIC_TOKEN as string | undefined) ?? '';
const FALLBACK_STYLE =
  (import.meta.env.VITE_MAPBOX_STYLE_URL as string | undefined) ?? 'mapbox://styles/mapbox/dark-v11';

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function boundsFromNumbers(flat: number[]): ExtConfigBounds | null {
  const [a, b, c, d] = flat;
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  return {
    minLng: Math.min(a, c),
    minLat: Math.min(b, d),
    maxLng: Math.max(a, c),
    maxLat: Math.max(b, d),
  };
}

function parseBounds(raw: unknown): ExtConfigBounds | null {
  if (!raw || typeof raw !== 'object') return null;

  if (Array.isArray(raw)) {
    const flat: number[] = [];
    for (const part of raw) {
      if (Array.isArray(part)) {
        for (const inner of part) {
          const n = asNumber(inner);
          if (n !== null) flat.push(n);
        }
      } else {
        const n = asNumber(part);
        if (n !== null) flat.push(n);
      }
    }
    return boundsFromNumbers(flat);
  }

  const rec = raw as Record<string, unknown>;
  const minLng = asNumber(rec.minLng) ?? asNumber(rec.west);
  const minLat = asNumber(rec.minLat) ?? asNumber(rec.south);
  const maxLng = asNumber(rec.maxLng) ?? asNumber(rec.east);
  const maxLat = asNumber(rec.maxLat) ?? asNumber(rec.north);
  if (minLng === null || minLat === null || maxLng === null || maxLat === null) return null;
  return { minLng, minLat, maxLng, maxLat };
}

/** Defensive parse — the backend owns this shape, we only render it. */
export function parseExtConfig(raw: unknown): ExtConfig {
  const rec = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    mapboxToken: asString(rec.mapboxToken),
    styleUrl: asString(rec.styleUrl),
    bounds: parseBounds(rec.bounds),
    channelId: asString(rec.channelId),
  };
}

// ---------------------------------------------------------------------------
// POI layer discovery
// ---------------------------------------------------------------------------

/**
 * Styles differ (dark-v11, standard, a custom studio style), so we never
 * hardcode one layer id: we scan the loaded style for symbol layers that read
 * the `poi_label` source layer or simply carry `poi` in their id.
 */
function discoverPoiLayers(map: mapboxgl.Map): string[] {
  const style = map.getStyle() as unknown;
  const layersRaw = style && typeof style === 'object' ? (style as { layers?: unknown }).layers : undefined;
  if (!Array.isArray(layersRaw)) return [];

  const ids: string[] = [];
  for (const entry of layersRaw) {
    if (!entry || typeof entry !== 'object') continue;
    const layer = entry as Record<string, unknown>;
    const id = asString(layer.id);
    if (!id) continue;
    const type = asString(layer.type);
    if (type !== 'symbol' && type !== 'circle') continue;
    const sourceLayer = asString(layer['source-layer']);
    const lower = id.toLowerCase();
    if (sourceLayer === 'poi_label' || lower.includes('poi-label') || lower.includes('poi')) ids.push(id);
  }
  return ids;
}

function readProp(props: Record<string, unknown> | null, keys: string[]): string | null {
  if (!props) return null;
  for (const key of keys) {
    const value = props[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

function position(coords: GeoJSON.Position | undefined): [number, number] | null {
  const lng = coords?.[0];
  const lat = coords?.[1];
  if (typeof lng !== 'number' || typeof lat !== 'number') return null;
  return [lng, lat];
}

// ---------------------------------------------------------------------------
// Marker DOM
// ---------------------------------------------------------------------------

function createPlayerElement(): { root: HTMLDivElement; arrow: HTMLDivElement } {
  const root = document.createElement('div');
  root.className = 'mapPlayer';

  const halo = document.createElement('div');
  halo.className = 'mapPlayerHalo';
  root.appendChild(halo);

  const arrow = document.createElement('div');
  arrow.className = 'mapPlayerArrow';
  arrow.innerHTML =
    '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">' +
    '<path d="M12 2.6 19 20.4 12 16.3 5 20.4z" fill="currentColor"/>' +
    '</svg>';
  root.appendChild(arrow);

  return { root, arrow };
}

function createPinElement(): HTMLDivElement {
  const root = document.createElement('div');
  root.className = 'mapPin';
  root.innerHTML =
    '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">' +
    '<path d="M12 1.8c-4.2 0-7.4 3.2-7.4 7.3 0 5.4 6.6 12.4 6.9 12.7a.7.7 0 0 0 1 0c.3-.3 6.9-7.3 6.9-12.7 0-4.1-3.2-7.3-7.4-7.3z" ' +
    'fill="currentColor" stroke="rgba(0,0,0,0.5)" stroke-width="0.7"/>' +
    '<circle cx="12" cy="9" r="2.6" fill="rgba(8,13,17,0.92)"/>' +
    '</svg>';
  return root;
}

const ease = (t: number): number => 1 - Math.pow(1 - t, 3);

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface MapViewProps {
  config: ExtConfig | null;
  /** The map lives inside a hidden overlay while collapsed; resize on show. */
  visible: boolean;
  player: PublicGps | null;
  /** polyline6 of the route to draw, or null. */
  routeGeometry: string | null;
  destination: LatLng | null;
  focus: MapFocus | null;
  onPick: (pick: MapPick) => void;
}

export default function MapView(props: MapViewProps) {
  const { config, visible, player, routeGeometry, destination, focus, onPick } = props;

  const hostRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const [ready, setReady] = useState(false);

  const poiLayersRef = useRef<string[]>([]);
  const playerMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const playerArrowRef = useRef<HTMLDivElement | null>(null);
  const pinMarkerRef = useRef<mapboxgl.Marker | null>(null);

  const headingRef = useRef(0);
  const animRef = useRef<number | null>(null);
  const centeredRef = useRef(false);
  const fittedRouteRef = useRef<string | null>(null);

  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const routeRef = useRef<string | null>(routeGeometry);
  routeRef.current = routeGeometry;

  // --- create the map once we have a token ---------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host || mapRef.current) return;

    const token = config?.mapboxToken ?? FALLBACK_TOKEN;
    if (!token) return;
    mapboxgl.accessToken = token;

    const bounds = config?.bounds ?? null;
    const map = new mapboxgl.Map({
      container: host,
      style: config?.styleUrl ?? FALLBACK_STYLE,
      center: PATONG,
      zoom: DEFAULT_ZOOM,
      maxBounds: bounds
        ? [
            [bounds.minLng, bounds.minLat],
            [bounds.maxLng, bounds.maxLat],
          ]
        : undefined,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      logoPosition: 'bottom-right',
    });
    map.addControl(new mapboxgl.AttributionControl({ compact: true }), 'bottom-right');
    map.touchZoomRotate.disableRotation();
    map.getCanvas().style.cursor = 'crosshair';
    mapRef.current = map;

    map.on('load', () => {
      poiLayersRef.current = discoverPoiLayers(map);
      map.addSource('route', { type: 'geojson', data: routeToGeoJson(routeRef.current) });
      map.addLayer({
        id: 'route-casing',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#05090c', 'line-width': 11, 'line-opacity': 0.9 },
      });
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffc247', 'line-width': 6 },
      });
      map.resize();
      setReady(true);
    });

    map.on('click', (event) => {
      const ids = poiLayersRef.current.filter((id) => map.getLayer(id));
      let hit: GeoJSON.Feature | undefined;
      if (ids.length > 0) {
        try {
          hit = map.queryRenderedFeatures(event.point, { layers: ids })[0];
        } catch {
          hit = undefined;
        }
      }

      let lng = event.lngLat.lng;
      let lat = event.lngLat.lat;
      const geometry = hit?.geometry;
      if (geometry && geometry.type === 'Point') {
        const exact = position(geometry.coordinates);
        if (exact) {
          lng = exact[0];
          lat = exact[1];
        }
      }

      const properties = (hit?.properties ?? null) as Record<string, unknown> | null;
      onPickRef.current({
        lat,
        lng,
        name: readProp(properties, ['name_ru', 'name_ru-Cyrl', 'name', 'name_en']),
        category: readProp(properties, ['maki', 'class', 'category_en', 'type']),
      });
    });

    return () => {
      if (animRef.current !== null) cancelAnimationFrame(animRef.current);
      animRef.current = null;
      playerMarkerRef.current?.remove();
      playerMarkerRef.current = null;
      playerArrowRef.current = null;
      pinMarkerRef.current?.remove();
      pinMarkerRef.current = null;
      fittedRouteRef.current = null;
      mapRef.current = null;
      setReady(false);
      map.remove();
    };
  }, [config]);

  // --- keep the canvas in sync with the overlay ----------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !visible) return;
    const id = window.setTimeout(() => map.resize(), 190);
    return () => window.clearTimeout(id);
  }, [visible, ready]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => mapRef.current?.resize());
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // --- streamer marker -----------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const lat = player?.lat ?? null;
    const lng = player?.lng ?? null;
    if (lat === null || lng === null) {
      playerMarkerRef.current?.remove();
      playerMarkerRef.current = null;
      playerArrowRef.current = null;
      return;
    }

    const existing = playerMarkerRef.current;
    if (!existing) {
      const { root, arrow } = createPlayerElement();
      playerArrowRef.current = arrow;
      playerMarkerRef.current = new mapboxgl.Marker({ element: root, anchor: 'center' })
        .setLngLat([lng, lat])
        .addTo(map);
    } else {
      // Tween between fixes so the chevron glides instead of teleporting.
      const from = existing.getLngLat();
      const fromLng = from.lng;
      const fromLat = from.lat;
      const startedAt = performance.now();
      if (animRef.current !== null) cancelAnimationFrame(animRef.current);
      const step = (frameTs: number): void => {
        const t = Math.min(1, (frameTs - startedAt) / MOVE_MS);
        const k = ease(t);
        existing.setLngLat([fromLng + (lng - fromLng) * k, fromLat + (lat - fromLat) * k]);
        animRef.current = t < 1 ? requestAnimationFrame(step) : null;
      };
      animRef.current = requestAnimationFrame(step);
    }

    const arrowEl = playerArrowRef.current;
    const heading = player?.heading ?? null;
    if (arrowEl) {
      if (heading === null || !Number.isFinite(heading)) {
        arrowEl.classList.add('is-unknown');
      } else {
        arrowEl.classList.remove('is-unknown');
        // Accumulate the angle so 350° -> 10° turns the short way.
        const current = headingRef.current;
        const delta = ((((heading - (current % 360)) % 360) + 540) % 360) - 180;
        headingRef.current = current + delta;
        arrowEl.style.transform = `rotate(${headingRef.current}deg)`;
      }
    }

    playerMarkerRef.current?.getElement().classList.toggle('is-stale', player?.status !== 'ok');

    if (!centeredRef.current) {
      centeredRef.current = true;
      map.jumpTo({ center: [lng, lat], zoom: DEFAULT_ZOOM });
    }
  }, [player, ready]);

  // --- route ---------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const source = map.getSource('route') as unknown as mapboxgl.GeoJSONSource | undefined;
    if (!source) return;

    const data = routeToGeoJson(routeGeometry);
    source.setData(data);

    if (!routeGeometry) {
      fittedRouteRef.current = null;
      return;
    }

    const coords = data.geometry.coordinates;
    const first = position(coords[0]);
    if (!first || coords.length < 2 || fittedRouteRef.current === routeGeometry) return;
    fittedRouteRef.current = routeGeometry;
    const box = new mapboxgl.LngLatBounds(first, first);
    for (const raw of coords) {
      const point = position(raw);
      if (point) box.extend(point);
    }
    map.fitBounds(box, { padding: 56, maxZoom: 16.5, duration: 520 });
  }, [routeGeometry, ready]);

  // --- destination pin -----------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!destination) {
      pinMarkerRef.current?.remove();
      pinMarkerRef.current = null;
      return;
    }
    const at: [number, number] = [destination.lng, destination.lat];
    const existing = pinMarkerRef.current;
    if (existing) {
      existing.setLngLat(at);
      return;
    }
    pinMarkerRef.current = new mapboxgl.Marker({ element: createPinElement(), anchor: 'bottom' })
      .setLngLat(at)
      .addTo(map);
  }, [destination, ready]);

  // --- imperative fly (search result picked) -------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !focus) return;
    map.flyTo({ center: [focus.lng, focus.lat], zoom: focus.zoom ?? 16, duration: 700, essential: true });
  }, [focus]);

  return <div className="mapHost" ref={hostRef} />;
}

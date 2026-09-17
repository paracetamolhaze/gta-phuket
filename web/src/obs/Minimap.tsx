import { useEffect, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import { routeToGeoJson } from '../shared/format';
import type { LatLng } from '../shared/types';

/**
 * The rotating minimap: a real Mapbox map turned so the direction of travel
 * points up, with the streamer pinned to the centre.
 *
 * The camera never teleports. GPS lands every 2-5 s, so each fix starts a
 * linear `easeTo` (mapbox drives it on requestAnimationFrame) that lasts
 * exactly as long as the gap between the last two fixes, and the bearing is
 * unwrapped so the map always turns the short way around the circle.
 */

/** mapbox-gl ships its own types in v3; derive ours from the runtime values. */
type MapInstance = InstanceType<typeof mapboxgl.Map>;
type MarkerInstance = InstanceType<typeof mapboxgl.Marker>;

/** Structural view of a GeoJSON source — stable across mapbox typings. */
interface GeoJsonSourceLike {
  setData(data: ReturnType<typeof routeToGeoJson>): void;
}

const ROUTE_SOURCE = 'wp-route';
const ROUTE_CASING = 'wp-route-casing';
const ROUTE_LINE = 'wp-route-line';

/** Patong, used only until the first fix arrives. */
const FALLBACK_CENTER: [number, number] = [98.2963, 7.8964];
const ZOOM = 16;
const MIN_TWEEN_MS = 800;
const MAX_TWEEN_MS = 5000;

export interface MinimapProps {
  /** Authoritative token from /api/obs/config, or the env fallback. */
  token: string;
  styleUrl: string;
  lat: number | null;
  lng: number | null;
  /** Degrees clockwise from north, or null when the device does not report it. */
  heading: number | null;
  /** Live re-routed geometry when there is one, else the purchased route. */
  routeGeometry: string | null;
  destination: LatLng | null;
  /** True when GPS is stale or missing: the map stops following, the chip shows. */
  stale: boolean;
  /** Measured gap between the last two fixes; the camera tween lasts this long. */
  followMs: number;
}

/** Signed difference in degrees, always the short way around. */
function shortestDelta(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

export function Minimap(props: MinimapProps): JSX.Element {
  const { token, styleUrl, lat, lng, heading, routeGeometry, destination, stale, followMs } = props;

  const holder = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapInstance | null>(null);
  const destRef = useRef<MarkerInstance | null>(null);
  /** Unwrapped bearing: keeps growing past 360 so easeTo never spins backwards. */
  const bearingRef = useRef(0);
  const firstFix = useRef(true);
  const followRef = useRef(followMs);
  const [styleReady, setStyleReady] = useState(false);

  followRef.current = followMs;

  // --- map lifetime ---------------------------------------------------------
  // Deliberately only keyed on token/style: position is applied by the camera
  // effect below, never by re-creating the map.
  useEffect(() => {
    const el = holder.current;
    if (!el || !token) return;

    mapboxgl.accessToken = token;
    const map = new mapboxgl.Map({
      container: el,
      style: styleUrl,
      center: FALLBACK_CENTER,
      zoom: ZOOM,
      bearing: 0,
      pitch: 0,
      interactive: false,
      attributionControl: false,
      fadeDuration: 0,
      renderWorldCopies: false,
    });

    mapRef.current = map;
    bearingRef.current = 0;
    firstFix.current = true;
    setStyleReady(false);

    // Mapbox paint properties cannot read CSS variables: these two literals are
    // the exact values of --accent and --ink-0 in shared/theme.css.
    const onLoad = (): void => {
      map.addSource(ROUTE_SOURCE, { type: 'geojson', data: routeToGeoJson(null) });
      map.addLayer({
        id: ROUTE_CASING,
        type: 'line',
        source: ROUTE_SOURCE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#05090c', 'line-width': 9, 'line-opacity': 0.85 },
      });
      map.addLayer({
        id: ROUTE_LINE,
        type: 'line',
        source: ROUTE_SOURCE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffc247', 'line-width': 4.5, 'line-opacity': 0.95 },
      });
      setStyleReady(true);
    };

    map.on('load', onLoad);

    return () => {
      destRef.current?.remove();
      destRef.current = null;
      map.remove();
      mapRef.current = null;
      setStyleReady(false);
    };
  }, [token, styleUrl]);

  // --- route ---------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !styleReady) return;
    const source = map.getSource(ROUTE_SOURCE) as unknown as GeoJsonSourceLike | undefined;
    source?.setData(routeToGeoJson(routeGeometry));
  }, [styleReady, routeGeometry]);

  // --- destination ---------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!destination) {
      destRef.current?.remove();
      destRef.current = null;
      return;
    }

    const at: [number, number] = [destination.lng, destination.lat];
    const existing = destRef.current;
    if (existing) {
      existing.setLngLat(at);
      return;
    }

    const el = document.createElement('div');
    el.className = 'obs-dest';
    const diamond = document.createElement('span');
    diamond.className = 'obs-dest__diamond';
    el.appendChild(diamond);

    destRef.current = new mapboxgl.Marker({ element: el, anchor: 'center' }).setLngLat(at).addTo(map);
  }, [destination, styleReady]);

  // --- camera --------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map || lat == null || lng == null) return;

    if (heading != null && Number.isFinite(heading)) {
      bearingRef.current += shortestDelta(bearingRef.current, heading);
    }
    const bearing = bearingRef.current;

    if (firstFix.current) {
      firstFix.current = false;
      map.jumpTo({ center: [lng, lat], bearing, zoom: ZOOM, pitch: 0 });
      return;
    }

    const duration = Math.min(Math.max(followRef.current, MIN_TWEEN_MS), MAX_TWEEN_MS);
    map.easeTo({
      center: [lng, lat],
      bearing,
      duration,
      easing: (t: number) => t,
      essential: true,
    });
  }, [lat, lng, heading]);

  return (
    <div className="obs-map-area">
      <div ref={holder} className="obs-map hud-map" />

      <span className="obs-tick obs-tick--tl" />
      <span className="obs-tick obs-tick--tr" />
      <span className="obs-tick obs-tick--bl" />
      <span className="obs-tick obs-tick--br" />

      <div className="obs-player">
        <span className="obs-player__pulse" />
        <span className="obs-player__pulse obs-player__pulse--b" />
        {/* Paint lives in obs.css: CSS vars are unreliable in SVG presentation attributes. */}
        <svg className="obs-player__arrow" viewBox="0 0 28 28" aria-hidden="true">
          <path d="M14 2.6 23 25.4 14 20.2 5 25.4Z" />
        </svg>
      </div>

      {!token ? (
        <div className="obs-flag obs-flag--faint">Нет карты</div>
      ) : stale ? (
        <div className="obs-flag obs-flag--danger">Нет GPS</div>
      ) : null}
    </div>
  );
}

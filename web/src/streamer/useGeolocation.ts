/**
 * Geolocation watch for the streamer's phone.
 *
 * The permission prompt is only ever raised from a user gesture, so the watch
 * is NOT started on mount: the surface renders a big [ВКЛЮЧИТЬ GPS] button and
 * calls `start()` from its click handler.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface LatLngLike {
  lat: number;
  lng: number;
}

/** One device fix, already normalised for the wire (`gps:push`). */
export interface GeoFix {
  lat: number;
  lng: number;
  accuracy: number;
  heading: number | null;
  speed: number | null;
  timestamp: number;
}

export type GeoState =
  /** Never started — waiting for the user to tap the button. */
  | 'idle'
  /** watchPosition is armed, no fix yet (the OS prompt may be up). */
  | 'requesting'
  /** At least one fix received and the watch is live. */
  | 'watching'
  /** PERMISSION_DENIED — only the browser settings can undo this. */
  | 'denied'
  /** The watch is armed but the device cannot get a fix at all. */
  | 'error'
  /** No Geolocation API in this browser. */
  | 'unsupported';

export interface GeolocationHandle {
  state: GeoState;
  lastPosition: GeoFix | null;
  error: string | null;
  start: () => void;
  stop: () => void;
}

const WATCH_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 2000,
  timeout: 15000,
};

// ---------------------------------------------------------------------------
// Geo maths (display only — distance that costs points always comes from the
// server; these numbers only aim an arrow and throttle uploads).
// ---------------------------------------------------------------------------

const EARTH_RADIUS_M = 6371008.8;

const toRad = (deg: number): number => (deg * Math.PI) / 180;
const toDeg = (rad: number): number => (rad * 180) / Math.PI;

export function normalizeDegrees(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

export function haversineMeters(a: LatLngLike, b: LatLngLike): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial great-circle bearing, degrees clockwise from true north. */
export function bearingDegrees(from: LatLngLike, to: LatLngLike): number {
  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const dLng = toRad(to.lng - from.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return normalizeDegrees(toDeg(Math.atan2(y, x)));
}

// ---------------------------------------------------------------------------

function toFix(position: GeolocationPosition): GeoFix {
  const c = position.coords;
  return {
    lat: c.latitude,
    lng: c.longitude,
    accuracy: Number.isFinite(c.accuracy) ? c.accuracy : 9999,
    heading: c.heading != null && Number.isFinite(c.heading) ? c.heading : null,
    speed: c.speed != null && Number.isFinite(c.speed) ? c.speed : null,
    timestamp: Number.isFinite(position.timestamp) ? position.timestamp : Date.now(),
  };
}

function supported(): boolean {
  return typeof navigator !== 'undefined' && 'geolocation' in navigator;
}

export function useGeolocation(): GeolocationHandle {
  const [state, setState] = useState<GeoState>(() => (supported() ? 'idle' : 'unsupported'));
  const [lastPosition, setLastPosition] = useState<GeoFix | null>(null);
  const [error, setError] = useState<string | null>(null);

  const watchRef = useRef<number | null>(null);
  const hasFixRef = useRef(false);

  const clearWatch = useCallback(() => {
    if (watchRef.current !== null) {
      navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
    }
  }, []);

  /** MUST be called from a user gesture: this is what raises the OS prompt. */
  const start = useCallback(() => {
    if (!supported()) {
      setState('unsupported');
      setError('Этот браузер не умеет в геолокацию');
      return;
    }
    if (watchRef.current !== null) return;

    setError(null);
    setState(hasFixRef.current ? 'watching' : 'requesting');

    watchRef.current = navigator.geolocation.watchPosition(
      (position) => {
        hasFixRef.current = true;
        setLastPosition(toFix(position));
        setError(null);
        setState('watching');
      },
      (err: GeolocationPositionError) => {
        // 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT.
        if (err.code === 1) {
          clearWatch();
          hasFixRef.current = false;
          setState('denied');
          setError('Доступ к геолокации запрещён');
          return;
        }
        // Timeouts do not kill the watch — keep it and just say so.
        setError(
          err.code === 3
            ? 'GPS не отвечает — выйди на открытое место'
            : 'Сигнал GPS недоступен',
        );
        if (!hasFixRef.current) setState('error');
      },
      WATCH_OPTIONS,
    );
  }, [clearWatch]);

  const stop = useCallback(() => {
    clearWatch();
    setState(supported() ? 'idle' : 'unsupported');
  }, [clearWatch]);

  useEffect(() => clearWatch, [clearWatch]);

  return { state, lastPosition, error, start, stop };
}

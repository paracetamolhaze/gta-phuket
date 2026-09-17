import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiClient } from '../shared/api';
import { bind, connectSocket } from '../shared/socket';
import { formatDistance, formatDuration } from '../shared/format';
import { DEFAULT_SETTINGS } from '../shared/types';
import type { ActiveWaypointView, GpsState, GpsStatus, PublicGps } from '../shared/types';
import { Minimap } from './Minimap';

/**
 * Read from the Browser Source URL (`/obs.html?token=...`).
 * Without it the HUD still renders, but on the same delayed and rounded
 * position viewers get, so a leaked URL gives nothing away.
 */
const OBS_TOKEN: string =
  new URLSearchParams(window.location.search).get('token') ?? '';

/** GET /api/obs/config */
interface ObsConfig {
  mapboxToken: string;
  styleUrl: string;
  channelId: string;
}

/** One flat shape for both the exact GpsState (role `obs`) and PublicGps. */
interface GpsView {
  status: GpsStatus;
  lat: number | null;
  lng: number | null;
  heading: number | null;
  ageMs: number | null;
  /** Browser clock when this fix arrived; drives the local staleness watchdog. */
  at: number;
}

const STAGE_W = 1920;

/** The backend is authoritative; these only cover a cold start / failed config. */
const ENV_TOKEN = (import.meta.env.VITE_MAPBOX_PUBLIC_TOKEN as string | undefined) ?? '';
const ENV_STYLE =
  (import.meta.env.VITE_MAPBOX_STYLE_URL as string | undefined) ?? 'mapbox://styles/mapbox/dark-v11';

const CONFIG_RETRY_MS = 5000;

function normalizeGps(raw: PublicGps | GpsState | null | undefined, at: number): GpsView | null {
  if (!raw) return null;
  // role 'obs' gets the exact GpsState ({ sample }); be tolerant of PublicGps.
  const sample = 'sample' in raw ? raw.sample : null;
  const flat = 'lat' in raw ? raw : null;
  return {
    status: raw.status,
    lat: sample?.lat ?? flat?.lat ?? null,
    lng: sample?.lng ?? flat?.lng ?? null,
    heading: sample?.heading ?? flat?.heading ?? null,
    ageMs: raw.ageMs ?? null,
    at,
  };
}

/** "820 м" -> { value: "820", unit: "М" }. The server owns the number. */
function splitDistance(meters: number | null): { value: string; unit: string } {
  const text = formatDistance(meters);
  const parts = text.split(' ');
  return { value: parts[0] ?? text, unit: (parts[1] ?? '').toUpperCase() };
}

export function App(): JSX.Element {
  const [config, setConfig] = useState<ObsConfig | null>(null);
  const [netReady, setNetReady] = useState(false);
  const [gps, setGps] = useState<GpsView | null>(null);
  const [waypoint, setWaypoint] = useState<ActiveWaypointView | null>(null);
  /** Longest remaining distance the SERVER reported for this waypoint = its length. */
  const [baseline, setBaseline] = useState<{ id: string; meters: number } | null>(null);
  const [gpsTimeoutMs, setGpsTimeoutMs] = useState(DEFAULT_SETTINGS.gpsTimeoutSeconds * 1000);
  const [followMs, setFollowMs] = useState(2500);
  const [tick, setTick] = useState(() => Date.now());
  const [mmBox, setMmBox] = useState('');

  const stageRef = useRef<HTMLDivElement | null>(null);
  const minimapRef = useRef<HTMLDivElement | null>(null);
  const lastFixAt = useRef(0);

  const debug = useMemo(() => new URLSearchParams(window.location.search).get('debug') === '1', []);

  // --- stage scaling -------------------------------------------------------
  useEffect(() => {
    const apply = (): void => {
      const k = window.innerWidth / STAGE_W;
      stageRef.current?.style.setProperty('--k', String(k > 0 ? k : 1));
    };
    apply();
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  }, []);

  // --- one-second watchdog clock ------------------------------------------
  useEffect(() => {
    const id = window.setInterval(() => setTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  // --- config --------------------------------------------------------------
  useEffect(() => {
    const api = new ApiClient();
    const ctrl = new AbortController();
    let alive = true;
    let retry = 0;

    const load = async (): Promise<void> => {
      try {
        const cfg = await api.get<ObsConfig>(
          `/api/obs/config${OBS_TOKEN ? `?token=${encodeURIComponent(OBS_TOKEN)}` : ''}`,
          ctrl.signal,
        );
        if (!alive) return;
        setConfig(cfg);
        setNetReady(true);
      } catch {
        if (!alive) return;
        // Open the socket anyway and fall back to the env token meanwhile.
        setNetReady(true);
        retry = window.setTimeout(() => void load(), CONFIG_RETRY_MS);
      }
    };

    void load();
    return () => {
      alive = false;
      ctrl.abort();
      window.clearTimeout(retry);
    };
  }, []);

  // --- realtime ------------------------------------------------------------
  const channelId = config?.channelId;

  useEffect(() => {
    if (!netReady) return;
    // The token is what upgrades this source from the public, privacy-filtered
    // feed to the exact position. It is in the Browser Source URL, which the
    // api prints at startup and the admin console shows.
    const socket = connectSocket({ role: 'obs', channelId, token: OBS_TOKEN });

    const takeGps = (raw: PublicGps | GpsState | null | undefined): void => {
      const at = Date.now();
      const prev = lastFixAt.current;
      lastFixAt.current = at;
      const gap = at - prev;
      if (prev > 0 && gap > 400 && gap < 10_000) setFollowMs(gap);
      setGps(normalizeGps(raw, at));
    };

    const offs = [
      bind(socket, 'state:snapshot', (p) => {
        takeGps(p.gps);
        setWaypoint(p.activeWaypoint);
        const timeout = p.settings?.gpsTimeoutSeconds;
        if (typeof timeout === 'number' && timeout > 0) setGpsTimeoutMs(timeout * 1000);
      }),
      bind(socket, 'gps:update', takeGps),
      bind(socket, 'gps:stale', (p) =>
        setGps((prev) => (prev ? { ...prev, status: 'stale', ageMs: p.ageMs } : prev)),
      ),
      bind(socket, 'waypoint:activated', (w) => setWaypoint(w)),
      bind(socket, 'waypoint:completed', () => setWaypoint(null)),
      bind(socket, 'waypoint:canceled', () => setWaypoint(null)),
      bind(socket, 'route:update', (r) =>
        setWaypoint((prev) =>
          prev
            ? {
                ...prev,
                liveRouteGeometry: r.liveRouteGeometry,
                remainingDistanceMeters: r.remainingDistanceMeters,
                remainingDurationSeconds: r.remainingDurationSeconds,
              }
            : prev,
        ),
      ),
      bind(socket, 'settings:update', (s) => {
        if (s.gpsTimeoutSeconds > 0) setGpsTimeoutMs(s.gpsTimeoutSeconds * 1000);
      }),
    ];

    return () => {
      for (const off of offs) off();
      socket.disconnect();
    };
  }, [netReady, channelId]);

  // --- route length baseline ----------------------------------------------
  useEffect(() => {
    if (!waypoint) {
      setBaseline(null);
      return;
    }
    // The server reports the purchased length; the observed maximum is only a
    // fallback for an older payload.
    const total = waypoint.totalDistanceMeters;
    if (total != null && Number.isFinite(total) && total > 0) {
      setBaseline((prev) =>
        prev && prev.id === waypoint.id && prev.meters === total
          ? prev
          : { id: waypoint.id, meters: total },
      );
      return;
    }
    const remaining = waypoint.remainingDistanceMeters;
    setBaseline((prev) => {
      if (!prev || prev.id !== waypoint.id) {
        return remaining != null ? { id: waypoint.id, meters: remaining } : null;
      }
      if (remaining != null && remaining > prev.meters) return { id: waypoint.id, meters: remaining };
      return prev;
    });
  }, [waypoint]);

  // --- derived -------------------------------------------------------------
  // 'inaccurate' still carries a usable position, so only stale/missing/silence dim the HUD.
  const stale =
    gps == null ||
    gps.lat == null ||
    gps.lng == null ||
    gps.status === 'stale' ||
    gps.status === 'missing' ||
    tick - gps.at > gpsTimeoutMs;

  const remaining = waypoint?.remainingDistanceMeters ?? null;
  const distance = splitDistance(remaining);
  const eta =
    waypoint && waypoint.remainingDurationSeconds != null
      ? `~${formatDuration(waypoint.remainingDurationSeconds).toUpperCase()}`
      : null;

  const leftPct =
    waypoint && baseline && baseline.meters > 0 && remaining != null
      ? Math.min(100, Math.max(0, (remaining / baseline.meters) * 100))
      : 100;

  // --- debug readout -------------------------------------------------------
  useEffect(() => {
    if (!debug) return;
    const el = minimapRef.current;
    if (!el) return;
    const read = (): void =>
      setMmBox(
        `minimap ${Math.round(el.offsetLeft)},${Math.round(el.offsetTop)} ` +
          `${Math.round(el.offsetWidth)}x${Math.round(el.offsetHeight)} @1920x1080`,
      );
    read();
    window.addEventListener('resize', read);
    return () => window.removeEventListener('resize', read);
  }, [debug]);

  const token = config?.mapboxToken || ENV_TOKEN;
  const styleUrl = config?.styleUrl || ENV_STYLE;

  return (
    <div className="obs-stage" ref={stageRef}>
      <div className={stale ? 'obs-minimap is-stale' : 'obs-minimap'} ref={minimapRef}>
        <Minimap
          token={token}
          styleUrl={styleUrl}
          lat={gps?.lat ?? null}
          lng={gps?.lng ?? null}
          heading={gps?.heading ?? null}
          routeGeometry={waypoint?.liveRouteGeometry ?? waypoint?.routeGeometry ?? null}
          destination={waypoint?.destination ?? null}
          stale={stale}
          followMs={followMs}
        />

        <div className="obs-strip">
          {waypoint ? (
            <>
              <div className="obs-strip__dest">
                <span className="label obs-strip__label">Цель</span>
                <div className="obs-strip__name">{waypoint.destinationName}</div>
              </div>
              <div className="obs-strip__metrics">
                <div className="obs-strip__dist num">
                  <span className="obs-strip__value">{distance.value}</span>
                  <span className="obs-strip__unit">{distance.unit}</span>
                </div>
                {eta ? <div className="obs-strip__eta num">{eta}</div> : null}
              </div>
            </>
          ) : (
            <div className="obs-strip__idle">
              <span className="obs-strip__idle-dot" />
              <span>Свободно</span>
            </div>
          )}
        </div>

        {waypoint ? (
          <div className="obs-progress">
            <div className="obs-progress__fill" style={{ width: `${leftPct}%` }} />
          </div>
        ) : null}
      </div>

      {debug ? (
        <div className="obs-debug">
          <div className="obs-debug__stage" />
          <div className="obs-debug__safe" />
          <div className="obs-debug__mm" />
          <div className="obs-debug__note obs-debug__note--safe mono">safe 5% · 1920x1080</div>
          <div className="obs-debug__note obs-debug__note--mm mono">{mmBox}</div>
        </div>
      ) : null}
    </div>
  );
}

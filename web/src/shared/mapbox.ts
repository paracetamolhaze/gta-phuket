import mapboxgl from 'mapbox-gl';
import cspWorkerUrl from 'mapbox-gl/dist/mapbox-gl-csp-worker.js?url';

/**
 * Makes Mapbox GL usable inside a Twitch extension.
 *
 * The stock mapbox-gl build boots its web worker with
 * `URL.createObjectURL(new Blob([...]))`. Twitch's extension CSP rejects that —
 * blob: scripts fall under its `eval` ban — so the map would simply never
 * start once the bundle is served from Twitch, while working fine locally
 * where no such policy applies.
 *
 * Mapbox ships a second distribution for exactly this case. `vite.config.ts`
 * aliases the bare `mapbox-gl` specifier to `mapbox-gl/dist/mapbox-gl-csp.js`
 * (which contains no Blob worker at all), and that build expects the worker to
 * be fetched from a real URL set on `mapboxgl.workerUrl`.
 *
 * The `?url` import makes Vite emit the worker as a build asset and hand back
 * its hashed path. With `base: './'` that path is relative, so it resolves
 * against wherever the page happens to live — `https://localhost:8080/` during
 * Local Test and the hashed Twitch CDN directory once the zip is uploaded.
 *
 * `workerUrl` is documented by Mapbox but missing from the shipped typings,
 * hence the single narrow cast.
 */
interface MapboxWorkerConfig {
  workerUrl: string;
}

let installed = false;

export function installMapboxCspWorker(): string {
  if (!installed) {
    (mapboxgl as unknown as MapboxWorkerConfig).workerUrl = cspWorkerUrl;
    installed = true;
  }
  return cspWorkerUrl;
}

/** The emitted worker URL, exported so the CSP check can assert it is shipped. */
export { cspWorkerUrl };

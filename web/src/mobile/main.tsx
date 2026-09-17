import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'mapbox-gl/dist/mapbox-gl.css';
import '../shared/theme.css';
import '../viewer/viewer.css';
import './mobile.css';
import App from '../viewer/App';
import { start } from '../viewer/twitch';
import { installMapboxCspWorker } from '../shared/mapbox';

/**
 * Twitch Mobile surface.
 *
 * Same backend contract and same map as the video overlay, but a different
 * shell: on a phone there is no OBS minimap burnt into the video to put an
 * invisible hit area over, and no room for one either. The mobile layout is a
 * solid bottom bar that opens the map full-bleed — see the `data-mobile="true"`
 * branch in `viewer/App.tsx` and the overrides in `mobile.css`.
 *
 * `forceMobile` is set here rather than relying on `?platform=mobile`: Twitch
 * only adds that parameter inside its own app, and this page has to render the
 * mobile layout when it is opened directly for Local Test verification too.
 */
installMapboxCspWorker();
start();

const host = document.getElementById('root');
if (!host) throw new Error('#root is missing from mobile.html');

createRoot(host).render(
  <StrictMode>
    <App forceMobile />
  </StrictMode>,
);

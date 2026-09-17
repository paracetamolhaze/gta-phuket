import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'mapbox-gl/dist/mapbox-gl.css';
import '../shared/theme.css';
import './viewer.css';
import App from './App';
import { start } from './twitch';
import { installMapboxCspWorker } from '../shared/mapbox';

// Point Mapbox at the CSP-safe worker file before any map is constructed.
// Twitch's extension CSP would reject the default blob: worker.
installMapboxCspWorker();

// Install the Twitch helper bridge (or the dev fallback) before React mounts,
// so the first authorization callback is never missed.
start();

const host = document.getElementById('root');
if (!host) throw new Error('#root is missing from video_overlay.html');

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

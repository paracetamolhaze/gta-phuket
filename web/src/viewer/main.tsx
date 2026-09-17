import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'mapbox-gl/dist/mapbox-gl.css';
import '../shared/theme.css';
import './viewer.css';
import App from './App';
import { start } from './twitch';

// Install the Twitch helper bridge (or the dev fallback) before React mounts,
// so the first authorization callback is never missed.
start();

const host = document.getElementById('root');
if (!host) throw new Error('#root is missing from viewer.html');

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

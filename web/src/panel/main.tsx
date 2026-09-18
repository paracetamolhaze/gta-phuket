import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'mapbox-gl/dist/mapbox-gl.css';
import '../shared/theme.css';
import '../viewer/viewer.css';
import './panel.css';
import App from './App';
import { start } from '../viewer/twitch';
import { installMapboxCspWorker } from '../shared/mapbox';

/**
 * Twitch Panel surface: the same wallet, identity and map as the overlay, on
 * the channel page, including while the channel is offline. See ./App.tsx.
 */
start();
installMapboxCspWorker();

const host = document.getElementById('root');
if (!host) throw new Error('#root is missing from panel.html');

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

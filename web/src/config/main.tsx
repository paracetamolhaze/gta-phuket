import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../shared/theme.css';
import './config.css';
import App from './App';
import { start } from '../viewer/twitch';

/**
 * Twitch broadcaster Config surface.
 *
 * No map here, so mapbox-gl is never imported and this bundle stays small.
 * `start('broadcaster')` only affects the local dev fallback: on real Twitch the
 * role comes from the JWT Twitch signs, and the backend re-checks it.
 */
start('broadcaster');

const host = document.getElementById('root');
if (!host) throw new Error('#root is missing from config.html');

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

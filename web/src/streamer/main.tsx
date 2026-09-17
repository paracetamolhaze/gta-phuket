import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '../shared/theme.css';
import './streamer.css';
import { App } from './App';

const host = document.getElementById('root');
if (host) {
  createRoot(host).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

/**
 * The service worker only exists so the shell survives a dead spot on the road.
 * Browsers refuse to register it outside a secure context, so do not even ask.
 */
const secureEnough =
  window.location.protocol === 'https:' ||
  window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1';

if ('serviceWorker' in navigator && secureEnough) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

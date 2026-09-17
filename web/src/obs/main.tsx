import { createRoot } from 'react-dom/client';
import 'mapbox-gl/dist/mapbox-gl.css';
import '../shared/theme.css';
import './obs.css';
import { App } from './App';

/**
 * OBS Browser Source entry.
 *
 * No StrictMode: this surface is a live render target, and the double
 * mount/unmount would build and tear down a Mapbox GL context on air.
 */
const host = document.getElementById('root');
if (!host) throw new Error('OBS HUD: #root not found');

createRoot(host).render(<App />);

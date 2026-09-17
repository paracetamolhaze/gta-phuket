import { createRoot } from 'react-dom/client';
import App from './App';
import '../shared/theme.css';
import './dev.css';

/**
 * No StrictMode here on purpose: this surface is a debugging console and the
 * double-invoked effects would open the socket twice and duplicate every line
 * of the event log, which is exactly the thing being read.
 */
const container = document.getElementById('root');
if (!container) throw new Error('#root not found in dev.html');

createRoot(container).render(<App />);

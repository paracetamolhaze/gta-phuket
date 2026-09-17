import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '../shared/theme.css';
import './admin.css';

import { App } from './App';

const host = document.getElementById('root');
if (!host) throw new Error('#root не найден');

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

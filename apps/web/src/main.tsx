/**
 * The dev3d office UI entry point.
 *
 * Mounts the console into `#root`. Everything else - the WebSocket lifecycle,
 * the office store, the three.js office - hangs off `<App />`.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App';
import './styles.css';

const host = document.getElementById('root');
if (!host) {
  throw new Error('dev3d office: #root is missing from index.html');
}

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

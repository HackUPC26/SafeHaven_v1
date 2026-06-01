/**
 * main.tsx — Vite entry point.
 *
 * Mounts <App/>. NOTE: the service worker (public/sw.js) is deliberately NOT
 * registered here — it ships only as a self-unregistering kill-switch (see its
 * header). Registering a caching SW caused stale-shell debugging churn during
 * the hackathon and would risk masking live protocol/code changes, which is
 * unacceptable for a safety tool.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('SafeHaven receiver: #root element missing from index.html');
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

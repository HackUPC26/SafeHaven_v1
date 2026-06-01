/*
 * SafeHaven receiver — service worker KILL-SWITCH.
 *
 * This file is deliberately NOT registered by the app (see src/main.tsx — there
 * is no `navigator.serviceWorker.register(...)` call). It is shipped only as a
 * kill-switch, carried over verbatim in spirit from the hackathon receiver:
 *
 *   During the hackathon a real caching SW was tried and caused more debugging
 *   churn than it saved — a cached receiver shell would mask code/protocol
 *   changes. So caching was dropped. This file remains so that ANY browser that
 *   still has an OLD SafeHaven service worker registered (from an experimental
 *   build) will, the first time it loads this script, unregister itself and
 *   nuke its caches — guaranteeing the user always gets fresh, live code.
 *
 * If/when a real offline strategy is wanted, replace this with a proper SW AND
 * add an explicit registration in main.tsx. Until then: self-destruct only.
 */

self.addEventListener('install', () => {
  // Take over as soon as possible so the unregister logic runs promptly.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Drop every cache this origin owns.
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch {
        /* best-effort */
      }
      // Unregister this worker. Existing clients keep their current SW until
      // they next navigate; after that they run network-only (no SW).
      try {
        await self.registration.unregister();
      } catch {
        /* best-effort */
      }
      // Reload open clients so they immediately pick up SW-free, live code.
      try {
        const clients = await self.clients.matchAll({ type: 'window' });
        for (const client of clients) {
          client.navigate(client.url);
        }
      } catch {
        /* best-effort */
      }
    })(),
  );
});

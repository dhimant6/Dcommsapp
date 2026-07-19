/**
 * Minimal service worker — exists to make the app INSTALLABLE (PWA criteria),
 * not to cache aggressively. Chat data must always be live; a stale-cache chat
 * app is worse than none. We cache nothing and pass every request through.
 *
 * Where this grows up later:
 *  - precache the app shell (index.html + hashed assets) for instant loads
 *  - Web Push: self.addEventListener('push', ...) — the browser-side half of
 *    the FCM story (needs a VAPID keypair + push subscription flow)
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {
  /* network passthrough — deliberately no caching for a realtime app */
});

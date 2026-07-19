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

// Web Push: payload is a doorbell ({title, body, conversationId}), never the
// message itself — recovery is the app's ?since= sync when it opens.
self.addEventListener('push', (e) => {
  let data = { title: 'Dcom', body: 'New message', conversationId: '' };
  try {
    data = { ...data, ...e.data.json() };
  } catch {
    /* keep defaults */
  }
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.conversationId || 'dcom', // collapse per-conversation
      data: { conversationId: data.conversationId },
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      if (wins[0]) return wins[0].focus();
      return self.clients.openWindow('/#/chat');
    }),
  );
});

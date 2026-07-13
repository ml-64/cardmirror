// Self-destructing service worker for the RETIRED GitHub Pages origin.
//
// The old PWA (vite-plugin-pwa, autoUpdate) checks this URL for updates on
// every launch. Because this file differs byte-wise from the old Workbox
// worker, the browser installs it — and it then deletes every cache,
// unregisters itself, and reloads open windows, so the next navigation
// hits the network and lands on the redirect page to cardmirror.app.
// Without this, installed PWAs would serve the stale cached app forever.
self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach((client) => client.navigate(client.url));
    })(),
  );
});

// Excellence Riviera Cancun resort map — service worker.
// Strategy: network-first for page navigations (site updates arrive on their
// own, no reinstall needed), cache-first for bundled assets, passthrough for
// everything cross-origin (Firebase, CDNs, fonts).
const CACHE = 'resort-map-v2';
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Leave cross-origin requests (Firebase, CDNs, fonts) alone.
  if (url.origin !== self.location.origin) return;

  if (event.request.mode === 'navigate') {
    // Pages: try the network first so updates arrive on their own;
    // fall back to the cached copy when offline.
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => caches.match(event.request).then((hit) => hit || caches.match('./index.html')))
    );
    return;
  }

  // Static assets: cache-first, then network, caching the result.
  event.respondWith(
    caches.match(event.request).then(
      (hit) =>
        hit ||
        fetch(event.request).then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          return response;
        })
    )
  );
});

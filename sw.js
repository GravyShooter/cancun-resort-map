/* Resort Map service worker — cache-first for same-origin, network passthrough for everything else.
   Bump CACHE_VERSION to push updates to installed clients. */
var CACHE_VERSION = 'resort-map-v1';
var CORE_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      return cache.addAll(CORE_ASSETS);
    }).then(function () {
      return self.skipWaiting();
    }).catch(function () {
      // install must never fail the page: proceed without a full cache
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== CACHE_VERSION) return caches.delete(key);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  // Only handle same-origin requests; Firebase, CDNs, fonts, etc. go straight to network.
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req, { ignoreSearch: false }).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (res) {
        // Cache a copy of successful same-origin responses for next time.
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE_VERSION).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      });
    }).catch(function () {
      // Offline and nothing cached: let the navigation fail naturally.
      return caches.match('./index.html');
    })
  );
});

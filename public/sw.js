const CACHE_NAME = 'nexmovies-v2';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      );
    }).then(() => clients.claim())
  );
});

// Pass all /api/ requests directly to server.js without interception
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept /api/ requests (proxy, stream, detail, search, downloads)
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Normal static assets fallback
  event.respondWith(
    caches.match(event.request).then(response => {
      return response || fetch(event.request);
    })
  );
});

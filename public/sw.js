const CACHE_NAME = 'nexmovies-v1';

// Headers to bypass security blocks
const BYPASS_HEADERS = {
  'Origin': 'https://moviebox.ph',
  'Referer': 'https://moviebox.ph/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

// THE MAGIC: Intercepting all video requests and fixing headers in the browser
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // If it's a proxy request for a video segment
  if (url.pathname.includes('/api/proxy')) {
    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) return;

    event.respondWith(
      fetch(targetUrl, {
        method: event.request.method,
        headers: {
          ...BYPASS_HEADERS,
          'Range': event.request.headers.get('Range') || ''
        },
        mode: 'cors',
        credentials: 'omit'
      }).then(response => {
        // Return a fresh response with permissive CORS
        const newHeaders = new Headers(response.headers);
        newHeaders.set('Access-Control-Allow-Origin', '*');

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: newHeaders
        });
      }).catch(err => {
        return fetch(event.request); // Fallback to normal if fails
      })
    );
  } else {
    // Normal site assets
    event.respondWith(
      caches.match(event.request).then(response => {
        return response || fetch(event.request);
      })
    );
  }
});

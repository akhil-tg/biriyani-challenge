/* Biriyani Challenge — offline cache */
const VERSION = 'v5';
const CACHE = 'bc-' + VERSION;
const CACHE_URLS = [
  '/',
  '/index.html',
  '/order.html',
  '/orders.html',
  '/deliver.html',
  '/admin.html',
  '/css/style.css',
  '/js/common.js',
  '/manifest.json',
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(CACHE_URLS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return; // let cross-origin pass through
  if (url.pathname.startsWith('/api/')) {
    // API always goes to network (online-first, offline handled by server)
    return;
  }
  // stale-while-revalidate: serve static files instantly from cache,
  // then refresh the cache in the background.
  event.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(request).then(cached => {
        const network = fetch(request)
          .then(res => {
            if (res && res.ok) {
              cache.put(request, res.clone());
            }
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    )
  );
});

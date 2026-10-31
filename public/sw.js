/* Biriyani Challenge — offline cache */
const VERSION = 'v3';
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
  const url = new URL(request.url);
  if (url.origin !== location.origin) return; // let cross-origin pass through
  if (url.pathname.startsWith('/api/')) {
    // API always goes to network (online-first, offline handled by server)
    return;
  }
  event.respondWith(
    fetch(request)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request))
  );
});

// Minimal service worker — required for PWA installability on Android Chrome.
// Strategy: network-first for HTML/JSON (so updates show up), cache-first for static assets.
const VERSION = 'lib-v1';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then(c => c.addAll(SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Don't intercept cross-origin (Open Library, Nominatim, GitHub API, OSM tiles, Leaflet CDN).
  if (url.origin !== location.origin) return;

  const isData = url.pathname.endsWith('books.json');
  const isShell = SHELL.some(p => url.pathname.endsWith(p.replace('./','/')) || url.pathname === '/' ) || url.pathname.endsWith('.html') || url.pathname.endsWith('.js') || url.pathname.endsWith('.css');

  if (isData) {
    // network-first, fall back to cache
    event.respondWith(
      fetch(req).then(r => {
        const copy = r.clone();
        caches.open(VERSION).then(c => c.put(req, copy));
        return r;
      }).catch(() => caches.match(req))
    );
    return;
  }

  if (isShell) {
    // stale-while-revalidate
    event.respondWith(
      caches.match(req).then(cached => {
        const fresh = fetch(req).then(r => {
          caches.open(VERSION).then(c => c.put(req, r.clone()));
          return r;
        }).catch(() => cached);
        return cached || fresh;
      })
    );
  }
});

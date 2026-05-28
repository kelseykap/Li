// Service worker
// Strategy:
//   - HTML/JS/CSS (shell): NETWORK-FIRST. Always try fresh first, fall back to cache only when offline.
//     This means new deployments are picked up on the next reload without clearing site data.
//   - books.json: NETWORK-FIRST. Same — always want latest from the repo.
//   - Static images (icons, manifest): cache-first (rarely change).
//   - Cross-origin (Open Library, Google Books, Nominatim, GitHub API, OSM tiles, Leaflet CDN): pass through, not cached.

const VERSION = 'lib-v3';
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
  // Activate immediately so users get the new SW on next page load
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
    // Tell any open pages a new SW has taken over so they can refresh once.
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(c => c.postMessage({ type: 'sw-activated', version: VERSION }));
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Only handle same-origin
  if (url.origin !== location.origin) return;

  const isData = url.pathname.endsWith('books.json');
  const isImage = /\.(png|jpg|jpeg|svg|webp|ico)$/i.test(url.pathname);
  const isShell = url.pathname === '/' || /\.(html|js|css|webmanifest|json)$/i.test(url.pathname);

  if (isImage && !isData) {
    // cache-first for icons
    event.respondWith(
      caches.match(req).then(cached => cached || fetch(req).then(r => {
        const copy = r.clone();
        caches.open(VERSION).then(c => c.put(req, copy));
        return r;
      }))
    );
    return;
  }

  if (isData || isShell) {
    // network-first, fall back to cache
    event.respondWith(
      fetch(req).then(r => {
        if (r && r.status === 200) {
          const copy = r.clone();
          caches.open(VERSION).then(c => c.put(req, copy));
        }
        return r;
      }).catch(() => caches.match(req).then(c => c || new Response('Offline and uncached', { status: 503 })))
    );
  }
});

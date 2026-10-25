/*
 * ATLAS service worker.
 * - App shell: cache-first, refreshed in the background.
 * - Catalogue API (home, lists, details, guide): network-first with a cached fallback, so
 *   previously viewed screens still browse offline.
 * - Artwork: cache-first with a size cap.
 * - Streams and mutations are never cached.
 */
const VERSION = 'atlas-v1';
const SHELL = `${VERSION}-shell`;
const DATA = `${VERSION}-data`;
const ART = `${VERSION}-art`;
const ART_MAX = 600;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icons/favicon.svg'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const CACHEABLE_API = /^\/api\/(home|categories|movies|series|channels|guide|live\/home|me\/list|me\/continue|status|profiles)(\/|\?|$)/;

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.pathname.startsWith('/api/stream/') || url.pathname.startsWith('/api/play/')) return;

  if (url.origin === location.origin && CACHEABLE_API.test(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(DATA).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit ?? new Response(JSON.stringify({ error: 'You’re offline.' }), { status: 503, headers: { 'Content-Type': 'application/json' } }))),
    );
    return;
  }

  if (req.destination === 'image') {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ??
          fetch(req).then((res) => {
            if (res.ok || res.type === 'opaque') {
              const copy = res.clone();
              caches.open(ART).then((c) => c.put(req, copy).then(() => trim(ART, ART_MAX)));
            }
            return res;
          }),
      ),
    );
    return;
  }

  if (url.origin === location.origin && (req.mode === 'navigate' || /\.(js|css|woff2|svg|png|webmanifest)$/.test(url.pathname))) {
    event.respondWith(
      caches.match(req.mode === 'navigate' ? '/' : req).then((hit) => {
        const network = fetch(req)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(SHELL).then((c) => c.put(req.mode === 'navigate' ? '/' : req, copy));
            }
            return res;
          })
          .catch(() => hit);
        return hit ?? network;
      }),
    );
  }
});

// Service worker SIPA : coquille applicative hors-ligne, cache des tuiles
// et des points du département, réseau d'abord pour les données de santé.
const VERSION = 'sipa-v4';
const SHELL = [
  '/',
  '/index.html',
  '/css/app.css',
  '/css/sipa-2026.css',
  '/fonts/inter-latin.woff2',
  '/fonts/inter-latin-ext.woff2',
  '/fonts/manrope-latin.woff2',
  '/fonts/manrope-latin-ext.woff2',
  '/brand/logo-mark.svg',
  '/brand/logo-mark-light.svg',
  '/brand/logo.svg',
  '/js/app.js',
  '/js/api.js',
  '/js/ui.js',
  '/js/totp.js',
  '/js/offline.js',
  '/js/pass.js',
  '/js/views/auth.js',
  '/js/views/home.js',
  '/js/views/map.js',
  '/js/views/booking.js',
  '/js/views/vault.js',
  '/js/views/chat.js',
  '/js/views/parcels.js',
  '/js/views/account.js',
  '/js/views/pro.js',
  '/vendor/leaflet.js',
  '/vendor/leaflet.css',
  '/vendor/qrcode.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-maskable.svg',
  '/icons/icon-180.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) {
    // Données sensibles : jamais mises en cache par le service worker.
    return;
  }

  if (url.origin !== location.origin) {
    // Bibliothèques et tuiles : cache d'abord, puis réseau.
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request)
          .then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(VERSION).then((cache) => cache.put(request, copy));
            }
            return response;
          })
          .catch(() => cached ?? Response.error());
      })
    );
    return;
  }

  // Coquille : réseau d'abord (mise à jour), cache en secours.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && (request.destination === 'document' || url.pathname.endsWith('.js') || url.pathname.endsWith('.css'))) {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === 'navigate') return caches.match('/index.html');
        return Response.error();
      })
  );
});

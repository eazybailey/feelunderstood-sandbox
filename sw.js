// Sandbox: the service worker is NOT registered (index.html unregisters
// any leftover worker). The renamed cache is belt-and-braces so a stray
// registration from an earlier deploy can never serve stale assets.
const CACHE_NAME = 'sandbox-v0.1';
// Note: no '/index.html' entry — vercel.json's cleanUrls answers it with a
// 308 redirect to '/', and a cached redirected response served to a
// navigation is rejected by browsers as a network error. '/' carries the
// same content without the redirect.
const STATIC_ASSETS = [
  '/',
  '/styles.css',
  '/manifest.json',
  '/vendor/react.production.min.js',
  '/vendor/react-dom.production.min.js',
  '/images/logo-feel-understood.png',
  '/images/favicon-64.png',
  '/images/icon-192.png',
  '/images/icon-512.png',
  '/images/apple-touch-icon.png',
  '/images/icon-learn.svg',
  '/images/icon-coach.svg',
  '/images/icon-practice.svg',
  '/images/icon-avatar.svg',
];

// Install: cache static assets (React is vendored under /vendor — no CDN)
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network-first for API, cache-first for assets
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Never cache API calls
  if (request.url.includes('/api/')) {
    event.respondWith(fetch(request));
    return;
  }

  // Cache-first for everything else
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      });
    }).catch(() => {
      // Offline fallback for navigation — serve the precached app shell
      if (request.mode === 'navigate') {
        return caches.match('/');
      }
    })
  );
});

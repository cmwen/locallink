const CACHE_NAME = 'locallink-shell-v2';
const SHELL_ASSETS = [
  './',
  './dashboard',
  './template',
  './index.html',
  './dashboard.html',
  './template.html',
  './manifest.webmanifest',
  './assets/styles/app.css',
  './assets/scripts/app.js',
  './assets/data/mock-state.json',
  './assets/icons/icon.svg',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png'
];
const NAV_ROUTES = new Map([
  ['/', './index.html'],
  ['/index.html', './index.html'],
  ['/dashboard', './dashboard.html'],
  ['/dashboard.html', './dashboard.html'],
  ['/template', './template.html'],
  ['/template.html', './template.html']
]);

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    const normalizedPath = url.pathname.replace(/\/$/, '') || '/';
    const shellTarget = NAV_ROUTES.get(normalizedPath) || normalizedPath;
    event.respondWith(
      fetch(shellTarget, { cache: 'no-store' })
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(shellTarget, copy)).catch(() => undefined);
          return response;
        })
        .catch(async () => {
          const cache = await caches.open(CACHE_NAME);
          return (await cache.match(shellTarget)) || (await cache.match('./index.html'));
        })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached =>
      fetch(request)
        .then(response => {
          if (!response || response.status !== 200) return response;
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy)).catch(() => undefined);
          return response;
        })
        .catch(() => cached)
    )
  );
});

const CACHE = 'kids-maths-app-v8';
const ASSETS = ['/', '/index.html', '/src/styles.css', '/src/app.js', '/src/cloud-sync.js', '/src/firebase-config.js', '/data/seed-content.json', '/data/misconception-rules.json', '/manifest.webmanifest'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  // Network-first: every online visit gets whatever's actually live on
  // Netlify right now, and the cache is refreshed alongside it. The cache
  // is only ever read from when the network request fails (i.e. offline),
  // which is the actual point of a service worker -- it should never cause
  // a deployed update to be invisible to someone who's online.
  event.respondWith(
    fetch(event.request).then(response => {
      const copy = response.clone();
      caches.open(CACHE).then(cache => cache.put(event.request, copy));
      return response;
    }).catch(() => caches.match(event.request).then(cached => cached || caches.match('/index.html')))
  );
});

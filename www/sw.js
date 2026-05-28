// Game of Life service worker — Claude-style update flow.
// New SW installs in the background. Client posts {type:'SKIP_WAITING'} when
// the user taps "Update", we skipWaiting + claim, page reloads → new version.
const CACHE = 'game101-v45';
const ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/build-version.js',
  '/supabase.js',
  '/manifest.json',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/game-of-life-mark.svg',
  '/reset.html'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (req.url.includes('supabase.co') || req.url.includes('esm.sh') || req.url.includes('cdn.plaid.com') || req.url.includes('fonts.googleapis.com') || req.url.includes('fonts.gstatic.com')) return;
  if (req.url.startsWith(self.location.origin)) {
    event.respondWith(
      fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req).then((cached) => cached || caches.match('/index.html')))
    );
  }
});

self.addEventListener('push', (event) => {
  let data = { title: 'Game of Life', body: '', url: '/' };
  try { if (event.data) data = { ...data, ...event.data.json() }; } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url || '/' }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if (w.url.includes(self.location.origin)) { w.focus(); w.navigate(url); return; }
      }
      return self.clients.openWindow(url);
    })
  );
});

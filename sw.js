// Service worker: lets the site install as an app and open without a connection.
// Network first: when online, every file comes fresh from the server (so new code
// shows up at once) and a copy is kept for offline use. Only this site's own files
// are handled; Supabase and every other address go straight to the network.
const CACHE = 'budget-shell-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        // Pages are stored under the bare address, so the magic-link #hash or ?query never matters.
        const key = req.mode === 'navigate' ? new URL('./', self.registration.scope).href : req;
        e.waitUntil(caches.open(CACHE).then((c) => c.put(key, copy)));
      }
      return res;
    } catch (err) {
      const cache = await caches.open(CACHE);
      const hit = req.mode === 'navigate'
        ? await cache.match(new URL('./', self.registration.scope).href)
        : await cache.match(req);
      if (hit) return hit;
      throw err;
    }
  })());
});

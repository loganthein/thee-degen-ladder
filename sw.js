// Service Worker — Network First (always fetches fresh, caches for offline)
const CACHE_NAME = "bet-ladder-v3";
const FILES_TO_CACHE = ["/", "/index.html", "/manifest.json", "/icon.svg"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(FILES_TO_CACHE)));
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", e => {
  if (!e.request.url.startsWith(self.location.origin)) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request).then(c => c || caches.match("/index.html")))
  );
});

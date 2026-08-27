// Service Worker — Network First (always fetches fresh, caches for offline)
const CACHE_NAME = "bet-ladder-v3";
const FILES_TO_CACHE = ["/", "/index.html", "/manifest.json", "/icon.svg"];

// ── Firebase Cloud Messaging (background push) ──────────────────────────
// Same public client config already embedded in index.html — safe to duplicate here,
// service workers can't read the page's JS state and need their own Firebase init.
importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js");
firebase.initializeApp({
  apiKey: "AIzaSyBs-HJz0s9dMcauLPT7H5OPB1k9Ax3vtA0",
  authDomain: "thee-degen-ladder.firebaseapp.com",
  projectId: "thee-degen-ladder",
  storageBucket: "thee-degen-ladder.firebasestorage.app",
  messagingSenderId: "27262663189",
  appId: "1:27262663189:web:5cfbe84bd81435e5122c1c"
});
try {
  const messaging = firebase.messaging();
  // Fires when a push arrives while no tab has focus — shows the OS notification.
  messaging.onBackgroundMessage(payload => {
    const { title, body } = payload.notification || {};
    if (title) self.registration.showNotification(title, { body, icon: "/icon.svg" });
  });
} catch (e) { /* messaging unsupported in this browser — fetch caching below still works */ }

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

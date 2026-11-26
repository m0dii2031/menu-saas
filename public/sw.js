// Service Worker: تحميل فوري للواجهة + عمل جزئي دون اتصال.
// لا يتم تخزين أي طلبات Supabase (بيانات حية دائماً).
const VERSION = "menu-v1";
const SHELL = [
  "/", "/index.html", "/assets/css/app.css", "/assets/js/config.js", "/assets/js/common.js",
  "/assets/js/store.js", "/assets/icons/icon-192.png", "/assets/icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;              // Supabase/CDN: الشبكة مباشرة
  if (url.pathname.startsWith("/manage") || url.pathname.startsWith("/admin")) return;

  if (req.mode === "navigate") {
    // Network-first للصفحة، مع نسخة احتياطية عند انقطاع الاتصال
    e.respondWith(fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put("/index.html", copy));
      return res;
    }).catch(() => caches.match("/index.html")));
    return;
  }

  // Stale-while-revalidate للملفات الثابتة
  e.respondWith(caches.open(VERSION).then(async (cache) => {
    const cached = await cache.match(req);
    const network = fetch(req).then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => cached);
    return cached || network;
  }));
});

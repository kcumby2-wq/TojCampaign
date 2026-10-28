/* TOJ app service worker — opens fast and works on a weak signal.
 * The app shell (page, styles, script, icons) is cached; everything under
 * /api always goes to the network, so data is never stale or stored here.
 * Push: shows the notification the server sends and opens the app on tap.
 */
const VERSION = "toj-app-v6";
const SHELL = ["/app/", "/app/app.css", "/app/app.js", "/app/creators.js", "/app/os.js", "/app/gfs.js", "/app/bookings.js", "/app/push.js", "/app/manifest.webmanifest", "/app/icons/icon-192.png", "/app/icons/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  if (!url.pathname.startsWith("/app/")) return;
  // Network first, so a deploy shows up right away; the cache covers a dead signal.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("/app/")))
  );
});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: "TOJ", body: e.data ? e.data.text() : "" }; }
  const title = d.title || "TOJ";
  e.waitUntil(
    Promise.all([
      self.registration.showNotification(title, {
        body: d.body || "",
        icon: "/app/icons/icon-192.png",
        badge: "/app/icons/icon-192.png",
        tag: d.tag || undefined,
        data: { url: d.url || "/app/#today" },
      }),
      typeof d.badge === "number" && self.navigator && self.navigator.setAppBadge ? self.navigator.setAppBadge(d.badge).catch(() => {}) : null,
    ])
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || "/app/#today";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes("/app/") && "focus" in c) {
          c.navigate(target).catch(() => {});
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});

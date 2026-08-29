/* ==========================================
   JESS BAKES ADMIN -- SERVICE WORKER

   Scope: "/" (registered from js/admin-shell.js, loaded on every
   admin page). Two jobs only:

   1. Web Push: receive `push` events and show a notification;
      handle `notificationclick` to focus/open the admin app and
      deep-link to the right order.
   2. A small, explicit allowlist of safe STATIC assets (this file's
      own dependencies -- manifest, icons, admin CSS/JS), cache-first
      with a network fallback that refreshes the cache.

   Everything else -- every HTML page (including every admin
   dashboard page), every Supabase API/auth request, every request to
   a different origin -- is deliberately left completely alone: the
   fetch handler simply does not call event.respondWith() for those,
   so the browser handles them exactly as if this service worker did
   not exist. This is what keeps the dashboard always fresh (no
   stale-dashboard problem -- HTML is never cached) and keeps private
   data (orders, customers, auth tokens) from ever passing through
   the Cache API.
   ========================================== */

const CACHE_VERSION = "jb-admin-static-v9";

// Exact same-origin pathnames only -- never a prefix match, never an
// HTML document, never anything under /admin/ (those are the private
// dashboard pages and must always hit the network fresh).
const STATIC_ALLOWLIST = [
    "/manifest.webmanifest",
    "/images/icons/icon-192.png",
    "/images/icons/icon-512.png",
    "/images/icons/apple-touch-icon.png",
    "/images/jess-bakes-logo.png",
    "/css/admin.css",
    "/js/supabase.js",
    "/js/admin-shell.js",
    "/js/auth.js",
    "/js/layout.js",
    "/js/login.js",
    "/js/admin-push.js"
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_VERSION)
            .then((cache) => cache.addAll(STATIC_ALLOWLIST))
            .catch(() => {}) // a single missing asset must never block install
            .then(() => self.skipWaiting())
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys()
            .then((names) => Promise.all(
                names.filter((name) => name !== CACHE_VERSION).map((name) => caches.delete(name))
            ))
            .then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", (event) => {
    const req = event.request;

    // Only ever consider safe, same-origin, GET requests against the
    // explicit allowlist above. Everything else (every .html page,
    // every /admin/* request, every Supabase request, every
    // cross-origin request) falls through untouched -- no
    // respondWith() call at all.
    if (req.method !== "GET") return;

    let url;
    try {
        url = new URL(req.url);
    } catch {
        return;
    }

    if (url.origin !== self.location.origin) return;
    if (!STATIC_ALLOWLIST.includes(url.pathname)) return;

    event.respondWith(
        caches.match(req).then((cached) => {
            const networkFetch = fetch(req)
                .then((response) => {
                    if (response && response.ok) {
                        const copy = response.clone();
                        caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
                    }
                    return response;
                })
                .catch(() => cached);

            // Cache-first for speed; always refreshes in the background
            // so a new deploy is picked up on the very next load.
            return cached || networkFetch;
        })
    );
});

/* ==========================================
   WEB PUSH
   ========================================== */

self.addEventListener("push", (event) => {

    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch {
        data = {};
    }

    const title = data.title || "🧁 New Jess Bakes order";
    const body = data.body || "";
    const tag = data.tag || "jess-bakes-order";
    const url = (data.data && data.data.url) || "/admin/orders.html";
    const orderId = (data.data && data.data.orderId) || null;

    const options = {
        body,
        tag,
        // Retried deliveries for the SAME order reuse the same tag,
        // so the OS replaces the existing alert rather than stacking
        // a second one (see also the order-based idempotency key on
        // the server side -- this is a second, independent layer).
        renotify: false,
        icon: "/images/icons/icon-192.png",
        badge: "/images/icons/icon-192.png",
        data: { url, orderId }
    };

    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {

    event.notification.close();

    const targetUrl = (event.notification.data && event.notification.data.url) || "/admin/orders.html";

    event.waitUntil((async () => {

        const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

        // Same-origin window already open -- focus it and navigate
        // there, rather than opening a second app window.
        for (const client of allClients) {
            if ("focus" in client) {
                await client.focus();
                if ("navigate" in client) {
                    try {
                        await client.navigate(targetUrl);
                    } catch {
                        // Some browsers restrict cross-document navigate()
                        // from here -- falling through to openWindow below
                        // is still safe (worst case, two windows).
                    }
                }
                return;
            }
        }

        await self.clients.openWindow(targetUrl);

    })());
});

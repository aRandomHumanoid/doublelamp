/* DoubleLamp service worker (06 A.5).
 * Caches only the app shell of one build. It never touches /api, /ws, /fw or /healthz, so live state,
 * logins and firmware downloads always go to the server. The build fills in the two placeholders.
 */
const SHELL = __SHELL_FILES__;
const CACHE = "doublelamp-shell-__SHELL_VERSION__";
const NEVER = /^\/(api|ws|fw|healthz)(\/|$)/;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith("doublelamp-shell-") && k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

function cachedShell() {
  return caches.open(CACHE).then((cache) => cache.match("/"));
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || NEVER.test(url.pathname)) return;

  if (req.mode === "navigate") {
    // Network first, so a new deploy shows up at once. If the server or the tunnel is down (network error
    // or a 5xx page from the edge), serve the cached shell, which then shows "No connection to server".
    event.respondWith(
      fetch(req)
        .then((res) => (res.status < 500 ? res : cachedShell().then((hit) => hit || res)))
        .catch(() => cachedShell().then((hit) => hit || Response.error())),
    );
    return;
  }

  if (SHELL.includes(url.pathname)) {
    event.respondWith(
      caches
        .open(CACHE)
        .then((cache) => cache.match(url.pathname))
        .then((hit) => hit || fetch(req)),
    );
  }
});

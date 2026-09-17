/* Streamer PWA service worker — deliberately small.
 *
 * It exists for one reason: a dead spot on a Phuket road must not leave the
 * phone staring at a browser error page. It caches the shell as it is fetched
 * (asset names are hashed at build time, so nothing can be precached by name
 * beyond the entry document) and it NEVER touches /api/* or /socket.io/*:
 * GPS and waypoint state must always be live or absent, never remembered.
 */

const CACHE = 'gta-streamer-v1';

/* The only paths that are stable across builds. */
const SHELL = ['/streamer.html', '/manifest.webmanifest', '/icons/icon.svg'];

const STATIC_RE = /\.(?:js|mjs|css|svg|png|jpg|jpeg|webp|avif|gif|ico|woff2?|ttf|webmanifest)$/i;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // One missing file must not fail the whole install.
      Promise.all(SHELL.map((path) => cache.add(path).catch(() => undefined))),
    ),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function isExcluded(url) {
  return url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io');
}

/* The clone has to happen synchronously, before the page starts reading the
   body — hence no await above it. */
function stash(request, response) {
  // Opaque and error responses poison a cache; keep only clean same-origin 200s.
  if (!response || !response.ok || response.type === 'opaque') return;
  const copy = response.clone();
  caches
    .open(CACHE)
    .then((cache) => cache.put(request, copy))
    .catch(() => undefined);
}

/** Navigations: always try the network first, fall back to the cached shell. */
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    stash(request, response);
    return response;
  } catch (err) {
    const cached = (await caches.match(request)) || (await caches.match('/streamer.html'));
    if (cached) return cached;
    throw err;
  }
}

/** Hashed static assets never change under a given URL: cache wins. */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  stash(request, response);
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  if (url.origin !== self.location.origin) return;
  if (isExcluded(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  if (STATIC_RE.test(url.pathname) || url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request));
  }
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

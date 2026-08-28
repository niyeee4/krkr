/* KrKr2 Web — Cross-Origin Isolated Service Worker with precaching.
 * Enables SharedArrayBuffer on GitHub Pages and static hosts without server-side header support.
 */
var CACHE_VERSION = '20260828000010';
if (CACHE_VERSION.charAt(0) === '@') CACHE_VERSION = 'dev-20260828-2';
var CACHE_NAME = 'krkr2-v' + CACHE_VERSION;

var PRECACHE_ASSETS = [
    './',
    './index.html',
    './index.js',
    './index.wasm',
    './index-asyncify.wasm',
    './assets.zip',
    './vlfs.js',
    './jspi-shim.js',
    './manifest.webmanifest',
    './pwa/icon-192.png',
    './pwa/icon-512.png',
    './coi-serviceworker.js'
];

var RUNTIME_CACHE_ORIGINS = [
    'https://cdn.jsdelivr.net'
];

/* Injects Cross-Origin Isolation headers required for SharedArrayBuffer & WebAssembly threads */
function addCoiHeaders(response) {
    if (!response || response.status === 0) {
        return response;
    }
    var headers = new Headers(response.headers);
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');

    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: headers
    });
}

self.addEventListener('install', function (event) {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then(function (cache) {
            console.log('[SW] Precaching ' + PRECACHE_ASSETS.length + ' assets (v' + CACHE_VERSION + ')');
            return cache.addAll(PRECACHE_ASSETS).catch(function (err) {
                console.warn('[SW] Precache non-critical warning:', err);
            });
        })
    );
});

self.addEventListener('activate', function (event) {
    event.waitUntil(
        caches.keys().then(function (names) {
            return Promise.all(
                names
                    .filter(function (name) { return name.startsWith('krkr2-v') && name !== CACHE_NAME; })
                    .map(function (name) {
                        console.log('[SW] Deleting old cache:', name);
                        return caches.delete(name);
                    })
            );
        }).then(function () {
            return self.clients.claim();
        })
    );
});

self.addEventListener('fetch', function (event) {
    var request = event.request;
    if (request.method !== 'GET') return;
    if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

    var url = new URL(request.url);
    var isSameOrigin = url.origin === self.location.origin;

    /* Navigation requests (HTML): network-first, fallback to cache, always COI-headers */
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request).then(function (response) {
                var clone = response.clone();
                caches.open(CACHE_NAME).then(function (cache) { cache.put(request, clone); });
                return addCoiHeaders(response);
            }).catch(function () {
                return caches.match(request).then(function (cached) {
                    if (cached) return addCoiHeaders(cached);
                    return caches.match('./index.html').then(function (fallback) {
                        return fallback ? addCoiHeaders(fallback) : fetch(request).then(addCoiHeaders);
                    });
                });
            })
        );
        return;
    }

    /* CDN resources to cache for offline */
    var isRuntimeCacheable = RUNTIME_CACHE_ORIGINS.some(function (origin) {
        return url.origin === origin;
    });

    if (isSameOrigin || isRuntimeCacheable) {
        event.respondWith(
            caches.match(request).then(function (cached) {
                if (cached) return addCoiHeaders(cached);
                return fetch(request).then(function (response) {
                    if (response.ok) {
                        var clone = response.clone();
                        caches.open(CACHE_NAME).then(function (cache) { cache.put(request, clone); });
                    }
                    return addCoiHeaders(response);
                }).catch(function () {
                    return fetch(request).then(addCoiHeaders);
                });
            })
        );
        return;
    }

    /* All other requests (e.g. cross-origin game URLs): add COI headers if possible */
    event.respondWith(
        fetch(request).then(function (response) {
            return addCoiHeaders(response);
        }).catch(function () {
            return fetch(request);
        })
    );
});

self.addEventListener('message', function (event) {
    if (event.data === 'skipWaiting') {
        self.skipWaiting();
    }
});

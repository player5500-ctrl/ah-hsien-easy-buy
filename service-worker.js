const CACHE_PREFIX = 'ah-hsien-easy-buy-';
const CACHE_NAME = `${CACHE_PREFIX}20260729-mobile-pwa`;
const CORE_ASSETS = [
    './',
    './index.html',
    './styles.css',
    './app.js',
    './pwa.js',
    './product-voice.js',
    './line-order.js',
    './customer-name.js',
    './customer-paste-parse.js',
    './line-note.js',
    './manifest.webmanifest',
    './icons/icon-192.svg',
    './icons/icon-512.svg'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(CORE_ASSETS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
                    .map(key => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

async function networkFirst(request) {
    const cache = await caches.open(CACHE_NAME);
    try {
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
    } catch (_error) {
        return (await cache.match(request, { ignoreSearch: true }))
            || (await cache.match('./index.html'));
    }
}

async function cachedAsset(request) {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
}

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin || url.pathname.includes('/api/')) return;

    if (request.mode === 'navigate') {
        event.respondWith(networkFirst(request));
        return;
    }

    event.respondWith(cachedAsset(request));
});

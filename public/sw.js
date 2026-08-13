const CACHE_NAME = 'shenzhen-metro-v2'
const CORE_ASSETS = [
  '/',
  '/manifest.webmanifest',
  '/icons/metro-icon.svg',
  '/icons/metro-icon-192.png',
  '/icons/metro-icon-512.png',
  '/icons/apple-touch-icon.png',
  '/data/metro-fare-stations.json',
  '/data/metro-fares-standard.json',
  '/data/metro-fares-business.json'
]

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME)
    await cache.addAll(CORE_ASSETS)
    const response = await fetch('/')
    const html = await response.clone().text()
    const appAssets = [...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(match => match[1])
    await cache.put('/', response)
    await cache.addAll(appAssets)
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(names.filter(name => name !== CACHE_NAME).map(name => caches.delete(name)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return

  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request)
      .then(response => {
        const copy = response.clone()
        caches.open(CACHE_NAME).then(cache => cache.put('/', copy))
        return response
      })
      .catch(() => caches.match('/')))
    return
  }

  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
    if (response.ok) {
      const copy = response.clone()
      caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy))
    }
    return response
  })))
})

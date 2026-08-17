const CACHE_PREFIX = 'shenzhen-metro-'
const FALLBACK_VERSION = 'bootstrap-v3'
const CORE_ASSETS = [
  '/manifest.webmanifest',
  '/icons/metro-icon.svg',
  '/icons/metro-icon-192.png',
  '/icons/metro-icon-512.png',
  '/icons/apple-touch-icon.png',
  '/data/metro-fare-stations.json',
  '/data/metro-fares-standard.json',
  '/data/metro-fares-business.json',
  '/data/metro-line-metrics.json'
]

const cacheNameFor = version => `${CACHE_PREFIX}${String(version).replace(/[^a-zA-Z0-9._-]/g, '-')}`

const fetchVersion = async () => {
  const response = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Version request failed: ${response.status}`)
  const payload = await response.json()
  return payload.version || FALLBACK_VERSION
}

const fetchFresh = path => fetch(path, { cache: 'reload' })

const buildAppCache = async version => {
  const cacheName = cacheNameFor(version)
  const cache = await caches.open(cacheName)
  const htmlResponse = await fetchFresh('/')
  if (!htmlResponse.ok) throw new Error(`App shell request failed: ${htmlResponse.status}`)

  const html = await htmlResponse.clone().text()
  const appAssets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(match => match[1])
  await cache.put('/', htmlResponse)
  await Promise.all([...new Set([...CORE_ASSETS, ...appAssets])].map(async path => {
    const response = await fetchFresh(path)
    if (!response.ok) throw new Error(`Asset request failed: ${path}`)
    await cache.put(path, response)
  }))
  return cacheName
}

const removeOldAppCaches = async currentCacheName => {
  const names = await caches.keys()
  await Promise.all(names
    .filter(name => name.startsWith(CACHE_PREFIX) && name !== currentCacheName)
    .map(name => caches.delete(name)))
}

const getWritableCache = async () => {
  const names = await caches.keys()
  const appCacheNames = names.filter(name => name.startsWith(CACHE_PREFIX))
  return caches.open(appCacheNames.at(-1) || cacheNameFor(FALLBACK_VERSION))
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const version = await fetchVersion().catch(() => FALLBACK_VERSION)
    const cacheName = await buildAppCache(version)
    await removeOldAppCaches(cacheName)
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('message', event => {
  if (event.data?.type !== 'UPDATE_APP_CACHE') return
  const reply = event.ports[0]
  event.waitUntil((async () => {
    try {
      const cacheName = await buildAppCache(event.data.version)
      await removeOldAppCaches(cacheName)
      reply?.postMessage({ ok: true })
    } catch (error) {
      reply?.postMessage({ ok: false, error: error.message })
    }
  })())
})

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return

  if (url.pathname === '/version.json') {
    event.respondWith(fetch(event.request, { cache: 'no-store' }))
    return
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(caches.match('/').then(cached => cached || fetchFresh('/')))
    return
  }

  event.respondWith(caches.match(event.request).then(async cached => {
    if (cached) return cached
    const response = await fetch(event.request)
    if (response.ok) {
      const cache = await getWritableCache()
      await cache.put(event.request, response.clone())
    }
    return response
  }))
})

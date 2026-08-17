const VERSION_URL = '/version.json'
const RELOAD_VERSION_KEY = 'shenzhen-metro-reload-version'

export const APP_VERSION = __APP_VERSION__
export const STARTUP_LOAD_MODE = globalThis.navigator?.serviceWorker?.controller ? 'LOCAL' : 'ONLINE'

const fetchCloudVersion = async () => {
  const response = await fetch(`${VERSION_URL}?t=${Date.now()}`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Version request failed: ${response.status}`)
  const payload = await response.json()
  return typeof payload.version === 'string' ? payload.version : null
}

const updateLocalCache = (registration, version) => new Promise((resolve, reject) => {
  const worker = navigator.serviceWorker.controller || registration.active || registration.waiting
  if (!worker) {
    reject(new Error('No active service worker'))
    return
  }

  const channel = new MessageChannel()
  const timeout = setTimeout(() => reject(new Error('Cache update timed out')), 30000)
  channel.port1.onmessage = event => {
    clearTimeout(timeout)
    if (event.data?.ok) resolve()
    else reject(new Error(event.data?.error || 'Cache update failed'))
  }
  worker.postMessage({ type: 'UPDATE_APP_CACHE', version }, [channel.port2])
})

const checkForUpdate = async registration => {
  try {
    const cloudVersion = await fetchCloudVersion()
    if (!cloudVersion || cloudVersion === __APP_VERSION__) {
      sessionStorage.removeItem(RELOAD_VERSION_KEY)
      return
    }
    if (sessionStorage.getItem(RELOAD_VERSION_KEY) === cloudVersion) return

    await registration.update().catch(() => {})
    await updateLocalCache(registration, cloudVersion)
    sessionStorage.setItem(RELOAD_VERSION_KEY, cloudVersion)
    globalThis.location.reload()
  } catch (error) {
    console.debug('[PWA] Background update check skipped:', error.message)
  }
}

const scheduleWhenIdle = callback => {
  const runWhenIdle = () => {
    if ('requestIdleCallback' in globalThis) {
      globalThis.requestIdleCallback(callback, { timeout: 5000 })
    } else {
      setTimeout(callback, 2500)
    }
  }
  globalThis.requestAnimationFrame(() => globalThis.requestAnimationFrame(runWhenIdle))
}

export const setupPwaUpdates = async () => {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return

  const registration = await navigator.serviceWorker.register('/sw.js')
  scheduleWhenIdle(async () => {
    await navigator.serviceWorker.ready
    await checkForUpdate(registration)
  })
}

const CACHE_NAME = 'shellnaut-v3'

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event

  // Never cache WebSocket or API calls
  if (request.url.includes('/ws') || request.url.includes('/ping')) return

  // Network-first: try fresh, fall back to cache for offline
  event.respondWith(
    fetch(request).then(response => {
      if (response.ok) {
        const clone = response.clone()
        caches.open(CACHE_NAME).then(cache => cache.put(request, clone))
      }
      return response
    }).catch(() => caches.match(request))
  )
})

/// <reference lib="webworker" />
declare let self: ServiceWorkerGlobalScope

// THE v2 SERVICE WORKER (plan Task 12; CX-6/7/8, DS-6).
//
// WHAT IT CACHES: the app shell only — the precache is the entry closure
// (index.html + entry/vendor JS + CSS + fonts + icons, vite.config
// globPatterns) and hashed lazy chunks are CacheFirst at runtime (immutable by
// name). NOTHING under the app's own data endpoints is ever cached here: Dexie
// owns that data and the offline pill derives from it — a SW cache serving a
// stale slice as a fresh 200 would silently defeat both (CX-6).
//
// HOW IT UPDATES: it does NOT skipWaiting or claim on install. An updated
// worker WAITS until every old tab is gone (next cold open) or until the
// reader taps the UpdateBanner, which posts SKIP_WAITING below and reloads.
// Old tabs therefore never have their asset generation deleted from under
// them mid-session (CX-8).

import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'
import { CacheFirst } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'

cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

// Offline navigation (audit M-3, kept): an installed PWA opens at /app/,
// which maps to no precached file — serve the precached SPA shell. Scoped to
// /app/ so the public marketing pages and the report are untouched.
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { allowlist: [/^\/app(\/|$)/] }))

// Hashed lazy chunks: immutable by filename, so CacheFirst is exactly right.
// Cloudflare's SPA fallback returns index.html with status 200 for an unknown
// asset path. Never cache that HTML as JavaScript: doing so poisons the exact
// chunk URL even after a later deployment restores it.
const assetResponseOnly = {
  cacheWillUpdate: async ({ request, response }: { request: Request; response: Response }) => {
    if (response.status !== 200) return null
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (request.destination === 'script' && !/(javascript|ecmascript)/.test(contentType)) return null
    if (request.destination === 'style' && !contentType.includes('text/css')) return null
    return response
  },
}

// Bounded — the precache carries the shell, this only accumulates visited
// screens' chunks. The v2 name deliberately leaves the poisoned v1 cache
// behind until activation, where it is removed below.
registerRoute(
  ({ url, request }) => url.pathname.startsWith('/assets/') && (request.destination === 'script' || request.destination === 'style'),
  new CacheFirst({
    cacheName: 'lazy-chunks-v2',
    plugins: [assetResponseOnly, new ExpirationPlugin({ maxEntries: 60, maxAgeSeconds: 30 * 86_400 })],
  }),
)

self.addEventListener('activate', event => {
  event.waitUntil(caches.delete('lazy-chunks'))
})

// The UpdateBanner's explicit consent — the ONLY skipWaiting in this worker.
self.addEventListener('message', event => {
  if ((event.data as { type?: string } | null)?.type === 'SKIP_WAITING') void self.skipWaiting()
})

self.addEventListener('push', event => {
  let data: { title?: string; body?: string; url?: string } = {}
  try {
    data = event.data?.json() ?? {}
  } catch {
    data = { body: event.data?.text() ?? '' }
  }
  event.waitUntil(
    self.registration.showNotification(data.title ?? 'StreetSignal', {
      body: data.body ?? '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url ?? '/app/' },
    }),
  )
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const url = (event.notification.data as { url?: string })?.url ?? '/app/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const open = clients.find(c => 'focus' in c)
      if (open) {
        open.navigate?.(url)
        return (open as WindowClient).focus()
      }
      return self.clients.openWindow(url)
    }),
  )
})

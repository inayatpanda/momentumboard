/// <reference lib="webworker" />
declare let self: ServiceWorkerGlobalScope

import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching'
import { registerRoute, NavigationRoute } from 'workbox-routing'
import { clientsClaim } from 'workbox-core'

cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

// Offline navigation (audit M-3): the installed PWA opens at its start_url
// /app/, which maps to no precached file, so an offline launch showed the
// browser's error page. Serve the precached SPA shell (index.html) for any
// /app/ navigation instead. Scoped to /app/ so the public marketing pages and
// the report are untouched.
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html'), { allowlist: [/^\/app(\/|$)/] }))

self.skipWaiting()
clientsClaim()

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

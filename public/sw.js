// Service worker for auction reveal reminders.
//
// Deliberately has no `fetch` handler: this is not an offline PWA, and
// intercepting requests would break the cookie-authenticated SSR pages.
// Its only job is receiving push messages and opening /auction on click.

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', event => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    // A malformed payload must not throw inside the handler.
    payload = {}
  }

  const title = payload.title || 'פנטזי דראפט'
  const options = {
    body: payload.body || '',
    // `icon` is the large, full-colour image in the notification body — the
    // logo as designed.
    icon: '/icons/icon-192.png',
    // `badge` is a different thing entirely: the small mark Android puts in the
    // status bar and overlays on the notification. Android reads ONLY its alpha
    // channel and paints the result white, so a fully opaque PNG — which every
    // icon derived from logo.png is — asks it to paint a solid white rectangle.
    // That was the blank white square. badge-96.png is the same logo as a
    // white-on-transparent silhouette; regenerate it with
    // scripts/generate-notification-badge.mjs after any logo change.
    badge: '/icons/badge-96.png',
    dir: 'rtl',
    lang: 'he',
    // A later push with the same tag REPLACES the earlier toast instead of
    // stacking: re-notifying after an admin moves reveal_time, and every raise
    // on an open auction, must not fill the tray with stale prices.
    // payload.auctionId is the older form, still sent by the envelope cron so
    // that a service worker installed before `tag` existed keeps grouping.
    tag: payload.tag || (payload.auctionId ? 'auction-' + payload.auctionId : 'auction'),
    renotify: true,
    data: { url: payload.url || '/auction' },
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', event => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/auction'

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client) {
          return client.focus().then(c => (c && 'navigate' in c ? c.navigate(url) : c))
        }
      }
      return self.clients.openWindow(url)
    })
  )
})

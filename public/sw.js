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
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    dir: 'rtl',
    lang: 'he',
    // Re-notifying after an admin moves reveal_time replaces the old toast
    // instead of stacking a second one for the same auction.
    tag: payload.auctionId ? 'auction-' + payload.auctionId : 'auction',
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

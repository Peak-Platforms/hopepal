const CACHE_NAME = 'hopepal-v2';
const OFFLINE_FILES = ['/sidney/reader.html', '/manifest.json'];

/* ── INSTALL: cache core files ── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(OFFLINE_FILES))
  );
  self.skipWaiting();
});

/* ── ACTIVATE: clean old caches ── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

/* ── FETCH: serve from cache if offline ── */
self.addEventListener('fetch', event => {
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

/* ── PUSH: show notification when new message arrives ── */
self.addEventListener('push', event => {
  const data    = event.data?.json() || {};
  const title   = data.title || 'HopePal — New Message';
  const body    = data.body  || 'A driver has sent you a message.';
  const options = {
    body,
    icon:     '/manifest.json',
    badge:    '/manifest.json',
    tag:      'hopepal-message',
    renotify: true,
    vibrate:  [200, 100, 200],
    data:     { url: '/sidney/reader.html' }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

/* ── NOTIFICATION CLICK: open reader ── */
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.includes('reader.html') && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow('/sidney/reader.html');
    })
  );
});

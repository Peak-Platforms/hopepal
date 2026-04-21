const CACHE_NAME = 'hopepal-v3';

// Only cache non-HTML static assets
const STATIC_FILES = ['/manifest.json'];

/* ── INSTALL ── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_FILES))
  );
  self.skipWaiting();
});

/* ── ACTIVATE: clear all old caches ── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

/* ── FETCH ── */
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // NEVER cache HTML files — always fetch fresh from network
  if (event.request.destination === 'document' ||
      url.pathname.endsWith('.html') ||
      url.pathname === '/' ||
      url.pathname.endsWith('/')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response('<h2>You are offline</h2><p>Please reconnect to use HopePal.</p>',
          { headers: { 'Content-Type': 'text/html' } })
      )
    );
    return;
  }

  // For everything else — network first, cache fallback
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});

/* ── PUSH NOTIFICATIONS ── */
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

/* ── NOTIFICATION CLICK ── */
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


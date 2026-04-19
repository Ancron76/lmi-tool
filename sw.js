// Self-destructing service worker.
// Any browser that still has an old service worker registered will download
// this file, activate it, delete every cache, unregister itself, and reload
// all open tabs onto fresh code. After that, lmitool.com has no service
// worker and every deploy is live instantly via the normal HTTP cache.

self.addEventListener('install', function(e) {
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys()
      .then(function(keys) {
        return Promise.all(keys.map(function(k) { return caches.delete(k); }));
      })
      .then(function() {
        return self.registration.unregister();
      })
      .then(function() {
        return self.clients.matchAll({ type: 'window' });
      })
      .then(function(clients) {
        clients.forEach(function(client) {
          try { client.navigate(client.url); } catch (err) {}
        });
      })
      .catch(function() {})
  );
});

// Pass everything straight through while we're still alive.
self.addEventListener('fetch', function(e) {
  // No-op: let the browser handle the request normally.
});

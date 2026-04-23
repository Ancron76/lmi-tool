// ======================================================================
// Loopenta — Push Service Worker  (push-sw.js)
// ----------------------------------------------------------------------
// Registered by src/hub/notifications.js when the user opts in to
// browser push notifications.  This is intentionally SEPARATE from
// /sw.js (which is a self-destructing cleanup worker kept around for
// users upgrading from an old cached build).
//
// Responsibilities:
//   1. Receive Web Push events from the Cloudflare notify worker
//   2. Display a native OS notification with the payload title/body
//   3. On click → focus an existing Loopenta tab and deep-link to the
//      referral ( /?hub=1&lead=<leadId> ), or open a new window.
//
// No caching, no offline, no fetch interception — deliberately minimal.
// ======================================================================

const SW_VERSION = '20260423c';

self.addEventListener('install', function (event) {
  // Activate immediately so push works without a page reload.
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

// ── Push ──────────────────────────────────────────────────────────────
self.addEventListener('push', function (event) {
  let data = {};
  try {
    if (event.data) {
      try { data = event.data.json(); }
      catch (e) { data = { title: 'Loopenta', body: event.data.text() }; }
    }
  } catch (e) {
    data = { title: 'Loopenta', body: 'You have a new update.' };
  }

  const title  = data.title  || 'Loopenta';
  const body   = data.body   || '';
  const leadId = data.leadId || '';
  const ev     = data.event  || '';

  const options = {
    body: body,
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    // Same lead → coalesce into a single notification, but still ping.
    tag: leadId ? ('lead:' + leadId) : undefined,
    renotify: !!leadId,
    data: {
      leadId: leadId,
      event:  ev,
      url:    leadId ? ('/?hub=1&lead=' + encodeURIComponent(leadId)) : '/?hub=1',
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// ── Click → focus tab and deep-link ───────────────────────────────────
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  const leadId = (event.notification.data && event.notification.data.leadId) || '';
  const target = (event.notification.data && event.notification.data.url) || '/?hub=1';

  event.waitUntil((async function () {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Prefer an already-open Loopenta tab.
    for (const client of list) {
      try {
        const u = new URL(client.url);
        if (u.origin === self.location.origin) {
          client.postMessage({ type: 'hub:openLead', leadId: leadId });
          await client.focus();
          return;
        }
      } catch (e) {}
    }
    if (self.clients.openWindow) {
      await self.clients.openWindow(target);
    }
  })());
});

self.addEventListener('notificationclose', function (event) {
  // Hook for analytics later if desired.
});

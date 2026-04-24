// ======================================================================
// Loopenta Hub — Notifications (2026-04-22)
// Three channels, one dispatcher:
//   1. In-app feed    (this file — Firestore `hubNotifications` collection)
//   2. Email          (Cloudflare Worker — invoked from dispatch())
//   3. Browser push   (Web Push + service worker — invoked from dispatch())
// Channels 2 & 3 are opt-in per user via `notificationPrefs/{uid}`.
// ======================================================================
(function (global) {
  'use strict';

  var Hub = global.Hub = global.Hub || {};
  var N = Hub.notifications = Hub.notifications || {};

  // ── Public API ───────────────────────────────────────────────────────
  // Called by referrals.js after any lifecycle mutation:
  //   event ∈ 'accepted' | 'declined' | 'stage_advanced' | 'stage_reverted'
  //           | 'note' | 'closed_won' | 'closed_lost'
  // The `evt` object is the timeline entry (already includes byName, byOrgName, etc.)
  N.dispatch = async function (lead, event, evt) {
    if (!global.db || !lead) return;
    var targets = recipientsFor(lead, event, evt);
    if (!targets.length) return;

    // In-app — always on.
    await Promise.all(targets.map(function (uid) {
      return createInAppNotif(lead, event, evt, uid);
    }));

    // Email + push — check per-user prefs first (best effort; never throw).
    await Promise.all(targets.map(function (uid) {
      return dispatchExternal(lead, event, evt, uid).catch(function (e) {
        console.warn('[Hub.notifications] external dispatch failed for', uid, e);
      });
    }));
  };

  // Listen for unread notifications for the current user. Returns an
  // unsubscribe function. Calls onChange(unreadList) whenever the set changes.
  N.subscribe = function (onChange) {
    var db = global.db; var u = global.currentUser;
    if (!db || !u) return function () {};
    return db.collection('hubNotifications')
      .where('targetUid', '==', u.id)
      .where('read', '==', false)
      .onSnapshot(function (snap) {
        var list = snap.docs.map(function (d) {
          return Object.assign({ id: d.id }, d.data());
        });
        list.sort(function (a, b) { return (b.at || '').localeCompare(a.at || ''); });
        try { onChange(list); } catch (e) {}
      }, function (err) {
        console.warn('[Hub.notifications] subscribe error', err);
      });
  };

  N.markRead = async function (notifId) {
    if (!global.db) return;
    try {
      await global.db.collection('hubNotifications').doc(notifId).update({
        read: true,
        readAt: new Date().toISOString(),
      });
    } catch (e) { console.warn('[Hub.notifications] markRead failed', e); }
  };

  N.markAllRead = async function () {
    var db = global.db; var u = global.currentUser;
    if (!db || !u) return;
    try {
      var snap = await db.collection('hubNotifications')
        .where('targetUid', '==', u.id)
        .where('read', '==', false).get();
      var batch = db.batch();
      var now = new Date().toISOString();
      snap.docs.forEach(function (d) {
        batch.update(d.ref, { read: true, readAt: now });
      });
      await batch.commit();
    } catch (e) { console.warn('[Hub.notifications] markAllRead failed', e); }
  };

  // ── Preferences ──────────────────────────────────────────────────────
  N.getPrefs = async function (uid) {
    var db = global.db; if (!db || !uid) return defaultPrefs();
    try {
      var doc = await db.collection('notificationPrefs').doc(uid).get();
      if (!doc.exists) return defaultPrefs();
      return Object.assign(defaultPrefs(), doc.data());
    } catch (e) { return defaultPrefs(); }
  };
  N.setPrefs = async function (patch) {
    var db = global.db; var u = global.currentUser;
    if (!db || !u) return;
    await db.collection('notificationPrefs').doc(u.id).set(
      Object.assign({ updatedAt: new Date().toISOString() }, patch),
      { merge: true }
    );
  };
  function defaultPrefs() {
    return { email: true, push: false, inApp: true };
  }

  // ── Browser Push (Web Push + VAPID) ──────────────────────────────────
  // Registers push-sw.js, subscribes via PushManager, stores the
  // subscription in Firestore `pushSubscriptions/{subId}` keyed by uid.
  // Returns { ok, reason? } — reason is one of:
  //   'unsupported' | 'permission-denied' | 'no-vapid' | 'error'
  N.pushSupported = function () {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  };

  N.pushPermission = function () {
    return (typeof Notification !== 'undefined') ? Notification.permission : 'default';
  };

  N.enablePush = async function () {
    if (!N.pushSupported()) return { ok: false, reason: 'unsupported' };
    var vapidPublic = global.VAPID_PUBLIC_KEY;
    if (!vapidPublic) return { ok: false, reason: 'no-vapid' };

    // Ask permission first — browsers require a user gesture, which the
    // caller is expected to provide (this function runs from a click).
    var perm = await Notification.requestPermission();
    if (perm !== 'granted') return { ok: false, reason: 'permission-denied' };

    try {
      // Register the dedicated push service worker. Scope defaults to '/'.
      // NOTE: this replaces the self-destructing /sw.js registration at
      // the root scope, which is intentional: once a user opts in, they
      // want the push handler live at '/'.
      var reg = await navigator.serviceWorker.register('/push-sw.js?v=20260423b');
      await navigator.serviceWorker.ready;

      // Reuse existing subscription if one is already attached.
      var sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidPublic),
        });
      }

      // Persist to Firestore. Key by endpoint hash so the same device
      // doesn't create duplicates across enable/disable cycles.
      var u = global.currentUser;
      if (!u) return { ok: false, reason: 'no-user' };
      var subJson = sub.toJSON();
      var subId = await endpointHash(subJson.endpoint);
      await global.db.collection('pushSubscriptions').doc(subId).set({
        uid:        u.id,
        endpoint:   subJson.endpoint,
        keys:       subJson.keys || {},
        userAgent:  (navigator.userAgent || '').slice(0, 300),
        createdAt:  new Date().toISOString(),
      }, { merge: true });

      // Flip the pref so dispatchExternal will start sending push.
      await N.setPrefs({ push: true });
      return { ok: true, subId: subId };
    } catch (e) {
      console.warn('[Hub.notifications] enablePush failed', e);
      return { ok: false, reason: 'error', error: String(e && e.message || e) };
    }
  };

  N.disablePush = async function () {
    // 1. Flip the pref immediately so nothing further dispatches.
    try { await N.setPrefs({ push: false }); } catch (e) {}

    // 2. Unsubscribe + remove Firestore records for this device.
    try {
      if (!N.pushSupported()) return { ok: true };
      var reg = await navigator.serviceWorker.getRegistration('/');
      if (reg) {
        var sub = await reg.pushManager.getSubscription();
        if (sub) {
          var endpoint = sub.endpoint;
          try { await sub.unsubscribe(); } catch (e) {}
          try {
            var subId = await endpointHash(endpoint);
            await global.db.collection('pushSubscriptions').doc(subId).delete();
          } catch (e) {}
        }
      }
    } catch (e) {
      console.warn('[Hub.notifications] disablePush cleanup failed', e);
    }
    return { ok: true };
  };

  // Convert VAPID base64url public key → Uint8Array (Push API requirement).
  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - base64String.length % 4) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(base64);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; ++i) out[i] = raw.charCodeAt(i);
    return out;
  }

  // SHA-256 of the endpoint, as hex — stable id for a subscription.
  async function endpointHash(endpoint) {
    try {
      var buf = new TextEncoder().encode(endpoint || '');
      var digest = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(digest))
        .map(function (b) { return b.toString(16).padStart(2, '0'); })
        .join('').slice(0, 40);
    } catch (e) {
      // Fallback: strip scheme + base64-ish
      return btoa(endpoint || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
    }
  }

  // ── Preferences modal ────────────────────────────────────────────────
  // Opened from the bell menu's gear icon. Shows three toggles:
  //   - In-app feed (locked on)
  //   - Email
  //   - Browser push  (triggers enablePush() when flipped on)
  N.openPrefsModal = async function () {
    var u = global.currentUser; if (!u) return;
    var prefs = await N.getPrefs(u.id);
    var supported = N.pushSupported();
    var perm = N.pushPermission();

    // Build modal DOM.
    var backdrop = document.createElement('div');
    backdrop.className = 'hub-modal-backdrop';
    backdrop.id = 'hub-prefs-backdrop';
    backdrop.innerHTML = ''
      + '<div class="hub-modal" role="dialog" aria-label="Notification preferences" style="max-width:460px">'
      +   '<div class="hub-modal-head">'
      +     '<h3 style="margin:0;font-size:16px">Notification preferences</h3>'
      +     '<button class="hub-btn hub-btn-ghost" aria-label="Close" id="hub-prefs-close">&times;</button>'
      +   '</div>'
      +   '<div class="hub-modal-body" style="display:flex;flex-direction:column;gap:14px">'
      +     row('inApp',  'In-app notifications', 'Bell icon + feed. Always on.', true, true)
      +     row('email',  'Email', 'Sent to ' + esc(u.email || 'your account email') + '.', !!prefs.email, false)
      +     row('push',   'Browser push', supported
              ? (perm === 'denied'
                  ? 'Blocked by this browser. Re-enable in site settings.'
                  : 'Pings this device when something changes on a referral.')
              : 'This browser does not support web push.',
              !!prefs.push, !supported || perm === 'denied')
      +     '<div id="hub-prefs-status" style="min-height:18px;font-size:12px;color:var(--hub-muted)"></div>'
      +   '</div>'
      +   '<div class="hub-modal-foot">'
      +     '<button class="hub-btn" id="hub-prefs-done">Done</button>'
      +   '</div>'
      + '</div>';
    document.body.appendChild(backdrop);

    function row(key, title, hint, checked, disabled) {
      return ''
        + '<label class="hub-pref-row" style="display:flex;align-items:flex-start;gap:12px;padding:10px;border:1px solid var(--hub-line);border-radius:8px;background:#fffdf8' + (disabled ? ';opacity:.6' : '') + '">'
        +   '<input type="checkbox" data-key="' + key + '"' + (checked ? ' checked' : '') + (disabled ? ' disabled' : '') + ' style="margin-top:3px">'
        +   '<div style="flex:1">'
        +     '<div style="font-weight:600;color:var(--hub-ink);font-size:13px">' + esc(title) + '</div>'
        +     '<div style="font-size:12px;color:var(--hub-muted);margin-top:2px">' + esc(hint) + '</div>'
        +   '</div>'
        + '</label>';
    }

    function close() {
      try { backdrop.remove(); } catch (e) {}
    }
    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop) close();
    });
    document.getElementById('hub-prefs-close').addEventListener('click', close);
    document.getElementById('hub-prefs-done').addEventListener('click', close);

    var status = document.getElementById('hub-prefs-status');

    backdrop.querySelectorAll('input[type=checkbox][data-key]').forEach(function (cb) {
      if (cb.disabled) return;
      cb.addEventListener('change', async function () {
        var key = cb.dataset.key;
        var next = cb.checked;
        status.textContent = 'Saving…';
        try {
          if (key === 'push') {
            if (next) {
              var res = await N.enablePush();
              if (!res.ok) {
                cb.checked = false;
                status.textContent = pushErrorMessage(res.reason);
                return;
              }
              status.textContent = 'Browser push enabled on this device.';
            } else {
              await N.disablePush();
              status.textContent = 'Browser push disabled.';
            }
          } else if (key === 'email') {
            await N.setPrefs({ email: next });
            status.textContent = next ? 'Email notifications on.' : 'Email notifications off.';
          }
        } catch (e) {
          cb.checked = !next;
          status.textContent = 'Could not save — try again.';
        }
      });
    });
  };

  function pushErrorMessage(reason) {
    switch (reason) {
      case 'unsupported':        return 'This browser does not support web push.';
      case 'permission-denied':  return 'Permission denied. Enable notifications for this site in your browser settings.';
      case 'no-vapid':           return 'Push is not configured on the server yet (missing VAPID key).';
      case 'no-user':            return 'Sign in first.';
      default:                   return 'Could not enable push — try again.';
    }
  }

  // ── Internals ────────────────────────────────────────────────────────
  // Who should hear about this event? Usually "the other side" — but for
  // note events on an active referral, both sides hear (excluding the author).
  function recipientsFor(lead, event, evt) {
    var actor = evt && evt.by;
    var out = [];
    // Sender-side: the user who originally sent the referral.
    if (lead.fromUserId && lead.fromUserId !== actor) out.push(lead.fromUserId);
    // Receiver-side: the assigned user if one exists, otherwise nobody
    // user-scoped — the org sees it via in-app feed fallback (future).
    if (lead.toUserId && lead.toUserId !== actor && out.indexOf(lead.toUserId) === -1) {
      out.push(lead.toUserId);
    }
    return out;
  }

  function titleFor(lead, event, evt) {
    var who = lead.borrowerName || lead.clientName || lead.propertyAddress || 'referral';
    var actor = evt.byName || 'Someone';
    switch (event) {
      case 'sent':           return actor + ' sent you a new referral — ' + who;
      case 'accepted':       return actor + ' accepted your referral — ' + who;
      case 'declined':       return actor + ' declined your referral — ' + who;
      case 'stage_advanced': return who + ' → ' + (Hub.lifecycle ? Hub.lifecycle.stageLabel(evt.toStage) : evt.toStage);
      case 'stage_reverted': return who + ' moved back to ' + (Hub.lifecycle ? Hub.lifecycle.stageLabel(evt.toStage) : evt.toStage);
      case 'note':           return actor + ' left a note on ' + who;
      case 'closed_won':     return who + ' — closed won 🎉';
      case 'closed_lost':    return who + ' — closed lost';
      default:               return who + ' updated';
    }
  }

  async function createInAppNotif(lead, event, evt, targetUid) {
    var db = global.db; var u = global.currentUser;
    if (!db || !u) return;
    var body = (evt && evt.note) ? evt.note : '';
    try {
      await db.collection('hubNotifications').add({
        targetUid:  targetUid,
        leadId:     lead.id,
        event:      event,
        title:      titleFor(lead, event, evt),
        body:       body,
        actorName:  evt.byName || '',
        actorOrg:   evt.byOrgName || '',
        createdBy:  u.id,
        at:         evt.at || new Date().toISOString(),
        read:       false,
      });
    } catch (e) { console.warn('[Hub.notifications] create in-app failed', e); }
  }

  // Email + push dispatch is forwarded to the Cloudflare Worker. The worker
  // is the source of truth for deliverability + templates. This call is
  // best-effort — failures are logged but never block the UI.
  async function dispatchExternal(lead, event, evt, targetUid) {
    var endpoint = (global.COWORK_WORKER_BASE || '') + '/notify';
    if (!endpoint || endpoint[0] === '/') return; // worker base not configured yet
    var prefs = await N.getPrefs(targetUid);
    if (!prefs.email && !prefs.push) return;
    var u = global.currentUser;
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targetUid: targetUid,
        leadId:    lead.id,
        event:     event,
        actor:     evt.byName,
        actorOrg:  evt.byOrgName,
        title:     titleFor(lead, event, evt),
        body:      evt.note || '',
        at:        evt.at,
        channels:  { email: !!prefs.email, push: !!prefs.push },
        callerUid: u && u.id,
      }),
    });
  }

  // ── In-app bell UI (masthead integration) ────────────────────────────
  // Renders a bell icon in the hub masthead with an unread count badge.
  // Clicking opens a dropdown feed. Uses N.subscribe() for live updates.
  N.mountBell = function () {
    var host = document.getElementById('hub-masthead-actions');
    if (!host || host.querySelector('#hub-bell')) return;
    var wrap = document.createElement('div');
    wrap.id = 'hub-bell-wrap';
    wrap.style.cssText = 'position:relative;display:inline-block';
    wrap.innerHTML = ''
      + '<button id="hub-bell" class="hub-btn hub-btn-ghost" aria-label="Notifications"'
      +   ' style="padding:6px 10px;font-size:14px;position:relative">'
      +   '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
      +     '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/>'
      +     '<path d="M10 21a2 2 0 0 0 4 0"/>'
      +   '</svg>'
      +   '<span id="hub-bell-count" class="hub-bell-count" style="display:none"></span>'
      + '</button>'
      + '<div id="hub-bell-menu" class="hub-bell-menu" role="menu" style="display:none"></div>';
    host.appendChild(wrap);

    document.getElementById('hub-bell').addEventListener('click', function (e) {
      e.stopPropagation();
      toggleBellMenu();
    });
    document.addEventListener('click', function () {
      var m = document.getElementById('hub-bell-menu');
      if (m) m.style.display = 'none';
    });

    // Subscribe to unread stream.
    if (N._unsub) { try { N._unsub(); } catch (e) {} }
    N._unsub = N.subscribe(function (list) {
      N._latest = list;
      paintBell(list);
    });
  };

  function paintBell(list) {
    var count = document.getElementById('hub-bell-count');
    if (!count) return;
    var n = list.length;
    if (n > 0) {
      count.textContent = n > 99 ? '99+' : String(n);
      count.style.display = 'inline-flex';
    } else {
      count.style.display = 'none';
    }
    // Also nudge the Referrals tab count.
    paintReferralsTabBadge(list);
    // Re-render menu if open.
    var menu = document.getElementById('hub-bell-menu');
    if (menu && menu.style.display === 'block') renderBellMenu();
  }

  function paintReferralsTabBadge(list) {
    var tab = document.querySelector('.hub-tab[data-route="referrals"]');
    if (!tab) return;
    var badge = tab.querySelector('.hub-tab-badge');
    var referralRelevant = list.filter(function (n) {
      return n.event !== 'note' || true; // all events count for now
    }).length;
    if (referralRelevant > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'hub-tab-badge';
        tab.appendChild(badge);
      }
      badge.textContent = referralRelevant > 99 ? '99+' : String(referralRelevant);
    } else if (badge) {
      badge.remove();
    }
  }

  function toggleBellMenu() {
    var m = document.getElementById('hub-bell-menu');
    if (!m) return;
    if (m.style.display === 'block') { m.style.display = 'none'; return; }
    renderBellMenu();
    m.style.display = 'block';
  }

  function renderBellMenu() {
    var m = document.getElementById('hub-bell-menu');
    if (!m) return;
    var list = N._latest || [];
    if (!list.length) {
      m.innerHTML = '<div class="hub-bell-empty">No unread notifications.</div>';
      return;
    }
    m.innerHTML = ''
      + '<div class="hub-bell-head">'
      +   '<strong>Notifications</strong>'
      +   '<span style="display:inline-flex;gap:6px">'
      +     '<button class="hub-bell-mark-all" onclick="Hub.notifications.openPrefsModal()" title="Notification preferences" aria-label="Preferences">'
      +       '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>'
      +     '</button>'
      +     '<button class="hub-bell-mark-all" onclick="Hub.notifications.markAllRead()">Mark all read</button>'
      +   '</span>'
      + '</div>'
      + '<ol class="hub-bell-list">'
      +   list.slice(0, 25).map(function (n) {
            return ''
              + '<li class="hub-bell-item" data-lead="' + esc(n.leadId) + '" data-id="' + esc(n.id) + '">'
              +   '<div class="hub-bell-item-title">' + esc(n.title || 'Update') + '</div>'
              +   (n.body ? '<div class="hub-bell-item-body">' + esc(n.body) + '</div>' : '')
              +   '<div class="hub-bell-item-meta">' + esc(n.actorName || '') + (n.actorOrg ? ' · ' + esc(n.actorOrg) : '') + ' · ' + esc(fmtWhen(n.at)) + '</div>'
              + '</li>';
          }).join('')
      + '</ol>';
    m.querySelectorAll('.hub-bell-item').forEach(function (el) {
      el.addEventListener('click', function () {
        var leadId = el.dataset.lead;
        var notifId = el.dataset.id;
        N.markRead(notifId);
        m.style.display = 'none';
        if (Hub._openLead && leadId) Hub._openLead(leadId);
      });
    });
  }

  function esc(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtWhen(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.round(diff / 60) + 'm';
    if (diff < 86400) return Math.round(diff / 3600) + 'h';
    if (diff < 86400 * 7) return Math.round(diff / 86400) + 'd';
    return d.toLocaleDateString();
  }

  // Auto-mount on hub ready. The masthead is rendered synchronously so we
  // can mount as soon as currentUser is available. We poll briefly because
  // currentUser may arrive after this file loads; once the bell exists,
  // we clear the timer so nothing ticks in the background.
  var _mountTimer = setInterval(function () {
    if (!global.currentUser) return;
    var host = document.getElementById('hub-masthead-actions');
    if (!host) return;
    N.mountBell();
    if (document.getElementById('hub-bell')) {
      clearInterval(_mountTimer);
      _mountTimer = null;
    }
  }, 1500);
  function tryMountOnce() {
    if (!global.currentUser) return;
    if (!document.getElementById('hub-masthead-actions')) return;
    N.mountBell();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryMountOnce, { once: true });
  } else {
    setTimeout(tryMountOnce, 0);
  }

  // ── Service worker → page bridge ─────────────────────────────────────
  // When the user clicks a push notification, push-sw.js posts a message
  // to every Loopenta tab. Honor it by opening the referenced lead.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (e) {
      var msg = e && e.data; if (!msg) return;
      if (msg.type === 'hub:openLead' && msg.leadId && Hub._openLead) {
        try { Hub._openLead(msg.leadId); } catch (err) {}
      }
    });
  }

  // ── Direct URL deep-link: /?hub=1&lead=<id> ──────────────────────────
  // When a user opens a push notification in a fresh tab, the URL
  // contains the target lead id. Open it once the hub has mounted.
  (function () {
    try {
      var params = new URLSearchParams(global.location.search);
      var leadId = params.get('lead');
      if (!leadId) return;
      var tries = 0;
      var iv = setInterval(function () {
        tries++;
        if (Hub._openLead && global.currentUser) {
          clearInterval(iv);
          try { Hub._openLead(leadId); } catch (e) {}
          // Clean the URL so a refresh doesn't re-open the modal.
          try {
            params.delete('lead');
            var q = params.toString();
            var url = global.location.pathname + (q ? '?' + q : '') + global.location.hash;
            history.replaceState(null, '', url);
          } catch (e) {}
        } else if (tries > 40) {
          clearInterval(iv);
        }
      }, 250);
    } catch (e) {}
  })();

  console.info('[Hub.notifications] loaded');

})(typeof window !== 'undefined' ? window : globalThis);

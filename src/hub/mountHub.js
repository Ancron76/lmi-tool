// ======================================================================
// Loopenta Hub — mount / shell (2026-04-22)
// Professional tool chrome: masthead (not marketing hero), flat tabbar,
// text-only nav (no emojis), restrained gold accents, tabular figures.
// ======================================================================
(function (global) {
  'use strict';

  var Hub = global.Hub = global.Hub || {};
  Hub.VERSION = '20260422f';

  var mounted = false;

  Hub.mount = function () {
    if (mounted) return;
    try {
      if (!global.document || !global.document.body) return;
      injectStylesheet();
      injectShell();
      bindNavTrigger();
      document.body.classList.add('hub-enabled');
      mounted = true;
      console.info('[Hub] mounted');
    } catch (e) {
      console.warn('[Hub] mount error', e);
    }
  };

  function injectStylesheet() {
    if (document.getElementById('hub-css-link')) return;
    var link = document.createElement('link');
    link.id = 'hub-css-link';
    link.rel = 'stylesheet';
    link.href = '/src/hub/hub.css?v=' + (Hub.VERSION || '1');
    document.head.appendChild(link);
  }

  function injectShell() {
    if (document.getElementById('hub-root')) return;
    // Place Hub inside #app-screen (next to legacy tab-*-content divs) so
    // it flows in the same layout as every other page. Fall back to body.
    var host = document.getElementById('app-screen') || document.body;
    var shell = document.createElement('div');
    shell.id = 'hub-root';
    shell.className = 'hub-scope hub-screen';
    shell.innerHTML = ''
      + '<header class="hub-masthead">'
      +   '<div>'
      +     '<div class="hub-masthead-eyebrow" id="hub-hero-sub">Loopenta Hub</div>'
      +     '<h1 class="hub-masthead-title" id="hub-hero-title">Hub</h1>'
      +   '</div>'
      +   '<div class="hub-masthead-actions" id="hub-masthead-actions"></div>'
      + '</header>'
      + '<nav class="hub-tabbar" id="hub-tabbar" aria-label="Hub sections"></nav>'
      + '<main id="hub-body"></main>';
    host.appendChild(shell);

    Hub._routes = Hub._routes || {};
  }

  // Route registration from sub-modules.
  Hub.registerRoute = function (key, opts) {
    Hub._routes = Hub._routes || {};
    Hub._routes[key] = opts;
    renderTabbar();
  };

  function renderTabbar() {
    var bar = document.getElementById('hub-tabbar');
    if (!bar) return;
    var routes = Hub._routes || {};
    var caps = Hub.capabilities(global.currentUser || null);
    var html = '';
    Object.keys(routes).forEach(function (key) {
      var r = routes[key];
      if (r.visible && !r.visible(caps)) return;
      // Text-only tab — no emoji/icon clutter.
      html += '<button class="hub-tab" data-route="' + key + '">'
            + escHtml(r.label) + '</button>';
    });
    bar.innerHTML = html;
    bar.querySelectorAll('.hub-tab').forEach(function (btn) {
      btn.addEventListener('click', function () { Hub.go(btn.dataset.route); });
    });
  }

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Internal: make the hub visible and hide all legacy tab content.
  function ensureVisible() {
    var root = document.getElementById('hub-root');
    if (!root) return false;
    document.querySelectorAll('[id^="tab-"][id$="-content"]').forEach(function (el) {
      if (el.id === 'hub-root') return;
      if (el.dataset.hubPrev == null) {
        el.dataset.hubPrev = el.style.display || '';
      }
      el.style.display = 'none';
    });
    document.body.classList.add('hub-active');
    root.classList.add('active');
    personalizeHero();
    return true;
  }

  function restoreLegacy() {
    document.querySelectorAll('[data-hub-prev]').forEach(function (el) {
      el.style.display = el.dataset.hubPrev || '';
      delete el.dataset.hubPrev;
    });
    document.body.classList.remove('hub-active');
  }

  function setMastheadTitle(text) {
    var t = document.getElementById('hub-hero-title');
    if (t) t.textContent = text;
  }

  Hub.go = function (route) {
    if (!ensureVisible()) return;
    var body = document.getElementById('hub-body');
    var tabs = document.querySelectorAll('.hub-tab');
    tabs.forEach(function (t) { t.classList.toggle('active', t.dataset.route === route); });
    if (!body) return;
    if (!global.currentUser) { renderSignedOutCta(body); return; }
    var routes = Hub._routes || {};
    var r = routes[route];
    if (!r) {
      setMastheadTitle('Hub');
      body.innerHTML = '<div class="hub-empty"><h4>Select a section</h4><p>Use the tabs above to open team activity, referrals, or your partner network.</p></div>';
      return;
    }
    setMastheadTitle(r.label || 'Hub');
    body.innerHTML = '<div class="hub-empty"><p>Loading</p></div>';
    try {
      Promise.resolve(r.render(body)).catch(function (err) {
        body.innerHTML = '<div class="hub-empty"><h4>Something went wrong</h4><p>'
          + escHtml(err && err.message ? err.message : 'Unknown error')
          + '</p></div>';
      });
    } catch (err) {
      body.innerHTML = '<div class="hub-empty"><h4>Something went wrong</h4><p>'
        + escHtml(err && err.message ? err.message : String(err))
        + '</p></div>';
    }
  };

  // Wrap the existing showTab() so activating any legacy tab hides the
  // Hub screen, and a sentinel 'hub' tab shows it.
  function bindNavTrigger() {
    var origShowTab = global.showTab;
    global.showTab = function (tab) {
      if (tab === 'hub') { Hub.show(); return; }
      Hub.hide();
      if (typeof origShowTab === 'function') return origShowTab.apply(this, arguments);
    };
  }

  Hub.show = function () {
    if (!ensureVisible()) return;
    if (!global.currentUser) {
      var body = document.getElementById('hub-body');
      if (body) renderSignedOutCta(body);
      return;
    }
    var active = document.querySelector('.hub-tab.active');
    if (active) return;
    var keys = Object.keys(Hub._routes || {});
    if (keys.length) Hub.go(defaultRouteForUser(keys));
  };

  Hub.hide = function () {
    var root = document.getElementById('hub-root');
    if (!root) return;
    root.classList.remove('active');
    restoreLegacy();
  };

  function renderSignedOutCta(body) {
    setMastheadTitle('Sign in required');
    body.innerHTML = ''
      + '<div class="hub-signin-card">'
      +   '<h3>Sign in to access the Hub</h3>'
      +   '<p>Manage your team, route referrals between lenders and realtors, and coordinate with title &amp; escrow partners — all in one workspace.</p>'
      +   '<div class="hub-signin-actions">'
      +     '<button class="hub-btn hub-btn-primary" id="hub-signin-btn">Sign in</button>'
      +     '<button class="hub-btn hub-btn-ghost" id="hub-signup-btn">Create an account</button>'
      +   '</div>'
      + '</div>';
    var signin = document.getElementById('hub-signin-btn');
    var signup = document.getElementById('hub-signup-btn');
    if (signin) signin.addEventListener('click', function () {
      Hub.hide();
      var ls = document.getElementById('login-screen');
      if (ls) ls.style.display = 'flex';
    });
    if (signup) signup.addEventListener('click', function () {
      Hub.hide();
      if (typeof global.showSignupScreen === 'function') global.showSignupScreen();
      else if (typeof global.showSignup === 'function') global.showSignup();
      else {
        var ls = document.getElementById('login-screen');
        if (ls) ls.style.display = 'flex';
      }
    });
  }

  function defaultRouteForUser(keys) {
    var u = global.currentUser;
    if (!u) return keys[0];
    if (u.role === 'superadmin' || u.role === 'admin') return keys.indexOf('reporting') > -1 ? 'reporting' : keys[0];
    if (u.role === 'manager') return 'reporting';
    return keys.indexOf('referrals') > -1 ? 'referrals' : keys[0];
  }

  // Update the masthead eyebrow with a contextual greeting.
  // The title is set per-route by Hub.go, so this only touches the eyebrow.
  function personalizeHero() {
    var u = global.currentUser;
    var subEl = document.getElementById('hub-hero-sub');
    if (!subEl) return;
    if (!u) {
      subEl.textContent = 'Loopenta Hub';
      return;
    }
    var first = (u.name || u.email || '').split(' ')[0] || '';
    var hr = new Date().getHours();
    var timeOfDay = hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening';
    subEl.textContent = first ? (timeOfDay + ', ' + first) : 'Loopenta Hub';
  }

  Hub.refreshNav = function () {
    renderTabbar();
    personalizeHero();
    var root = document.getElementById('hub-root');
    if (root && root.classList.contains('active') && global.currentUser) {
      var body = document.getElementById('hub-body');
      var hasCta = body && body.querySelector && body.querySelector('#hub-signin-btn');
      var active = document.querySelector('.hub-tab.active');
      if (hasCta || !active) {
        var keys = Object.keys(Hub._routes || {});
        if (keys.length) Hub.go(defaultRouteForUser(keys));
      }
    }
  };

  function tryAutoMount() {
    if (mounted) return;
    if (!global.document || !global.document.body) return;
    Hub.mount();
    Hub.refreshNav();
  }
  Hub._tryAutoMount = tryAutoMount;

  if (global.document) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', tryAutoMount, { once: true });
    } else {
      setTimeout(tryAutoMount, 0);
    }
  }

  var _navRefreshStart = Date.now();
  var _navRefreshTimer = setInterval(function () {
    if (!mounted) return;
    try { Hub.refreshNav(); } catch (e) {}
    if (Date.now() - _navRefreshStart > 60000) clearInterval(_navRefreshTimer);
  }, 1500);

})(typeof window !== 'undefined' ? window : globalThis);

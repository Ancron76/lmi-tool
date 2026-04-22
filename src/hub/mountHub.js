// ======================================================================
// Loopenta Hub — mount / shell (2026-04-22)
// Injects a new "Hub" section into index.html that contains:
//   • Manager team reporting
//   • Referrals inbox + sender
//   • Realtor listings + buyer pipeline
//   • Title/Escrow portals (scaffold)
//   • Referral Partner directory
// Non-invasive: if the user is not signed in, nothing mounts.
// ======================================================================
(function (global) {
  'use strict';

  var Hub = global.Hub = global.Hub || {};

  // Wait for the shell (and currentUser) to be ready. We piggy-back on
  // the existing showTab()/tabs structure in index.html.
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
    var host = document.body;
    var shell = document.createElement('div');
    shell.id = 'hub-root';
    shell.className = 'hub-scope hub-screen';
    shell.innerHTML = ''
      + '<div class="hub-hero">'
      +   '<div class="hub-hero-eyebrow">Loopenta Hub</div>'
      +   '<h1 id="hub-hero-title">The industry hub for finding property, loan, and home.</h1>'
      +   '<p id="hub-hero-sub">One place to work leads between Home Loan Advisors, Realtors, Referral Partners, Title, and Escrow. Manage your team. Hand off the right client to the right partner. Close more.</p>'
      +   '<div class="hub-hero-cta" id="hub-hero-cta">'
      +     '<button class="hub-btn hub-btn-primary" onclick="Hub.go(\'reporting\')">View team activity</button>'
      +     '<button class="hub-btn hub-btn-ghost" onclick="Hub.go(\'referrals\')">Referrals inbox</button>'
      +     '<button class="hub-btn hub-btn-ghost" onclick="Hub.go(\'network\')">Partner network</button>'
      +   '</div>'
      + '</div>'
      + '<div class="hub-tabbar" id="hub-tabbar"></div>'
      + '<div id="hub-body"></div>';
    host.appendChild(shell);

    // Simple lazy renderers, installed by sub-modules.
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
      html += '<button class="hub-tab" data-route="' + key + '">'
            + '<span>' + (r.icon || '') + '</span>'
            + '<span>' + r.label + '</span></button>';
    });
    bar.innerHTML = html;
    bar.querySelectorAll('.hub-tab').forEach(function (btn) {
      btn.addEventListener('click', function () { Hub.go(btn.dataset.route); });
    });
  }

  // Internal: make the hub visible and hide all legacy UI. Idempotent.
  // IMPORTANT: this does NOT call Hub.go — avoids recursion with Hub.show.
  function ensureVisible() {
    var root = document.getElementById('hub-root');
    if (!root) return false;
    // Hide legacy tab content AND any legacy page wrappers. The app uses
    // a few different container patterns; cover the common ones.
    var legacySelectors = [
      '.tab-content',
      '.page-content',
      '.main-content',
      '#main-content',
      '#app-main',
      '#app-body',
      '.app-main',
      '.content-area'
    ];
    legacySelectors.forEach(function (sel) {
      document.querySelectorAll(sel).forEach(function (el) {
        if (el.id === 'hub-root') return;
        if (el.dataset._hubPrevDisplay == null) {
          el.dataset._hubPrevDisplay = el.style.display || '';
        }
        el.style.display = 'none';
      });
    });
    document.body.classList.add('hub-active');
    root.classList.add('active');
    personalizeHero();
    return true;
  }

  function restoreLegacy() {
    document.querySelectorAll('[data-_hub-prev-display]').forEach(function (el) {
      el.style.display = el.dataset._hubPrevDisplay || '';
      delete el.dataset._hubPrevDisplay;
    });
    document.body.classList.remove('hub-active');
  }

  Hub.go = function (route) {
    if (!ensureVisible()) return;
    var body = document.getElementById('hub-body');
    var tabs = document.querySelectorAll('.hub-tab');
    tabs.forEach(function (t) { t.classList.toggle('active', t.dataset.route === route); });
    if (!body) return;
    // Not signed in? Show a clean sign-in CTA instead of routing.
    if (!global.currentUser) { renderSignedOutCta(body); return; }
    var routes = Hub._routes || {};
    var r = routes[route];
    if (!r) {
      body.innerHTML = '<div class="hub-empty"><div class="hub-empty-icon">🗺️</div><h4>Pick a section above</h4><p>Team activity, referrals, partner network, and more.</p></div>';
      return;
    }
    body.innerHTML = '<div class="hub-empty"><div class="hub-empty-icon">⏳</div><p>Loading…</p></div>';
    try {
      Promise.resolve(r.render(body)).catch(function (err) {
        body.innerHTML = '<div class="hub-empty"><div class="hub-empty-icon">⚠️</div><h4>Something went wrong</h4><p>' + (err && err.message ? err.message : 'Unknown error') + '</p></div>';
      });
    } catch (err) {
      body.innerHTML = '<div class="hub-empty"><div class="hub-empty-icon">⚠️</div><h4>Something went wrong</h4><p>' + (err && err.message ? err.message : String(err)) + '</p></div>';
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
    // Not signed in? Skip routing and show the sign-in CTA.
    if (!global.currentUser) {
      var body = document.getElementById('hub-body');
      if (body) renderSignedOutCta(body);
      return;
    }
    // If a tab is already active, we're done.
    var active = document.querySelector('.hub-tab.active');
    if (active) return;
    // Otherwise, route to the default. Hub.go does NOT call Hub.show.
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
    body.innerHTML = ''
      + '<div class="hub-signin-card">'
      +   '<div class="hub-signin-icon">🔒</div>'
      +   '<h3>Sign in to access the Loopenta Hub</h3>'
      +   '<p>Manage your team, work referrals between lenders and realtors, and coordinate with your title &amp; escrow partners — all in one place.</p>'
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

  function personalizeHero() {
    var u = global.currentUser;
    var titleEl = document.getElementById('hub-hero-title');
    var subEl = document.getElementById('hub-hero-sub');
    if (!u || !titleEl || !subEl) return;
    var first = (u.name || u.email || '').split(' ')[0] || 'there';
    var role = Hub.roleLabel(u.role);
    titleEl.textContent = 'Welcome back, ' + first + '.';
    if (u.role === 'manager') {
      subEl.textContent = 'See every move your team makes today, assign new leads, and keep the pipeline full.';
    } else if (u.role === 'admin' || u.role === 'superadmin') {
      subEl.textContent = 'Organization-wide visibility. Manage your team, partners, and the cross-org deal flow.';
    } else if (u.role === 'realtor') {
      subEl.textContent = 'Your buyer pipeline, listings, and the Home Loan Advisors ready to pre-qualify your clients.';
    } else if (u.role === 'mlo') {
      subEl.textContent = 'Your borrowers, your realtors, your referral partners — all in one working view.';
    } else if (u.role === 'referralUser') {
      subEl.textContent = 'Send a qualified referral to a lender or realtor in your network. Track the outcome. Get paid.';
    } else {
      subEl.textContent = 'Work with the right partner at the right moment. That\'s the hub.';
    }
  }

  // Expose re-renderer so sub-modules can force a tabbar refresh after
  // currentUser changes (login, role changes, etc.).
  Hub.refreshNav = function () {
    renderTabbar();
    personalizeHero();
    // If we're currently showing the signed-out CTA and the user just signed in, route to default.
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

  // Auto-mount as soon as the DOM is ready. The hub shell is harmless
  // when hidden (display:none until activated), so we don't need to wait
  // for currentUser — that's only used for personalization/visibility.
  function tryAutoMount() {
    if (mounted) return;
    if (!global.document || !global.document.body) return;
    Hub.mount();
    Hub.refreshNav();
  }
  Hub._tryAutoMount = tryAutoMount;

  // Run ASAP. If DOM not ready, wait for it.
  if (global.document) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', tryAutoMount, { once: true });
    } else {
      // Defer a tick so sub-modules finish loading their registerRoute calls.
      setTimeout(tryAutoMount, 0);
    }
  }

  // Also refresh nav periodically for a minute so role/capability changes
  // at sign-in update the tabbar without requiring a reload.
  var _navRefreshStart = Date.now();
  var _navRefreshTimer = setInterval(function () {
    if (!mounted) return;
    try { Hub.refreshNav(); } catch (e) {}
    if (Date.now() - _navRefreshStart > 60000) clearInterval(_navRefreshTimer);
  }, 1500);

})(typeof window !== 'undefined' ? window : globalThis);
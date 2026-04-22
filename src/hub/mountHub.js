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

  Hub.go = function (route) {
    Hub.show();
    var body = document.getElementById('hub-body');
    var tabs = document.querySelectorAll('.hub-tab');
    tabs.forEach(function (t) { t.classList.toggle('active', t.dataset.route === route); });
    if (!body) return;
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
    var root = document.getElementById('hub-root');
    if (!root) return;
    // Hide legacy tab content (best-effort)
    document.querySelectorAll('.tab-content').forEach(function (el) { el.style.display = 'none'; });
    root.classList.add('active');
    // Personalize hero based on role
    personalizeHero();
    // Render default landing route if none active
    var active = document.querySelector('.hub-tab.active');
    if (!active) {
      var keys = Object.keys(Hub._routes || {});
      if (keys.length) Hub.go(defaultRouteForUser(keys));
    }
  };

  Hub.hide = function () {
    var root = document.getElementById('hub-root');
    if (!root) return;
    root.classList.remove('active');
  };

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
  };

  // Auto-mount as soon as currentUser is ready. Otherwise wait.
  function tryAutoMount() {
    if (mounted) return;
    if (!global.currentUser) { return; }
    Hub.mount();
    // Sub-modules should have registered routes by now.
    Hub.refreshNav();
  }
  Hub._tryAutoMount = tryAutoMount;

  // Install a tiny polling watcher so we pick up currentUser however it
  // gets set (onAuthStateChanged, legacy tryLogin, invite flow, etc.).
  var _watchStart = Date.now();
  var _watchTimer = setInterval(function () {
    if (mounted) { clearInterval(_watchTimer); return; }
    if (global.currentUser) {
      tryAutoMount();
      clearInterval(_watchTimer);
    } else if (Date.now() - _watchStart > 120000) {
      // Stop polling after 2 minutes; user probably never signed in.
      clearInterval(_watchTimer);
    }
  }, 500);

})(typeof window !== 'undefined' ? window : globalThis);

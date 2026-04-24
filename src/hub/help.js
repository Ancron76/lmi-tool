// ======================================================================
// Loopenta Hub — Help Center  (2026-04-23)
// A role-gated documentation center for Super Admins + Admins.
//
//   • Two-column layout: table of contents on the left, article on the right.
//   • Articles are defined inline below; to add / edit one, update ARTICLES
//     and commit + push. No database round-trip, no deploy-time build step.
//   • Each article can have a `video` field with a YouTube *embed* URL
//     (e.g., 'https://www.youtube.com/embed/abc123'). It renders as an
//     iframe above the body text. Leave blank to hide the player.
//   • Access is gated via Hub.capabilities().isAnyAdmin — only Super Admin
//     and org Admin roles see the route.
// ======================================================================
(function (global) {
  'use strict';

  var Hub = global.Hub = global.Hub || {};

  // ── Content ──────────────────────────────────────────────────────────
  // Section order is preserved as written. Add/remove articles freely.
  // `body` accepts raw HTML (do NOT include <script> tags; see renderBody).
  var ARTICLES = [
    // ────────── Getting started ──────────
    {
      id: 'overview',
      section: 'Getting started',
      title: 'Platform overview',
      blurb: 'What Loopenta is and how the pieces fit together.',
      video: '',
      body:
        '<p>Loopenta is a referral-first CRM built for the teams that close real-estate deals together: mortgage lenders, realtors, title, escrow, and referral partners. Each org type gets its own workspace, but referrals route seamlessly across them.</p>' +
        '<h4>The core objects</h4>' +
        '<ul>' +
          '<li><b>Orgs</b> — the companies on the platform. Five types: Mortgage, Real Estate, Title, Escrow, Referral.</li>' +
          '<li><b>Users</b> — people inside orgs, each with a role (Super Admin, Admin, Manager, HLA, Realtor, Referral User, Title/Escrow User).</li>' +
          '<li><b>Referrals (Leads)</b> — a borrower, buyer, seller, or general referral routed from one org to another. Each has a status (pending → accepted → in-process → closed_won / closed_lost) and a kind-specific stage.</li>' +
          '<li><b>Partner Network</b> — the other orgs your team has worked with. Scorecarded by close rate, speed, and volume.</li>' +
        '</ul>' +
        '<h4>Where things live</h4>' +
        '<p>The sidebar is organized into <i>Loopenta Hub</i> (cross-org collaboration: referrals, team activity, partners), <i>Workspace</i> (your home dashboard), <i>Prospecting</i> (LMI Search, Realtors, Open Houses), and <i>Reporting</i> (Dashboard, Activity Log, Analytics, Marketing). Admins also see <i>Help Center</i> — this page.</p>',
    },
    {
      id: 'roles',
      section: 'Getting started',
      title: 'Roles & permissions',
      blurb: 'Who can see and do what.',
      video: '',
      body:
        '<p>Loopenta uses a two-layer access model: <b>role</b> (what job you do) and <b>org</b> (which company you belong to). Firestore rules enforce both.</p>' +
        '<h4>Roles</h4>' +
        '<ul>' +
          '<li><b>Super Admin</b> — platform owner. Sees every org, every user, every lead. Only role that can bootstrap new tenants.</li>' +
          '<li><b>Admin</b> — org owner. Full control of their org\'s users, settings, and leads. Cannot see other orgs.</li>' +
          '<li><b>Manager</b> — can view team activity and assign leads within the org.</li>' +
          '<li><b>HLA / Realtor / Referral User / Title User / Escrow User</b> — front-line producers. See their own leads + leads assigned to them.</li>' +
        '</ul>' +
        '<h4>Cross-org isolation</h4>' +
        '<p>A user can only read or write data tied to their org — with one deliberate exception: both sides of a referral can read and update the lead (otherwise partners couldn\'t collaborate). Everything else, including notification prefs, push subscriptions, and audit logs, is strictly per-org or per-user.</p>',
    },

    // ────────── Referrals ──────────
    {
      id: 'send-referral',
      section: 'Referrals',
      title: 'Send a referral',
      blurb: 'Route a borrower, buyer, seller, or general referral to a partner org.',
      video: '',
      body:
        '<p>Referrals are the core hand-off between orgs. Sending one creates a <i>lead</i> that the receiving org can accept, decline, or work through its pipeline. The sender keeps visibility the whole way.</p>' +
        '<h4>Steps</h4>' +
        '<ol>' +
          '<li>Open the <b>Referrals</b> tab in the left sidebar.</li>' +
          '<li>Click <b>Send a referral</b> (top-right of the list).</li>' +
          '<li>Pick the <b>partner org</b>. If the org you want isn\'t on the list, use <b>Invite a partner</b> first.</li>' +
          '<li>Choose the <b>kind</b>: Borrower, Buyer, Seller, Refinance, or General referral. The stage pipeline adjusts automatically.</li>' +
          '<li>Fill in the client details (name is required; email / phone / property are recommended).</li>' +
          '<li>Set <b>urgency</b> (Normal, High, Low) and add any notes the partner should know.</li>' +
          '<li>Click <b>Send</b>. The partner gets an in-app notification, plus email / push if they\'ve opted in.</li>' +
        '</ol>' +
        '<h4>What happens next</h4>' +
        '<p>The referral starts in <b>Pending</b>. When the partner opens it for the first time, the sender sees a <i>viewed</i> event in the timeline. Acceptance or decline flips the status. See <a href="#manage-pipeline">Manage the pipeline</a> for what follows.</p>',
    },
    {
      id: 'manage-pipeline',
      section: 'Referrals',
      title: 'Manage the pipeline',
      blurb: 'Accept, advance stages, add notes, and close.',
      video: '',
      body:
        '<p>Once a referral is accepted, it enters the kind-specific pipeline. Each kind has its own stages:</p>' +
        '<ul>' +
          '<li><b>Borrower / Refinance</b> — Application → Pre-qualified → Processing → Underwriting → Cleared to Close → Funded.</li>' +
          '<li><b>Buyer</b> — Showing → Offer Out → Under Contract → Inspection → Appraisal → Closed.</li>' +
          '<li><b>Seller</b> — Listing Prep → Listed → Under Contract → Inspection → Appraisal → Closed.</li>' +
          '<li><b>General referral</b> — Working → Qualified → Closed.</li>' +
        '</ul>' +
        '<h4>Advancing stages</h4>' +
        '<ol>' +
          '<li>Open the referral from the list.</li>' +
          '<li>In the stepper at the top, click the next stage. The timeline records a <i>stage_advanced</i> event. The other side gets a notification.</li>' +
          '<li>Clicking an earlier stage writes a <i>stage_reverted</i> event — use it to correct mistakes, not for normal flow.</li>' +
          '<li>Click <b>Add note</b> at the bottom to leave a comment visible to both orgs.</li>' +
        '</ol>',
    },
    {
      id: 'close-deal',
      section: 'Referrals',
      title: 'Close a deal (won or lost)',
      blurb: 'Mark terminal status, capture reason, trigger attribution.',
      video: '',
      body:
        '<p>Every active referral ends in one of three terminal statuses: <b>Declined</b> (rejected up front), <b>Closed · Won</b> (deal funded / house closed), or <b>Closed · Lost</b> (deal died mid-pipeline). Terminal status is what drives Partner Network scoring.</p>' +
        '<h4>Steps</h4>' +
        '<ol>' +
          '<li>Open the referral detail view.</li>' +
          '<li>Click <b>Close · Won</b> or <b>Close · Lost</b> in the action bar.</li>' +
          '<li>For <i>lost</i>, add a short reason so the partner knows what happened.</li>' +
          '<li>The status changes, <code>closedAt</code> is stamped, and the lead leaves the active pipeline.</li>' +
        '</ol>' +
        '<p>Closed deals still appear in the Referrals list with a filter toggle, and they feed the <a href="#partner-scorecard">Partner Network scorecard</a>.</p>',
    },

    // ────────── Partners ──────────
    {
      id: 'invite-partner',
      section: 'Partners',
      title: 'Invite a partner',
      blurb: 'Add a new org to your network so you can route referrals to them.',
      video: '',
      body:
        '<p>If the partner you want to refer to isn\'t already on Loopenta, you can send them an invite. They land on a signup page pre-wired to connect to your org.</p>' +
        '<h4>Steps</h4>' +
        '<ol>' +
          '<li>Open <b>Partner Network</b>.</li>' +
          '<li>Click <b>Invite a partner</b>.</li>' +
          '<li>Enter the partner\'s email and the type of org they run (Mortgage, Real Estate, Title, Escrow, Referral).</li>' +
          '<li>Add a short personal note — this goes into the invite email.</li>' +
          '<li>Send. The partner gets a magic-link signup that auto-creates their org and marks you as a connected org.</li>' +
        '</ol>',
    },
    {
      id: 'partner-scorecard',
      section: 'Partners',
      title: 'Partner Network scorecard',
      blurb: 'Which partners produce, which ones stall.',
      video: '',
      body:
        '<p>The <b>Partner Network</b> page is a roll-up of every org you\'ve done business with. At the top you\'ll see KPIs across your whole network; below that, each partner gets its own row with per-partner numbers.</p>' +
        '<h4>Headline KPIs</h4>' +
        '<ul>' +
          '<li><b>Touched</b> — distinct partners with at least one referral.</li>' +
          '<li><b>Active</b> — partners with a referral currently in process.</li>' +
          '<li><b>Won</b> — total closed-won across all partners.</li>' +
          '<li><b>Close rate</b> — won / (won + lost).</li>' +
          '<li><b>Stuck</b> — referrals that have sat in the same stage for more than 14 days. Red-flag banner shows if any exist.</li>' +
        '</ul>' +
        '<p>Click a partner row to see every referral exchanged with them and their individual scorecard.</p>',
    },

    // ────────── Realtor tools ──────────
    {
      id: 'listings',
      section: 'Realtor tools',
      title: 'Listings',
      blurb: 'Inventory you\'re representing, LMI-flagged properties, and distribution.',
      video: '',
      body:
        '<p>The Listings module is for realtor orgs tracking active inventory. Each listing can be manually entered or imported from MLS if your org has that integration enabled.</p>' +
        '<h4>Steps</h4>' +
        '<ol>' +
          '<li>Open the <b>Listings</b> tab in the Hub tabbar (realtor orgs only).</li>' +
          '<li>Click <b>Add listing</b>. Enter address, price, MLS number, and key flags (LMI-eligible, open-house scheduled, under contract).</li>' +
          '<li>Listings marked LMI-eligible surface on the public lmitool.com search results for loan officers hunting inventory.</li>' +
        '</ol>',
    },
    {
      id: 'buyer-pipeline',
      section: 'Realtor tools',
      title: 'Buyer pipeline',
      blurb: 'Track buyer prospects from first showing to close.',
      video: '',
      body:
        '<p>The buyer pipeline is a kanban-style board of every buyer you\'re working with, grouped by stage (Showing, Offer Out, Under Contract, Inspection, Appraisal, Closed).</p>' +
        '<h4>How it connects to referrals</h4>' +
        '<p>When a loan officer refers a pre-approved buyer to you, a new card auto-appears in your <i>Showing</i> column. Work it through the stages and the LO sees progress on their end in real time.</p>',
    },
    {
      id: 'open-houses',
      section: 'Realtor tools',
      title: 'Open Houses',
      blurb: 'Schedule, staff, and capture leads at open houses.',
      video: '',
      body:
        '<p>The Open Houses module lets realtors schedule upcoming open houses, assign staffers, and capture visitor contact info with a QR code kiosk mode.</p>' +
        '<h4>Lead capture</h4>' +
        '<p>Visitors scan a QR code on a sign-in tablet, enter name / phone / email, and an opt-in toggle for follow-up. The lead appears in the Realtor\'s Buyer Pipeline with source set to "open house" and the property address stamped.</p>',
    },

    // ────────── Mortgage tools ──────────
    {
      id: 'lmi-search',
      section: 'Mortgage tools',
      title: 'LMI Search',
      blurb: 'Find CRA-qualifying properties in low/moderate-income census tracts.',
      video: '',
      body:
        '<p>The LMI Search is the compliance-focused heart of the platform for mortgage lenders. It lets you look up any property and tells you instantly whether it\'s in an LMI tract (FFIEC-defined) — the key input to CRA qualification.</p>' +
        '<h4>Steps</h4>' +
        '<ol>' +
          '<li>Open the <b>LMI Search</b> tab.</li>' +
          '<li>Enter an address or drop a pin on the map.</li>' +
          '<li>Results show the census tract, median family income ratio, distressed/underserved flags, and current LMI status.</li>' +
          '<li>Save searches to revisit later; export matching tracts as a shopping list for your origination team.</li>' +
        '</ol>',
    },

    // ────────── Team ──────────
    {
      id: 'team-activity',
      section: 'Team',
      title: 'Team Activity',
      blurb: 'Manager / Admin view of what each team member is doing.',
      video: '',
      body:
        '<p>Team Activity rolls up every meaningful action (prospects touched, leads sent, flyers distributed, CRA activities logged) by user, over a rolling window.</p>' +
        '<h4>Who sees it</h4>' +
        '<p>Visible to Manager, Admin, and Super Admin roles. Producer-only users (HLAs, Realtors, etc.) don\'t see the tab.</p>' +
        '<h4>What to watch for</h4>' +
        '<ul>' +
          '<li>Members with zero activity over 7+ days — might be blocked or onboarding-stalled.</li>' +
          '<li>Heavy flyer activity without matching leads — marketing isn\'t converting.</li>' +
          '<li>Lots of prospects logged but no referrals sent — untapped partner-routing opportunity.</li>' +
        '</ul>',
    },

    // ────────── Notifications ──────────
    {
      id: 'notifications',
      section: 'Notifications',
      title: 'Notifications & preferences',
      blurb: 'In-app bell, email, browser push — how they work and how to tune them.',
      video: '',
      body:
        '<p>Loopenta pushes notifications through three channels, all opt-in per-user:</p>' +
        '<ol>' +
          '<li><b>In-app bell</b> — the bell icon in the top-right. Real-time via Firestore. Always on.</li>' +
          '<li><b>Email</b> — sent via a Cloudflare Worker when opted in. Subject mirrors the bell title; body has the action, actor, and deep link.</li>' +
          '<li><b>Browser push</b> — native OS notifications even when the tab is closed. Opt-in triggers a browser permission prompt.</li>' +
        '</ol>' +
        '<h4>Adjusting preferences</h4>' +
        '<p>Click the <b>gear</b> inside the bell dropdown. Each channel has its own toggle. Turning the bell feed off is not possible (it\'s the audit trail); only email and push can be silenced.</p>',
    },

    // ────────── Admin ──────────
    {
      id: 'user-mgmt',
      section: 'Admin',
      title: 'User management',
      blurb: 'Add, remove, and re-role users in your org.',
      video: '',
      body:
        '<p>From the admin console, you can invite new users, change roles, and deactivate accounts. Changes take effect immediately.</p>' +
        '<h4>Inviting a user</h4>' +
        '<ol>' +
          '<li>Open <b>Admin</b> → <b>Users</b>.</li>' +
          '<li>Click <b>Invite user</b>.</li>' +
          '<li>Enter email and role. A magic-link signup goes out; the user picks their password on click-through.</li>' +
        '</ol>' +
        '<h4>Changing a role</h4>' +
        '<p>Click a user row, pick the new role, save. The next time that user loads the app, their sidebar and permissions update. They don\'t need to re-auth.</p>',
    },
    {
      id: 'org-settings',
      section: 'Admin',
      title: 'Org settings',
      blurb: 'Branding, tier, partnerships, compliance defaults.',
      video: '',
      body:
        '<p>Org-level settings live under <b>Admin</b> → <b>Org settings</b>. Highlights:</p>' +
        '<ul>' +
          '<li><b>Branding</b> — logo, primary color, custom domain.</li>' +
          '<li><b>Tier</b> — feature ceiling (Starter / Growth / Enterprise). Determines which modules appear in the sidebar.</li>' +
          '<li><b>Partnerships</b> — orgs you\'ve connected with. Unlink anyone who\'s churned.</li>' +
          '<li><b>Compliance defaults</b> — CRA goal per-member, rate-lock alert window, realtor idle threshold. These drive the Home dashboard alerts.</li>' +
        '</ul>',
    },
  ];

  // ── Route registration ───────────────────────────────────────────────
  Hub.registerRoute && Hub.registerRoute('help', {
    label: 'Help Center',
    icon:  '?',
    visible: function (caps) {
      return caps && caps.isAnyAdmin; // Super Admin + Admin only
    },
    render: function (mount) {
      renderHelp(mount);
    },
  });

  // ── Rendering ────────────────────────────────────────────────────────
  var STATE = { currentId: null };

  function renderHelp(mount) {
    // Pick a default article: the first in the list, or the last one viewed.
    if (!STATE.currentId || !findArticle(STATE.currentId)) {
      STATE.currentId = ARTICLES[0] && ARTICLES[0].id;
    }

    mount.innerHTML = ''
      + '<div class="hub-section-h">'
      +   '<div>'
      +     '<h2>Help Center</h2>'
      +     '<div class="hub-section-sub">Manuals and video walkthroughs. Visible to Super Admins and Admins only.</div>'
      +   '</div>'
      + '</div>'
      + '<div class="help-layout">'
      +   '<aside class="help-toc" id="help-toc" aria-label="Help table of contents"></aside>'
      +   '<section class="help-article" id="help-article" aria-live="polite"></section>'
      + '</div>';

    renderToc();
    renderArticle(STATE.currentId);

    // Clicks inside the TOC + article pane (event-delegated).
    mount.addEventListener('click', onHelpClick);
  }

  function renderToc() {
    var toc = document.getElementById('help-toc');
    if (!toc) return;

    // Group articles by section, preserving insertion order.
    var sections = [];
    var seen = {};
    ARTICLES.forEach(function (a) {
      if (!seen[a.section]) { seen[a.section] = true; sections.push(a.section); }
    });

    var html = '<div class="help-toc-search-wrap">'
      +   '<input type="search" id="help-search" placeholder="Search articles…" class="help-toc-search" />'
      + '</div>';

    sections.forEach(function (sec) {
      html += '<div class="help-toc-section"><div class="help-toc-section-label">' + esc(sec) + '</div><ul>';
      ARTICLES.filter(function (a) { return a.section === sec; }).forEach(function (a) {
        var activeCls = a.id === STATE.currentId ? ' help-toc-active' : '';
        html += '<li><a href="#' + esc(a.id) + '" class="help-toc-link' + activeCls + '" data-article="' + esc(a.id) + '">'
             +    esc(a.title)
             + '</a></li>';
      });
      html += '</ul></div>';
    });

    toc.innerHTML = html;

    var searchInput = document.getElementById('help-search');
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        applyTocFilter(this.value);
      });
    }
  }

  function applyTocFilter(q) {
    q = (q || '').trim().toLowerCase();
    var toc = document.getElementById('help-toc');
    if (!toc) return;
    var links = toc.querySelectorAll('.help-toc-link');
    links.forEach(function (a) {
      var id = a.dataset.article;
      var art = findArticle(id);
      var hay = (art.title + ' ' + art.blurb + ' ' + art.section + ' ' + stripTags(art.body)).toLowerCase();
      var show = !q || hay.indexOf(q) !== -1;
      a.parentElement.style.display = show ? '' : 'none';
    });
    // Hide section labels whose items are all hidden.
    toc.querySelectorAll('.help-toc-section').forEach(function (sec) {
      var anyVisible = Array.prototype.some.call(sec.querySelectorAll('li'), function (li) {
        return li.style.display !== 'none';
      });
      sec.style.display = anyVisible ? '' : 'none';
    });
  }

  function renderArticle(id) {
    var el = document.getElementById('help-article');
    var art = findArticle(id);
    if (!el) return;
    if (!art) {
      el.innerHTML = '<div class="hub-empty"><h4>Article not found</h4></div>';
      return;
    }

    var videoHtml = art.video
      ? '<div class="help-video"><iframe src="' + esc(art.video) + '" title="' + esc(art.title)
        + '" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"'
        + ' allowfullscreen></iframe></div>'
      : '<div class="help-video-placeholder">Video walkthrough coming soon.</div>';

    el.innerHTML = ''
      + '<div class="help-article-header">'
      +   '<div class="help-article-eyebrow">' + esc(art.section) + '</div>'
      +   '<h1 class="help-article-title">' + esc(art.title) + '</h1>'
      +   (art.blurb ? '<p class="help-article-blurb">' + esc(art.blurb) + '</p>' : '')
      + '</div>'
      + videoHtml
      + '<div class="help-article-body">' + art.body + '</div>';

    // Scroll to the top of the article pane.
    el.scrollTop = 0;
  }

  function onHelpClick(e) {
    var a = e.target.closest && e.target.closest('a[data-article]');
    if (a) {
      e.preventDefault();
      var id = a.dataset.article;
      goToArticle(id);
      return;
    }
    // In-body links like <a href="#send-referral">
    var inlineLink = e.target.closest && e.target.closest('a[href^="#"]');
    if (inlineLink) {
      var id2 = inlineLink.getAttribute('href').slice(1);
      if (findArticle(id2)) {
        e.preventDefault();
        goToArticle(id2);
      }
    }
  }

  function goToArticle(id) {
    if (!findArticle(id)) return;
    STATE.currentId = id;
    // Update the TOC highlight without rebuilding the whole list.
    var toc = document.getElementById('help-toc');
    if (toc) {
      toc.querySelectorAll('.help-toc-link').forEach(function (a) {
        a.classList.toggle('help-toc-active', a.dataset.article === id);
      });
    }
    renderArticle(id);
  }

  // ── Helpers ──────────────────────────────────────────────────────────
  function findArticle(id) {
    for (var i = 0; i < ARTICLES.length; i++) if (ARTICLES[i].id === id) return ARTICLES[i];
    return null;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function stripTags(html) {
    return String(html || '').replace(/<[^>]+>/g, ' ');
  }

  // ── Sidebar visibility gate ──────────────────────────────────────────
  // The sidebar <button id="sn-hub-help"> is hidden by default. Show it
  // when we know the user is an admin or super admin. We poll because the
  // currentUser object populates asynchronously after Firebase auth.
  function syncSidebar() {
    var btn = global.document && global.document.getElementById('sn-hub-help');
    if (!btn) return;
    var u = global.currentUser;
    var isAdmin = !!(u && (u.role === 'admin' || u.role === 'superadmin'));
    btn.style.display = isAdmin ? '' : 'none';
  }
  if (global.document) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', syncSidebar, { once: true });
    } else {
      setTimeout(syncSidebar, 0);
    }
    // Poll for up to 2 minutes after load so we catch the currentUser swap
    // once Firebase resolves the signed-in session. Self-clears.
    var _helpSyncStart = Date.now();
    var _helpSyncTimer = setInterval(function () {
      syncSidebar();
      if (Date.now() - _helpSyncStart > 120000) clearInterval(_helpSyncTimer);
    }, 1500);
  }

  console.info('[Hub.help] loaded', ARTICLES.length, 'articles');

})(typeof window !== 'undefined' ? window : globalThis);

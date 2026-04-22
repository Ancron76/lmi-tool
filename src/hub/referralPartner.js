// ======================================================================
// Loopenta Hub — Referral Partner + Title/Escrow views (2026-04-22)
// Minimal, scaffolded UIs for the non-mortgage/non-realtor org types.
// ======================================================================
(function (global) {
  'use strict';

  var Hub = global.Hub = global.Hub || {};

  // ─────── Referral Partner dashboard ───────
  Hub.registerRoute && Hub.registerRoute('partnerDesk', {
    label: 'Partner Desk',
    icon: '🤝',
    visible: function (caps) {
      var u = global.currentUser;
      if (!u) return false;
      if (caps.isSuperAdmin) return true;
      var orgType = Hub.orgTypeOf(global.currentOrg);
      return orgType === 'referralPartner' && (caps.isAdmin || caps.isManager || caps.isReferralUser);
    },
    render: async function (mount) {
      mount.innerHTML = partnerDesk();
      try { await renderPartnerKpis(mount); }
      catch (e) { mount.innerHTML = err$(e); }
    },
  });

  // ─────── Title portal scaffold ───────
  Hub.registerRoute && Hub.registerRoute('titleDesk', {
    label: 'Title Desk',
    icon: '📄',
    visible: function (caps) {
      var u = global.currentUser; if (!u) return false;
      if (caps.isSuperAdmin) return true;
      var orgType = Hub.orgTypeOf(global.currentOrg);
      return orgType === 'title';
    },
    render: async function (mount) {
      mount.innerHTML = desk('Title', 'Orders, commitments, and closing-day documents.');
    },
  });

  // ─────── Escrow portal scaffold ───────
  Hub.registerRoute && Hub.registerRoute('escrowDesk', {
    label: 'Escrow Desk',
    icon: '🔐',
    visible: function (caps) {
      var u = global.currentUser; if (!u) return false;
      if (caps.isSuperAdmin) return true;
      var orgType = Hub.orgTypeOf(global.currentOrg);
      return orgType === 'escrow';
    },
    render: async function (mount) {
      mount.innerHTML = desk('Escrow', 'Files, dates, funds, and closings.');
    },
  });

  function partnerDesk() {
    return ''
      + '<div class="hub-section-h">'
      +   '<div><h2>Partner Desk</h2><div class="hub-section-sub">Referrals you\'ve sent, what\'s in progress, what closed.</div></div>'
      +   '<button class="hub-btn hub-btn-primary" onclick="Hub.openReferralSend()">🚀 Send a referral</button>'
      + '</div>'
      + '<div class="hub-kpis" id="hub-pd-kpis"></div>'
      + '<div style="margin-top:18px">'
      +   '<div class="hub-card">'
      +     '<div class="hub-card-header"><div class="hub-card-title">How it works</div></div>'
      +     '<ol style="color:#334155;line-height:1.8;margin:0;padding-left:18px">'
      +       '<li><strong>Send a referral</strong> — pick a mortgage / real-estate partner and give them a pre-qualified client.</li>'
      +       '<li><strong>Track it</strong> — watch the status move from sent → working → won/lost.</li>'
      +       '<li><strong>Get paid</strong> — if you have a referral agreement, the partner logs the closing outcome here.</li>'
      +     '</ol>'
      +   '</div>'
      + '</div>';
  }

  function desk(title, sub) {
    return ''
      + '<div class="hub-section-h"><div><h2>' + title + ' Desk</h2><div class="hub-section-sub">' + sub + '</div></div></div>'
      + '<div class="hub-empty">'
      +   '<div class="hub-empty-icon">🚧</div>'
      +   '<h4>We\'re building the ' + title + ' workflow next</h4>'
      +   '<p>You already have accounts and role scaffolding. Document uploads, closing-date tracking, and status beacons ship next.</p>'
      +   '<p style="margin-top:10px"><strong>In the meantime:</strong> use <em>Referrals</em> to receive deals from your mortgage / real-estate partners.</p>'
      + '</div>';
  }

  async function renderPartnerKpis(mount) {
    var db = global.db; var u = global.currentUser;
    if (!db || !u) return;
    var box = mount.querySelector('#hub-pd-kpis'); if (!box) return;
    var snap = await db.collection('leads').where('fromUserId', '==', u.id).get().catch(function () { return { docs: [] }; });
    var leads = snap.docs.map(function (d) { return d.data(); });
    var total = leads.length;
    var working = leads.filter(function (l) { return l.status === 'working' || l.status === 'accepted' || l.status === 'sent'; }).length;
    var won = leads.filter(function (l) { return l.status === 'won'; }).length;
    var lost = leads.filter(function (l) { return l.status === 'lost'; }).length;
    box.innerHTML = ''
      + kpi('Total sent', total, 'referrals')
      + kpi('In progress', working, 'across partners')
      + kpi('Closed won', won, 'celebrate!')
      + kpi('Closed lost', lost, 'next time');
  }

  function kpi(label, value, sub) {
    return ''
      + '<div class="hub-kpi">'
      +   '<div class="hub-kpi-label">' + label + '</div>'
      +   '<div class="hub-kpi-value">' + value + '</div>'
      +   '<div class="hub-kpi-delta">' + sub + '</div>'
      + '</div>';
  }

  function err$(e) { return '<div class="hub-empty"><div class="hub-empty-icon">⚠️</div><p>' + (e && e.message || String(e)) + '</p></div>'; }

})(typeof window !== 'undefined' ? window : globalThis);

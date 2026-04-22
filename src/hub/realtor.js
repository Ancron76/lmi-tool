// ======================================================================
// Loopenta Hub — Realtor features (2026-04-22)
//   • Listings board (create / edit / mark sold)
//   • Buyer pipeline (Lead → Showing → Offer → Under Contract → Closed)
//   • LMI-eligible property badges + one-click referral to an HLA
// ======================================================================
(function (global) {
  'use strict';

  var Hub = global.Hub = global.Hub || {};

  var BUYER_STAGES = ['Lead', 'Showing', 'Offer', 'Under Contract', 'Closed'];

  Hub.registerRoute && Hub.registerRoute('listings', {
    label: 'Listings',
    icon: '🏠',
    visible: function (caps) {
      var u = global.currentUser;
      if (!u) return false;
      // Realtor/Broker/Admin/Manager of realEstate orgs + superadmin
      if (caps.isSuperAdmin) return true;
      var org = global.currentOrg;
      var orgType = Hub.orgTypeOf(org);
      return (orgType === 'realEstate') && (caps.isAdmin || caps.isManager || caps.isRealtor);
    },
    render: async function (mount) {
      mount.innerHTML = listingsSkeleton();
      try { await renderListings(mount); }
      catch (e) { mount.innerHTML = err$(e); }
    },
  });

  Hub.registerRoute && Hub.registerRoute('buyers', {
    label: 'Buyer Pipeline',
    icon: '🧭',
    visible: function (caps) {
      var u = global.currentUser;
      if (!u) return false;
      if (caps.isSuperAdmin) return true;
      var org = global.currentOrg;
      var orgType = Hub.orgTypeOf(org);
      return (orgType === 'realEstate') && (caps.isAdmin || caps.isManager || caps.isRealtor);
    },
    render: async function (mount) {
      mount.innerHTML = buyerSkeleton();
      try { await renderBuyers(mount); }
      catch (e) { mount.innerHTML = err$(e); }
    },
  });

  // ──────────── Listings ────────────
  function listingsSkeleton() {
    return ''
      + '<div class="hub-section-h">'
      +   '<div><h2>Listings</h2><div class="hub-section-sub">Active, pending, and sold — your transactions at a glance.</div></div>'
      +   '<button class="hub-btn hub-btn-primary" onclick="Hub._openNewListing()">➕ New listing</button>'
      + '</div>'
      + '<div id="hub-listings-body"></div>';
  }

  async function renderListings(mount) {
    var db = global.db; var u = global.currentUser;
    var body = mount.querySelector('#hub-listings-body');
    if (!db || !u) { body.innerHTML = unlocked('Sign in to see listings.'); return; }
    var myOrg = u.orgId || '';
    var snap = await db.collection('listings').where('orgId', '==', myOrg).get().catch(function () { return { docs: [] }; });
    var items = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    if (!items.length) {
      body.innerHTML = ''
        + '<div class="hub-empty">'
        +   '<div class="hub-empty-icon">🏡</div>'
        +   '<h4>No listings yet</h4>'
        +   '<p>Click <strong>New listing</strong> to add your first one. LMI eligibility is auto-flagged.</p>'
        + '</div>';
      return;
    }
    items.sort(function (a, b) { return new Date(b.createdAt || 0) - new Date(a.createdAt || 0); });
    var html = '<div class="hub-kpis">'
      + kpi('Active',   items.filter(function (i) { return i.status === 'active';  }).length, 'on market')
      + kpi('Pending',  items.filter(function (i) { return i.status === 'pending'; }).length, 'under contract')
      + kpi('LMI-eligible', items.filter(function (i) { return i.lmiEligible; }).length, 'in LMI tracts')
      + kpi('Closed YTD', items.filter(function (i) { return i.status === 'closed'; }).length, '')
      + '</div>';
    html += '<div class="hub-card" style="margin-top:18px"><div style="overflow-x:auto"><table class="hub-table">'
      + '<thead><tr><th>Address</th><th>Price</th><th>Status</th><th>LMI</th><th>Agent</th><th>Days on market</th><th></th></tr></thead>'
      + '<tbody>';
    items.forEach(function (l) {
      var addr = [l.address, l.city, l.state, l.zip].filter(Boolean).join(', ');
      html += ''
        + '<tr>'
        +   '<td><strong>' + esc(addr) + '</strong>'
        +     (l.mls ? '<div style="font-size:11px;color:#94a3b8">MLS# ' + esc(l.mls) + '</div>' : '') + '</td>'
        +   '<td>$' + Number(l.price || 0).toLocaleString() + '</td>'
        +   '<td><span class="hub-status ' + esc(l.status || 'active') + '">' + esc(l.status || 'active') + '</span></td>'
        +   '<td>' + (l.lmiEligible ? '<span class="hub-status won">LMI ✓</span>' : '<span style="color:#94a3b8">—</span>') + '</td>'
        +   '<td>' + esc(l.agentName || '') + '</td>'
        +   '<td style="color:#64748b">' + domDays(l.createdAt) + '</td>'
        +   '<td>'
        +     '<button class="hub-btn hub-btn-secondary" style="padding:4px 8px;font-size:11px" onclick="Hub._referListingToLender(\'' + esc(l.id) + '\')">Refer to HLA</button>'
        +     '<button class="hub-btn hub-btn-secondary" style="padding:4px 8px;font-size:11px;margin-left:4px" onclick="Hub._editListing(\'' + esc(l.id) + '\')">Edit</button>'
        +   '</td>'
        + '</tr>';
    });
    html += '</tbody></table></div></div>';
    body.innerHTML = html;
  }

  Hub._openNewListing = function () {
    var backdrop = modalBackdrop();
    backdrop.innerHTML = ''
      + '<div class="hub-modal">'
      +   '<div class="hub-modal-h"><h3>New listing</h3>'
      +     '<button class="hub-modal-close" onclick="this.closest(\'.hub-modal-backdrop\').remove()">×</button></div>'
      +   listingFormHtml()
      + '</div>';
    document.body.appendChild(backdrop);
  };

  Hub._editListing = async function (id) {
    var db = global.db; if (!db) return;
    var doc = await db.collection('listings').doc(id).get();
    if (!doc.exists) return alert('Listing not found');
    var l = Object.assign({ id: doc.id }, doc.data());
    var backdrop = modalBackdrop();
    backdrop.innerHTML = ''
      + '<div class="hub-modal">'
      +   '<div class="hub-modal-h"><h3>Edit listing</h3>'
      +     '<button class="hub-modal-close" onclick="this.closest(\'.hub-modal-backdrop\').remove()">×</button></div>'
      +   listingFormHtml(l)
      + '</div>';
    document.body.appendChild(backdrop);
  };

  function listingFormHtml(l) {
    l = l || {};
    return ''
      + '<div id="hub-listing-form">'
      +   '<div class="hub-field"><label>Address</label><input id="hl-addr" type="text" value="' + esc(l.address || '') + '"/></div>'
      +   '<div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:12px">'
      +     '<div class="hub-field"><label>City</label><input id="hl-city" type="text" value="' + esc(l.city || '') + '"/></div>'
      +     '<div class="hub-field"><label>State</label><input id="hl-state" maxlength="2" value="' + esc(l.state || '') + '"/></div>'
      +     '<div class="hub-field"><label>ZIP</label><input id="hl-zip" maxlength="5" value="' + esc(l.zip || '') + '"/></div>'
      +   '</div>'
      +   '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">'
      +     '<div class="hub-field"><label>Price</label><input id="hl-price" type="number" value="' + esc(l.price || '') + '"/></div>'
      +     '<div class="hub-field"><label>MLS#</label><input id="hl-mls" type="text" value="' + esc(l.mls || '') + '"/></div>'
      +     '<div class="hub-field"><label>Status</label><select id="hl-status">'
      +       ['active', 'pending', 'closed', 'withdrawn'].map(function (s) { return '<option ' + (l.status === s ? 'selected' : '') + '>' + s + '</option>'; }).join('') + '</select></div>'
      +   '</div>'
      +   '<div class="hub-field"><label><input id="hl-lmi" type="checkbox" ' + (l.lmiEligible ? 'checked' : '') + '/> &nbsp;This property is in an LMI-eligible tract</label></div>'
      +   '<div class="hub-field"><label>Public remarks</label><textarea id="hl-remarks" rows="3">' + esc(l.remarks || '') + '</textarea></div>'
      +   '<div style="display:flex;gap:10px;justify-content:flex-end">'
      +     '<button class="hub-btn hub-btn-secondary" onclick="this.closest(\'.hub-modal-backdrop\').remove()">Cancel</button>'
      +     '<button class="hub-btn hub-btn-primary" onclick="Hub._saveListing(' + (l.id ? "'" + l.id + "'" : '') + ')">💾 Save</button>'
      +   '</div>'
      + '</div>';
  }

  Hub._saveListing = async function (id) {
    var db = global.db; var u = global.currentUser;
    if (!db || !u) return;
    var data = {
      orgId:     u.orgId || '',
      agentId:   u.id,
      agentName: u.name || u.email || '',
      address:   document.getElementById('hl-addr').value,
      city:      document.getElementById('hl-city').value,
      state:     document.getElementById('hl-state').value.toUpperCase(),
      zip:       document.getElementById('hl-zip').value,
      price:     Number(document.getElementById('hl-price').value) || 0,
      mls:       document.getElementById('hl-mls').value,
      status:    document.getElementById('hl-status').value,
      lmiEligible: document.getElementById('hl-lmi').checked,
      remarks:   document.getElementById('hl-remarks').value,
      updatedAt: new Date().toISOString(),
    };
    try {
      if (id) {
        await db.collection('listings').doc(id).update(data);
      } else {
        data.createdAt = new Date().toISOString();
        await db.collection('listings').add(data);
      }
      document.querySelectorAll('.hub-modal-backdrop').forEach(function (b) { b.remove(); });
      toast('Listing saved');
      Hub.go('listings');
    } catch (e) {
      alert('Save failed: ' + (e.message || e));
    }
  };

  Hub._referListingToLender = async function (id) {
    // Open the referrals send dialog pre-filled with this property
    var db = global.db; if (!db) return;
    var doc = await db.collection('listings').doc(id).get();
    if (!doc.exists) return;
    var l = doc.data();
    if (!Hub.openReferralSend) return alert('Referrals module not loaded');
    Hub.openReferralSend();
    // Populate fields after modal opens
    setTimeout(function () {
      var kind = document.getElementById('hub-send-kind'); if (kind) kind.value = 'buyer';
      var addr = document.getElementById('hub-send-prop'); if (addr) addr.value = l.address || '';
      var city = document.getElementById('hub-send-city'); if (city) city.value = l.city || '';
      var st   = document.getElementById('hub-send-state'); if (st) st.value = l.state || '';
      var zip  = document.getElementById('hub-send-zip'); if (zip) zip.value = l.zip || '';
      var pr   = document.getElementById('hub-send-price'); if (pr) pr.value = l.price || '';
      var note = document.getElementById('hub-send-note'); if (note) note.value = 'Client interested in ' + (l.address || 'this property') + '. MLS#' + (l.mls || '—') + '. Please reach out to pre-qualify.';
    }, 80);
  };

  // ──────────── Buyer Pipeline ────────────
  function buyerSkeleton() {
    return ''
      + '<div class="hub-section-h">'
      +   '<div><h2>Buyer pipeline</h2><div class="hub-section-sub">Every active buyer, stage by stage.</div></div>'
      +   '<button class="hub-btn hub-btn-primary" onclick="Hub._openNewBuyer()">➕ Add buyer</button>'
      + '</div>'
      + '<div id="hub-buyers-body"></div>';
  }

  async function renderBuyers(mount) {
    var db = global.db; var u = global.currentUser;
    var body = mount.querySelector('#hub-buyers-body');
    if (!db || !u) { body.innerHTML = unlocked('Sign in to see your buyers.'); return; }
    var snap = await db.collection('buyers').where('orgId', '==', u.orgId || '').get().catch(function () { return { docs: [] }; });
    var items = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    if (!items.length) {
      body.innerHTML = ''
        + '<div class="hub-empty">'
        +   '<div class="hub-empty-icon">🧭</div>'
        +   '<h4>No buyers yet</h4>'
        +   '<p>Track every buyer from first showing to keys. LMI pre-qual handoff is one click.</p>'
        + '</div>';
      return;
    }
    var byStage = {};
    BUYER_STAGES.forEach(function (s) { byStage[s] = []; });
    items.forEach(function (b) {
      var s = b.stage || 'Lead';
      if (!byStage[s]) byStage[s] = [];
      byStage[s].push(b);
    });
    var html = '<div class="hub-pipeline">';
    BUYER_STAGES.forEach(function (stage) {
      var arr = byStage[stage] || [];
      html += ''
        + '<div class="hub-pipeline-col">'
        +   '<div class="hub-pipeline-col-h"><span>' + esc(stage) + '</span><span>' + arr.length + '</span></div>'
        +   arr.map(function (b) { return pipelineCard(b); }).join('')
        + '</div>';
    });
    html += '</div>';
    body.innerHTML = html;
  }

  function pipelineCard(b) {
    return ''
      + '<div class="hub-pipeline-card" onclick="Hub._editBuyer(\'' + esc(b.id) + '\')">'
      +   '<div class="hub-pc-title">' + esc(b.name || 'Unnamed') + '</div>'
      +   '<div class="hub-pc-meta">'
      +     (b.budget ? '$' + Number(b.budget).toLocaleString() + ' · ' : '')
      +     (b.area || '')
      +   '</div>'
      +   (b.preQualified ? '<div style="margin-top:4px"><span class="hub-status won">Pre-qualified</span></div>' : '')
      + '</div>';
  }

  Hub._openNewBuyer = function () {
    var backdrop = modalBackdrop();
    backdrop.innerHTML = ''
      + '<div class="hub-modal">'
      +   '<div class="hub-modal-h"><h3>Add buyer</h3>'
      +     '<button class="hub-modal-close" onclick="this.closest(\'.hub-modal-backdrop\').remove()">×</button></div>'
      +   buyerFormHtml()
      + '</div>';
    document.body.appendChild(backdrop);
  };

  Hub._editBuyer = async function (id) {
    var db = global.db; if (!db) return;
    var doc = await db.collection('buyers').doc(id).get();
    if (!doc.exists) return;
    var b = Object.assign({ id: doc.id }, doc.data());
    var backdrop = modalBackdrop();
    backdrop.innerHTML = ''
      + '<div class="hub-modal">'
      +   '<div class="hub-modal-h"><h3>Edit buyer</h3>'
      +     '<button class="hub-modal-close" onclick="this.closest(\'.hub-modal-backdrop\').remove()">×</button></div>'
      +   buyerFormHtml(b)
      + '</div>';
    document.body.appendChild(backdrop);
  };

  function buyerFormHtml(b) {
    b = b || {};
    return ''
      + '<div class="hub-field"><label>Name</label><input id="hb-name" type="text" value="' + esc(b.name || '') + '"/></div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">'
      +   '<div class="hub-field"><label>Email</label><input id="hb-email" type="email" value="' + esc(b.email || '') + '"/></div>'
      +   '<div class="hub-field"><label>Phone</label><input id="hb-phone" type="tel" value="' + esc(b.phone || '') + '"/></div>'
      + '</div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">'
      +   '<div class="hub-field"><label>Target area / ZIP</label><input id="hb-area" type="text" value="' + esc(b.area || '') + '"/></div>'
      +   '<div class="hub-field"><label>Budget</label><input id="hb-budget" type="number" value="' + esc(b.budget || '') + '"/></div>'
      + '</div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">'
      +   '<div class="hub-field"><label>Stage</label><select id="hb-stage">'
      +     BUYER_STAGES.map(function (s) { return '<option ' + (b.stage === s ? 'selected' : '') + '>' + s + '</option>'; }).join('')
      +   '</select></div>'
      +   '<div class="hub-field"><label>Pre-qualified?</label><select id="hb-pq"><option value="false">No</option><option value="true" ' + (b.preQualified ? 'selected' : '') + '>Yes</option></select></div>'
      + '</div>'
      + '<div class="hub-field"><label>Notes</label><textarea id="hb-notes" rows="3">' + esc(b.notes || '') + '</textarea></div>'
      + '<div style="display:flex;gap:10px;justify-content:space-between">'
      +   '<button class="hub-btn hub-btn-secondary" onclick="Hub._referBuyerToLender(' + (b.id ? "'" + b.id + "'" : 'null') + ')">🚀 Refer to HLA</button>'
      +   '<div>'
      +     '<button class="hub-btn hub-btn-secondary" onclick="this.closest(\'.hub-modal-backdrop\').remove()">Cancel</button>'
      +     '<button class="hub-btn hub-btn-primary" style="margin-left:8px" onclick="Hub._saveBuyer(' + (b.id ? "'" + b.id + "'" : '') + ')">💾 Save</button>'
      +   '</div>'
      + '</div>';
  }

  Hub._saveBuyer = async function (id) {
    var db = global.db; var u = global.currentUser;
    if (!db || !u) return;
    var data = {
      orgId:        u.orgId || '',
      agentId:      u.id,
      agentName:    u.name || u.email || '',
      name:         document.getElementById('hb-name').value,
      email:        document.getElementById('hb-email').value,
      phone:        document.getElementById('hb-phone').value,
      area:         document.getElementById('hb-area').value,
      budget:       Number(document.getElementById('hb-budget').value) || 0,
      stage:        document.getElementById('hb-stage').value,
      preQualified: document.getElementById('hb-pq').value === 'true',
      notes:        document.getElementById('hb-notes').value,
      updatedAt:    new Date().toISOString(),
    };
    try {
      if (id) {
        await db.collection('buyers').doc(id).update(data);
      } else {
        data.createdAt = new Date().toISOString();
        await db.collection('buyers').add(data);
      }
      document.querySelectorAll('.hub-modal-backdrop').forEach(function (b) { b.remove(); });
      toast('Buyer saved');
      Hub.go('buyers');
    } catch (e) {
      alert('Save failed: ' + (e.message || e));
    }
  };

  Hub._referBuyerToLender = async function (id) {
    if (!Hub.openReferralSend) return alert('Referrals module not loaded');
    // Capture form values if it's an unsaved buyer
    var name  = document.getElementById('hb-name')  ? document.getElementById('hb-name').value : '';
    var email = document.getElementById('hb-email') ? document.getElementById('hb-email').value : '';
    var phone = document.getElementById('hb-phone') ? document.getElementById('hb-phone').value : '';
    var area  = document.getElementById('hb-area')  ? document.getElementById('hb-area').value : '';
    var budget= document.getElementById('hb-budget')? document.getElementById('hb-budget').value : '';
    // Close current modal
    document.querySelectorAll('.hub-modal-backdrop').forEach(function (b) { b.remove(); });
    Hub.openReferralSend();
    setTimeout(function () {
      var kind = document.getElementById('hub-send-kind'); if (kind) kind.value = 'borrower';
      var nm = document.getElementById('hub-send-name'); if (nm) nm.value = name;
      var em = document.getElementById('hub-send-email'); if (em) em.value = email;
      var ph = document.getElementById('hub-send-phone'); if (ph) ph.value = phone;
      var zp = document.getElementById('hub-send-zip'); if (zp) zp.value = (area || '').match(/\d{5}/) ? (area.match(/\d{5}/)[0]) : '';
      var pr = document.getElementById('hub-send-price'); if (pr) pr.value = budget;
      var nt = document.getElementById('hub-send-note'); if (nt) nt.value = 'Active buyer — please pre-qualify. Target area: ' + (area || '—') + ' · Budget: $' + (Number(budget || 0).toLocaleString()) + '.';
    }, 80);
  };

  // ──────────── Helpers ────────────
  function modalBackdrop() {
    var b = document.createElement('div');
    b.className = 'hub-modal-backdrop open';
    b.addEventListener('click', function (e) { if (e.target === b) b.remove(); });
    return b;
  }

  function domDays(iso) {
    if (!iso) return '—';
    var diff = Date.now() - new Date(iso).getTime();
    if (isNaN(diff)) return '—';
    return Math.max(0, Math.floor(diff / 86400000)) + 'd';
  }

  function kpi(label, value, sub) {
    return ''
      + '<div class="hub-kpi">'
      +   '<div class="hub-kpi-label">' + label + '</div>'
      +   '<div class="hub-kpi-value">' + value + '</div>'
      +   '<div class="hub-kpi-delta">' + sub + '</div>'
      + '</div>';
  }

  function esc(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function unlocked(msg) { return '<div class="hub-empty"><div class="hub-empty-icon">ℹ️</div><p>' + esc(msg) + '</p></div>'; }
  function err$(e) { return '<div class="hub-empty"><div class="hub-empty-icon">⚠️</div><p>' + esc(e && e.message || String(e)) + '</p></div>'; }
  function toast(msg) { try { if (typeof global.showToast === 'function') return global.showToast(msg); } catch (e) {} console.info('[Hub] ' + msg); }

})(typeof window !== 'undefined' ? window : globalThis);

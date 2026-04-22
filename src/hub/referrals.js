// ======================================================================
// Loopenta Hub — Referrals (2026-04-22)
// Cross-org lead routing + partner invitations.
//   • Inbox of incoming leads (for Admin/Manager/Individual by scope)
//   • Send a lead to a partner org
//   • Partner network: current referralLinks + invite new partner by email
// ======================================================================
(function (global) {
  'use strict';

  var Hub = global.Hub = global.Hub || {};

  Hub.registerRoute && Hub.registerRoute('referrals', {
    label: 'Referrals',
    icon: '🤝',
    visible: function (caps) { return !!caps && !!caps.orgId; },
    render: async function (mount) {
      mount.innerHTML = skeleton();
      try {
        await refresh(mount);
      } catch (err) {
        mount.innerHTML = err$(err);
      }
    },
  });

  Hub.registerRoute && Hub.registerRoute('network', {
    label: 'Partner Network',
    icon: '🌐',
    visible: function (caps) { return !!caps && !!caps.orgId; },
    render: async function (mount) {
      mount.innerHTML = networkSkeleton();
      try {
        await renderNetwork(mount);
      } catch (err) {
        mount.innerHTML = err$(err);
      }
    },
  });

  // ── Skeletons ─────────────────────────────────────────────
  function skeleton() {
    return ''
      + '<div class="hub-section-h">'
      +   '<div><h2>Referrals</h2><div class="hub-section-sub">Leads sent to you and to your partners.</div></div>'
      +   '<button class="hub-btn hub-btn-primary" onclick="Hub.openReferralSend()">✉️ Send a referral</button>'
      + '</div>'
      + '<div class="hub-kpis" id="hub-ref-kpis"></div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:18px" id="hub-ref-cols">'
      +   '<div id="hub-ref-inbox"></div>'
      +   '<div id="hub-ref-outbox"></div>'
      + '</div>';
  }

  function networkSkeleton() {
    return ''
      + '<div class="hub-section-h">'
      +   '<div><h2>Partner Network</h2><div class="hub-section-sub">Organizations you can exchange leads with.</div></div>'
      +   '<button class="hub-btn hub-btn-primary" onclick="Hub.openInvitePartner()">➕ Invite a partner</button>'
      + '</div>'
      + '<div id="hub-network-body"></div>';
  }

  // ── Inbox/outbox rendering ─────────────────────────────────
  async function refresh(mount) {
    var db = global.db;
    var u = global.currentUser;
    if (!db || !u) { mount.querySelector('#hub-ref-inbox').innerHTML = unlocked('Sign in to see referrals.'); return; }
    var orgId = u.orgId || '';
    var [inbox, outbox] = await Promise.all([
      safeQuery(db, 'leads', 'toOrgId', '==', orgId),
      safeQuery(db, 'leads', 'fromOrgId', '==', orgId),
    ]);
    renderKpis(mount.querySelector('#hub-ref-kpis'), inbox, outbox);
    renderInbox(mount.querySelector('#hub-ref-inbox'), inbox);
    renderOutbox(mount.querySelector('#hub-ref-outbox'), outbox);
  }

  async function safeQuery(db, coll, field, op, val) {
    try {
      var snap = await db.collection(coll).where(field, op, val).get();
      return snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    } catch (e) { return []; }
  }

  function renderKpis(el, inbox, outbox) {
    if (!el) return;
    var incoming = inbox.length;
    var open = inbox.filter(function (l) { return l.status === 'sent' || l.status === 'accepted' || l.status === 'working'; }).length;
    var won = inbox.concat(outbox).filter(function (l) { return l.status === 'won'; }).length;
    var sent = outbox.length;
    el.innerHTML = ''
      + kpi('Incoming', incoming, 'leads received')
      + kpi('In progress', open, 'working now')
      + kpi('Closed won', won, 'across both sides')
      + kpi('Sent out', sent, 'to partners');
  }

  function renderInbox(el, inbox) {
    if (!el) return;
    var html = '<div class="hub-card"><div class="hub-card-header"><div class="hub-card-title">📥 Incoming</div></div>';
    if (!inbox.length) {
      html += '<div class="hub-empty"><div class="hub-empty-icon">📭</div><h4>No incoming leads yet</h4><p>When partners send your org a referral, it lands here.</p></div>';
    } else {
      html += '<div style="overflow-x:auto"><table class="hub-table"><thead><tr><th>Client</th><th>Kind</th><th>Assigned</th><th>Status</th><th>Received</th><th></th></tr></thead><tbody>';
      inbox.sort(byNewest).forEach(function (l) {
        html += leadRow(l, 'in');
      });
      html += '</tbody></table></div>';
    }
    html += '</div>';
    el.innerHTML = html;
  }

  function renderOutbox(el, outbox) {
    if (!el) return;
    var html = '<div class="hub-card"><div class="hub-card-header"><div class="hub-card-title">📤 Sent out</div></div>';
    if (!outbox.length) {
      html += '<div class="hub-empty"><div class="hub-empty-icon">🛫</div><h4>No referrals sent yet</h4><p>Hit <strong>Send a referral</strong> above to move a lead to a partner.</p></div>';
    } else {
      html += '<div style="overflow-x:auto"><table class="hub-table"><thead><tr><th>Client</th><th>Kind</th><th>To org</th><th>Status</th><th>Sent</th><th></th></tr></thead><tbody>';
      outbox.sort(byNewest).forEach(function (l) {
        html += leadRow(l, 'out');
      });
      html += '</tbody></table></div>';
    }
    html += '</div>';
    el.innerHTML = html;
  }

  function leadRow(l, direction) {
    var who = l.borrowerName || l.clientName || (l.propertyAddress || '—');
    var kind = l.kind || 'lead';
    var when = l.createdAt || l.lastActivity || '';
    var status = l.status || 'sent';
    return ''
      + '<tr>'
      +   '<td><strong>' + esc(who) + '</strong>'
      +     (l.borrowerEmail ? '<div style="font-size:11px;color:#94a3b8">' + esc(l.borrowerEmail) + '</div>' : '')
      +     (l.propertyAddress ? '<div style="font-size:11px;color:#94a3b8">' + esc(l.propertyAddress) + '</div>' : '')
      +   '</td>'
      +   '<td><span class="hub-orgtype-chip">' + kind + '</span></td>'
      +   '<td>' + (direction === 'in' ? (l.toUserId ? 'You' : '<em style="color:#64748b">Unassigned</em>') : esc(l.toOrgName || l.toOrgId || '')) + '</td>'
      +   '<td><span class="hub-status ' + esc(status) + '">' + esc(status) + '</span></td>'
      +   '<td style="color:#64748b">' + esc(fmtDate(when)) + '</td>'
      +   '<td>'
      +     '<button class="hub-btn hub-btn-secondary" style="padding:4px 10px;font-size:11px" onclick="Hub._openLead(\'' + esc(l.id) + '\')">Open</button>'
      +   '</td>'
      + '</tr>';
  }

  Hub._openLead = async function (id) {
    var db = global.db; if (!db) return;
    var doc = await db.collection('leads').doc(id).get();
    if (!doc.exists) return alert('Lead not found');
    var l = Object.assign({ id: doc.id }, doc.data());
    showLeadModal(l);
  };

  function showLeadModal(l) {
    var backdrop = modalBackdrop();
    var body = (''
      + '<div class="hub-modal-h"><h3>Referral · ' + esc(l.borrowerName || l.clientName || l.propertyAddress || 'Lead') + '</h3>'
      +   '<button class="hub-modal-close" onclick="this.closest(\'.hub-modal-backdrop\').remove()">×</button></div>'
      + '<div>'
      +   '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">'
      +     '<span class="hub-status ' + esc(l.status || 'sent') + '">' + esc(l.status || 'sent') + '</span>'
      +     '<span class="hub-orgtype-chip">' + esc(l.kind || 'lead') + '</span>'
      +     '<span class="hub-urgency-' + esc(l.urgency || 'normal') + '">Urgency: ' + esc(l.urgency || 'normal') + '</span>'
      +   '</div>'
      +   detailsTable(l)
      +   '<div style="margin-top:14px">'
      +     '<h4 style="font-size:13px;margin:12px 0 6px">Notes</h4>'
      +     '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;font-size:13px;color:#334155;white-space:pre-wrap">' + esc(l.note || 'No notes.') + '</div>'
      +   '</div>'
      +   '<div style="display:flex;gap:8px;margin-top:18px;flex-wrap:wrap">'
      +     statusButton(l, 'accepted', '✅ Accept')
      +     + statusButton(l, 'working',  '⚡ Mark working')
      +     + statusButton(l, 'won',      '🏆 Mark closed won')
      +     + statusButton(l, 'lost',     '📉 Mark lost')
      +     + statusButton(l, 'declined', '🙅 Decline')
      +   '</div>'
      + '</div>');
    var modal = document.createElement('div');
    modal.className = 'hub-modal'; modal.innerHTML = body;
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
  }

  function statusButton(l, target, label) {
    return '<button class="hub-btn hub-btn-secondary" onclick="Hub._updateLeadStatus(\'' + esc(l.id) + '\',\'' + target + '\')">' + label + '</button>';
  }

  Hub._updateLeadStatus = async function (id, status) {
    var db = global.db; if (!db) return;
    try {
      await db.collection('leads').doc(id).update({
        status: status,
        lastActivity: new Date().toISOString(),
      });
      document.querySelectorAll('.hub-modal-backdrop').forEach(function (b) { b.remove(); });
      if (Hub._routes && Hub._routes.referrals) Hub.go('referrals');
      toast('Status updated: ' + status);
    } catch (e) {
      alert('Could not update status: ' + (e.message || e));
    }
  };

  function detailsTable(l) {
    var rows = [
      ['Client',       l.borrowerName || l.clientName || ''],
      ['Email',        l.borrowerEmail || ''],
      ['Phone',        l.borrowerPhone || ''],
      ['Property',     [l.propertyAddress, l.propertyCity, l.propertyState, l.propertyZip].filter(Boolean).join(', ')],
      ['Est. price',   l.estPrice ? ('$' + Number(l.estPrice).toLocaleString()) : ''],
      ['From user',    l.fromUserName || l.fromUserId || ''],
      ['From org',     l.fromOrgName || l.fromOrgId || ''],
      ['To org',       l.toOrgName || l.toOrgId || ''],
      ['To user',      l.toUserName || l.toUserId || ''],
      ['Created',      fmtDate(l.createdAt)],
      ['Last update',  fmtDate(l.lastActivity)],
    ].filter(function (r) { return r[1]; });
    if (!rows.length) return '';
    return ''
      + '<table class="hub-table"><tbody>'
      +   rows.map(function (r) {
            return '<tr><th style="text-align:left;width:140px;background:#f8fafc;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:#64748b">' + esc(r[0]) + '</th><td>' + esc(r[1]) + '</td></tr>';
          }).join('')
      + '</tbody></table>';
  }

  // ── Send a new referral ────────────────────────────────────
  Hub.openReferralSend = async function (opts) {
    opts = opts || {};
    var backdrop = modalBackdrop();
    backdrop.innerHTML = ''
      + '<div class="hub-modal">'
      +   '<div class="hub-modal-h"><h3>Send a referral</h3>'
      +     '<button class="hub-modal-close" onclick="this.closest(\'.hub-modal-backdrop\').remove()">×</button></div>'
      +   '<div id="hub-send-form">'
      +     '<div class="hub-field"><label>Partner organization</label>'
      +       '<select id="hub-send-org"><option value="">Loading…</option></select></div>'
      +     '<div class="hub-field"><label>Kind</label>'
      +       '<select id="hub-send-kind">'
      +         '<option value="borrower">Borrower (mortgage)</option>'
      +         '<option value="buyer">Buyer (real estate)</option>'
      +         '<option value="seller">Seller (real estate)</option>'
      +         '<option value="refinance">Refinance</option>'
      +         '<option value="referral">General referral</option>'
      +       '</select></div>'
      +     '<div class="hub-field"><label>Client name</label><input id="hub-send-name" type="text" placeholder="Jane & John Homebuyer"/></div>'
      +     '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">'
      +       '<div class="hub-field"><label>Email</label><input id="hub-send-email" type="email" placeholder="client@example.com"/></div>'
      +       '<div class="hub-field"><label>Phone</label><input id="hub-send-phone" type="tel" placeholder="(555) 123-4567"/></div>'
      +     '</div>'
      +     '<div class="hub-field"><label>Property address (optional)</label><input id="hub-send-prop" type="text" placeholder="123 Main St"/></div>'
      +     '<div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:12px">'
      +       '<div class="hub-field"><label>City</label><input id="hub-send-city" type="text"/></div>'
      +       '<div class="hub-field"><label>State</label><input id="hub-send-state" type="text" maxlength="2"/></div>'
      +       '<div class="hub-field"><label>ZIP</label><input id="hub-send-zip" type="text" maxlength="5"/></div>'
      +       '<div class="hub-field"><label>Est. price</label><input id="hub-send-price" type="number" placeholder="500000"/></div>'
      +     '</div>'
      +     '<div class="hub-field"><label>Urgency</label>'
      +       '<select id="hub-send-urgency"><option value="normal">Normal</option><option value="high">High</option><option value="low">Low</option></select></div>'
      +     '<div class="hub-field"><label>Notes</label><textarea id="hub-send-note" rows="3" placeholder="What should the partner know?"></textarea></div>'
      +     '<div style="display:flex;gap:10px;justify-content:flex-end">'
      +       '<button class="hub-btn hub-btn-secondary" onclick="this.closest(\'.hub-modal-backdrop\').remove()">Cancel</button>'
      +       '<button class="hub-btn hub-btn-primary" id="hub-send-btn" onclick="Hub._submitReferral()">🚀 Send referral</button>'
      +     '</div>'
      +   '</div>'
      + '</div>';
    document.body.appendChild(backdrop);
    await populatePartnerSelect(backdrop.querySelector('#hub-send-org'), opts);
  };

  async function populatePartnerSelect(sel, opts) {
    if (!sel) return;
    var db = global.db; var u = global.currentUser;
    if (!db || !u) { sel.innerHTML = '<option>Not signed in</option>'; return; }
    // Partner orgs = any org that has an active referralLink with us,
    // plus (for flexibility) all orgs the superadmin can see.
    var my = u.orgId || '';
    var html = '';
    try {
      var [a, b, orgs] = await Promise.all([
        db.collection('referralLinks').where('orgA', '==', my).get().catch(function () { return { docs: [] }; }),
        db.collection('referralLinks').where('orgB', '==', my).get().catch(function () { return { docs: [] }; }),
        db.collection('organizations').get().catch(function () { return { docs: [] }; }),
      ]);
      var orgMap = {};
      orgs.docs.forEach(function (d) { orgMap[d.id] = Object.assign({ id: d.id }, d.data()); });
      var partnerIds = {};
      a.docs.forEach(function (d) {
        var r = d.data(); if (r.status === 'active') partnerIds[r.orgB] = true;
      });
      b.docs.forEach(function (d) {
        var r = d.data(); if (r.status === 'active') partnerIds[r.orgA] = true;
      });
      var ids = Object.keys(partnerIds);
      if (!ids.length) {
        // Fallback: show all orgs except own, let them send anyway.
        ids = Object.keys(orgMap).filter(function (i) { return i !== my; });
      }
      html = '<option value="">— pick a partner —</option>';
      ids.forEach(function (id) {
        var o = orgMap[id] || { name: id };
        var type = Hub.orgTypeOf(o);
        html += '<option value="' + esc(id) + '" data-name="' + esc(o.name || id) + '" data-type="' + esc(type) + '">' + esc(o.name || id) + ' · ' + Hub.orgTypeLabel(type) + '</option>';
      });
    } catch (e) {
      html = '<option value="">Could not load partners</option>';
    }
    sel.innerHTML = html;
  }

  Hub._submitReferral = async function () {
    var u = global.currentUser;
    var db = global.db;
    if (!u || !db) return alert('Not signed in');
    var sel = document.getElementById('hub-send-org');
    var toOrgId = sel.value;
    if (!toOrgId) return alert('Pick a partner org');
    var opt = sel.options[sel.selectedIndex];
    var doc = {
      fromOrgId:       u.orgId || '',
      fromOrgName:     (global.currentOrg && global.currentOrg.name) || '',
      fromUserId:      u.id,
      fromUserName:    u.name || u.email || '',
      toOrgId:         toOrgId,
      toOrgName:       opt ? (opt.dataset.name || '') : '',
      toUserId:        '',
      kind:            document.getElementById('hub-send-kind').value,
      borrowerName:    document.getElementById('hub-send-name').value,
      borrowerEmail:   document.getElementById('hub-send-email').value,
      borrowerPhone:   document.getElementById('hub-send-phone').value,
      propertyAddress: document.getElementById('hub-send-prop').value,
      propertyCity:    document.getElementById('hub-send-city').value,
      propertyState:   document.getElementById('hub-send-state').value.toUpperCase(),
      propertyZip:     document.getElementById('hub-send-zip').value,
      estPrice:        Number(document.getElementById('hub-send-price').value) || 0,
      urgency:         document.getElementById('hub-send-urgency').value,
      note:            document.getElementById('hub-send-note').value,
      status:          'sent',
      createdAt:       new Date().toISOString(),
      lastActivity:    new Date().toISOString(),
      timeline: [{
        at: new Date().toISOString(),
        by: u.id, byName: u.name || u.email || '',
        event: 'sent', note: 'Referral initiated',
      }],
    };
    try {
      var btn = document.getElementById('hub-send-btn');
      if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
      await db.collection('leads').add(doc);
      document.querySelectorAll('.hub-modal-backdrop').forEach(function (b) { b.remove(); });
      toast('Referral sent');
      Hub.go('referrals');
    } catch (e) {
      alert('Could not send: ' + (e.message || e));
    }
  };

  // ── Invite a partner org ───────────────────────────────────
  Hub.openInvitePartner = function () {
    var backdrop = modalBackdrop();
    backdrop.innerHTML = ''
      + '<div class="hub-modal">'
      +   '<div class="hub-modal-h"><h3>Invite a partner organization</h3>'
      +     '<button class="hub-modal-close" onclick="this.closest(\'.hub-modal-backdrop\').remove()">×</button></div>'
      +   '<div>'
      +     '<p style="color:#334155;font-size:13px">We\'ll email an admin at this company a link to connect their Loopenta account to yours. Once they accept, you can send each other leads directly.</p>'
      +     '<div class="hub-field"><label>Admin name</label><input id="hub-inv-name" type="text"/></div>'
      +     '<div class="hub-field"><label>Admin email</label><input id="hub-inv-email" type="email"/></div>'
      +     '<div class="hub-field"><label>Their organization type</label>'
      +       '<select id="hub-inv-orgtype">'
      +         '<option value="mortgage">Mortgage</option>'
      +         '<option value="realEstate">Real Estate</option>'
      +         '<option value="referralPartner">Referral Partner</option>'
      +         '<option value="title">Title</option>'
      +         '<option value="escrow">Escrow</option>'
      +       '</select></div>'
      +     '<div class="hub-field"><label>Personal note</label><textarea id="hub-inv-note" rows="3" placeholder="Hi Sam, I\'d love to connect our teams on Loopenta so we can send each other pre-qualified clients."></textarea></div>'
      +     '<div style="display:flex;gap:10px;justify-content:flex-end">'
      +       '<button class="hub-btn hub-btn-secondary" onclick="this.closest(\'.hub-modal-backdrop\').remove()">Cancel</button>'
      +       '<button class="hub-btn hub-btn-primary" onclick="Hub._submitPartnerInvite()">✉️ Send invite</button>'
      +     '</div>'
      +   '</div>'
      + '</div>';
    document.body.appendChild(backdrop);
  };

  Hub._submitPartnerInvite = async function () {
    var db = global.db; var u = global.currentUser;
    if (!db || !u) return alert('Not signed in');
    var name = document.getElementById('hub-inv-name').value.trim();
    var email = document.getElementById('hub-inv-email').value.trim().toLowerCase();
    var orgType = document.getElementById('hub-inv-orgtype').value;
    var note = document.getElementById('hub-inv-note').value;
    if (!name || !email) return alert('Name and email required');
    try {
      await db.collection('referralLinks').add({
        orgA: u.orgId || '',
        orgAName: (global.currentOrg && global.currentOrg.name) || '',
        orgB: '',
        orgBName: '',
        pendingInvite: { name: name, email: email, orgType: orgType, note: note },
        status: 'pending',
        initiatedBy: u.id,
        initiatedByName: u.name || u.email || '',
        initiatedAt: new Date().toISOString(),
      });
      document.querySelectorAll('.hub-modal-backdrop').forEach(function (b) { b.remove(); });
      toast('Partner invite drafted — email will go out');
      Hub.go('network');
    } catch (e) {
      alert('Could not invite: ' + (e.message || e));
    }
  };

  async function renderNetwork(mount) {
    var db = global.db; var u = global.currentUser;
    var body = mount.querySelector('#hub-network-body');
    if (!db || !u) { body.innerHTML = unlocked('Sign in to manage the partner network.'); return; }
    var my = u.orgId || '';
    var [a, b, orgs] = await Promise.all([
      db.collection('referralLinks').where('orgA', '==', my).get().catch(function () { return { docs: [] }; }),
      db.collection('referralLinks').where('orgB', '==', my).get().catch(function () { return { docs: [] }; }),
      db.collection('organizations').get().catch(function () { return { docs: [] }; }),
    ]);
    var orgMap = {};
    orgs.docs.forEach(function (d) { orgMap[d.id] = Object.assign({ id: d.id }, d.data()); });
    var links = a.docs.concat(b.docs).map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    if (!links.length) {
      body.innerHTML = ''
        + '<div class="hub-empty">'
        +   '<div class="hub-empty-icon">🌱</div>'
        +   '<h4>No partners yet</h4>'
        +   '<p>Invite a mortgage office, brokerage, CPA, or title/escrow partner to start exchanging leads.</p>'
        +   '<button class="hub-btn hub-btn-primary" style="margin-top:14px" onclick="Hub.openInvitePartner()">➕ Invite a partner</button>'
        + '</div>';
      return;
    }
    var rows = links.map(function (link) {
      var otherId = (link.orgA === my) ? link.orgB : link.orgA;
      var otherOrg = orgMap[otherId] || { name: link.pendingInvite && link.pendingInvite.email || 'Pending…' };
      var type = Hub.orgTypeOf(otherOrg);
      return ''
        + '<tr>'
        +   '<td><strong>' + esc(otherOrg.name || '(pending)') + '</strong></td>'
        +   '<td>' + Hub.orgTypeBadgeHTML(type) + '</td>'
        +   '<td><span class="hub-status ' + esc(link.status || 'pending') + '">' + esc(link.status || 'pending') + '</span></td>'
        +   '<td style="color:#64748b">' + esc(fmtDate(link.initiatedAt)) + '</td>'
        +   '<td>'
        +     (link.status === 'pending' && link.orgB === my
               ? '<button class="hub-btn hub-btn-primary" style="padding:4px 10px;font-size:11px" onclick="Hub._acceptLink(\'' + esc(link.id) + '\')">Accept</button>'
               : '<button class="hub-btn hub-btn-secondary" style="padding:4px 10px;font-size:11px" onclick="Hub.openReferralSend()">Send lead</button>')
        +   '</td>'
        + '</tr>';
    }).join('');
    body.innerHTML = ''
      + '<div class="hub-card"><div style="overflow-x:auto"><table class="hub-table">'
      +   '<thead><tr><th>Organization</th><th>Type</th><th>Status</th><th>Since</th><th></th></tr></thead>'
      +   '<tbody>' + rows + '</tbody>'
      + '</table></div></div>';
  }

  Hub._acceptLink = async function (linkId) {
    var db = global.db; var u = global.currentUser;
    if (!db || !u) return;
    try {
      await db.collection('referralLinks').doc(linkId).update({
        status: 'active', acceptedBy: u.id, acceptedAt: new Date().toISOString(),
      });
      toast('Partner accepted');
      Hub.go('network');
    } catch (e) {
      alert('Could not accept: ' + (e.message || e));
    }
  };

  // ── Helpers ─────────────────────────────────────────────────
  function modalBackdrop() {
    var b = document.createElement('div');
    b.className = 'hub-modal-backdrop open';
    b.addEventListener('click', function (e) {
      if (e.target === b) b.remove();
    });
    return b;
  }

  function kpi(label, value, sub) {
    return ''
      + '<div class="hub-kpi">'
      +   '<div class="hub-kpi-label">' + label + '</div>'
      +   '<div class="hub-kpi-value">' + value + '</div>'
      +   '<div class="hub-kpi-delta">' + sub + '</div>'
      + '</div>';
  }

  function byNewest(a, b) {
    return new Date(b.createdAt || b.lastActivity || 0) - new Date(a.createdAt || a.lastActivity || 0);
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function unlocked(msg) { return '<div class="hub-empty"><div class="hub-empty-icon">ℹ️</div><p>' + esc(msg) + '</p></div>'; }
  function err$(e) { return '<div class="hub-empty"><div class="hub-empty-icon">⚠️</div><p>' + esc(e && e.message || String(e)) + '</p></div>'; }

  function esc(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function toast(msg) {
    try { if (typeof global.showToast === 'function') return global.showToast(msg); } catch (e) {}
    console.info('[Hub] ' + msg);
  }

})(typeof window !== 'undefined' ? window : globalThis);

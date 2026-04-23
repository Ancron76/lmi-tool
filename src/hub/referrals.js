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
    var all = inbox.concat(outbox).map(Hub.lifecycle.normalize);
    var active = all.filter(function (l) { return l.status === 'in_process' || l.status === 'accepted'; }).length;
    var closedWon = all.filter(function (l) { return l.status === 'closed_won'; }).length;
    var pending = all.filter(function (l) { return l.status === 'pending'; }).length;
    // Close rate = closed_won / (closed_won + closed_lost)
    var won = closedWon;
    var lost = all.filter(function (l) { return l.status === 'closed_lost'; }).length;
    var closeRate = (won + lost) ? Math.round(won / (won + lost) * 100) + '%' : '—';
    el.innerHTML = ''
      + kpi('Pending',      pending,   'awaiting accept')
      + kpi('In pipeline',  active,    'active deals')
      + kpi('Closed won',   closedWon, 'all-time')
      + kpi('Close rate',   closeRate, 'won vs. lost');
  }

  function renderInbox(el, inbox) {
    if (!el) return;
    var html = '<div class="hub-card"><div class="hub-card-header"><div class="hub-card-title">Incoming</div></div>';
    if (!inbox.length) {
      html += '<div class="hub-empty"><h4>No incoming leads yet</h4><p>When partners send your org a referral, it lands here.</p></div>';
    } else {
      html += '<div style="overflow-x:auto"><table class="hub-table"><thead><tr><th></th><th>Client</th><th>Stage</th><th>Status</th><th>Received</th><th></th></tr></thead><tbody>';
      inbox.map(Hub.lifecycle.normalize).sort(byNewest).forEach(function (l) {
        html += leadRow(l, 'in');
      });
      html += '</tbody></table></div>';
    }
    html += '</div>';
    el.innerHTML = html;
  }

  function renderOutbox(el, outbox) {
    if (!el) return;
    var html = '<div class="hub-card"><div class="hub-card-header"><div class="hub-card-title">Sent out</div></div>';
    if (!outbox.length) {
      html += '<div class="hub-empty"><h4>No referrals sent yet</h4><p>Hit <strong>Send a referral</strong> above to move a lead to a partner.</p></div>';
    } else {
      html += '<div style="overflow-x:auto"><table class="hub-table"><thead><tr><th></th><th>Client</th><th>Stage</th><th>To org</th><th>Status</th><th>Sent</th><th></th></tr></thead><tbody>';
      outbox.map(Hub.lifecycle.normalize).sort(byNewest).forEach(function (l) {
        html += leadRow(l, 'out');
      });
      html += '</tbody></table></div>';
    }
    html += '</div>';
    el.innerHTML = html;
  }

  function leadRow(l, direction) {
    var L = Hub.lifecycle;
    var u = global.currentUser || {};
    var who = l.borrowerName || l.clientName || (l.propertyAddress || '—');
    var when = l.lastActivity || l.createdAt || '';
    var status = l.status || 'pending';
    var stageLabel = l.stage ? L.stageLabel(l.stage) : (L.isTerminal(status) ? '—' : L.statusLabel(status));
    var unread = L.isUnreadFor(l, u.id);
    var rowStyle = unread ? ' class="hub-row-unread"' : '';
    return ''
      + '<tr' + rowStyle + ' onclick="Hub._openLead(\'' + esc(l.id) + '\')" style="cursor:pointer">'
      +   '<td style="width:14px;padding-right:0">' + (unread ? '<span class="hub-unread-dot" aria-label="Unread"></span>' : '') + '</td>'
      +   '<td><strong>' + esc(who) + '</strong>'
      +     (l.borrowerEmail ? '<div style="font-size:11px;color:var(--hub-muted)">' + esc(l.borrowerEmail) + '</div>' : '')
      +     '<div style="font-size:11px;color:var(--hub-muted);margin-top:1px">'
      +       esc(l.kind || 'lead')
      +       (direction === 'in' ? ' · from ' + esc(l.fromOrgName || '') : '')
      +     '</div>'
      +   '</td>'
      +   '<td><span class="hub-pill hub-pill-stage">' + esc(stageLabel) + '</span></td>'
      +   (direction === 'out' ? '<td>' + esc(l.toOrgName || l.toOrgId || '') + '</td>' : '')
      +   '<td><span class="hub-pill hub-status-' + esc(status) + '">' + esc(L.statusLabel(status)) + '</span></td>'
      +   '<td style="color:var(--hub-muted);font-size:11px">' + esc(fmtDate(when)) + '</td>'
      +   '<td style="text-align:right">'
      +     '<span class="hub-row-chevron" aria-hidden="true">›</span>'
      +   '</td>'
      + '</tr>';
  }

  // ── Referral Detail view ───────────────────────────────────
  // Opens a modal with:
  //   • Status chip + kind-specific stage stepper
  //   • Client/property details
  //   • Activity feed (status changes, stage moves, notes — attributed)
  //   • Note composer (either side can add)
  //   • Primary action buttons that change based on current status
  Hub._openLead = async function (id) {
    var db = global.db; if (!db) return;
    var snap = await db.collection('leads').doc(id).get();
    if (!snap.exists) return alert('Lead not found');
    var lead = Hub.lifecycle.normalize(Object.assign({ id: snap.id }, snap.data()));
    // Mark as viewed / read for the current user (best effort).
    try {
      var u = global.currentUser;
      if (u) {
        var patch = {};
        patch['lastReadBy.' + u.id] = new Date().toISOString();
        if (!lead.viewedAt && lead.toOrgId === (u.orgId || '')) {
          patch.viewedAt = new Date().toISOString();
          patch.viewedBy = u.id;
          var viewedEvt = Hub.lifecycle.makeEvent(u, global.currentOrg, { event: 'viewed' });
          patch.timeline = (lead.timeline || []).concat([viewedEvt]);
          lead.timeline = patch.timeline;
          lead.viewedAt = patch.viewedAt;
        }
        await db.collection('leads').doc(id).update(patch);
      }
    } catch (e) { /* non-critical */ }
    showLeadModal(lead);
  };

  function showLeadModal(l) {
    var backdrop = modalBackdrop();
    var modal = document.createElement('div');
    modal.className = 'hub-modal';
    modal.style.width = 'min(780px, 96vw)';
    modal.innerHTML = leadModalHTML(l);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    wireLeadModal(backdrop, l);
  }

  function leadModalHTML(l) {
    var L = Hub.lifecycle;
    var who = l.borrowerName || l.clientName || l.propertyAddress || 'Lead';
    var statusCls = 'hub-status-' + esc(l.status || 'pending');
    return ''
      + '<div class="hub-modal-h">'
      +   '<div>'
      +     '<h3 style="margin:0">' + esc(who) + '</h3>'
      +     '<div style="font-size:11px;color:var(--hub-muted);margin-top:2px;letter-spacing:0.04em;text-transform:uppercase">'
      +       esc(l.fromOrgName || '') + ' → ' + esc(l.toOrgName || '') + ' · ' + esc(l.kind || 'lead')
      +     '</div>'
      +   '</div>'
      +   '<button class="hub-modal-close" onclick="this.closest(\'.hub-modal-backdrop\').remove()">×</button>'
      + '</div>'
      + '<div>'
      +   '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:14px">'
      +     '<span class="hub-pill ' + statusCls + '">' + esc(L.statusLabel(l.status)) + '</span>'
      +     '<span class="hub-pill hub-pill-muted">' + esc(l.kind || 'lead') + '</span>'
      +     (l.urgency && l.urgency !== 'normal'
         ? '<span class="hub-pill hub-pill-urgency-' + esc(l.urgency) + '">' + esc(l.urgency) + ' urgency</span>' : '')
      +     (l.stage && !L.isTerminal(l.status)
         ? '<span class="hub-pill hub-pill-stage">Stage · ' + esc(L.stageLabel(l.stage)) + '</span>' : '')
      +   '</div>'
      +   stepperHTML(l)
      +   '<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:18px" class="hub-lead-grid">'
      +     '<div>' + detailsTable(l) + '</div>'
      +     '<div>'
      +       '<h4 style="font-size:12px;margin:0 0 8px;color:var(--hub-muted);letter-spacing:0.04em;text-transform:uppercase">Activity</h4>'
      +       activityFeedHTML(l)
      +       noteComposerHTML(l)
      +     '</div>'
      +   '</div>'
      +   actionsHTML(l)
      + '</div>';
  }

  function stepperHTML(l) {
    var L = Hub.lifecycle;
    if (L.isTerminal(l.status) || l.status === 'pending' || l.status === 'declined') {
      // No interactive stepper for pending/declined/terminal — show a static
      // summary if we have a stage record.
      return '';
    }
    var stages = L.stagesFor(l.kind);
    var curIdx = stages.indexOf(l.stage);
    if (curIdx === -1) curIdx = 0;
    var html = '<div class="hub-stepper" role="list">';
    stages.forEach(function (st, i) {
      var state = i < curIdx ? 'done' : i === curIdx ? 'current' : 'todo';
      html += ''
        + '<button class="hub-step hub-step-' + state + '" role="listitem"'
        +   ' data-stage="' + esc(st) + '"'
        +   ' title="' + esc(L.stageLabel(st)) + '">'
        +   '<span class="hub-step-dot">' + (i + 1) + '</span>'
        +   '<span class="hub-step-label">' + esc(L.stageLabel(st)) + '</span>'
        + '</button>';
    });
    html += '</div>';
    return html;
  }

  function activityFeedHTML(l) {
    var events = (l.timeline || []).slice().sort(function (a, b) {
      return (b.at || '').localeCompare(a.at || '');
    });
    if (!events.length) {
      return '<div class="hub-empty" style="padding:12px 10px;font-size:12px">No activity yet.</div>';
    }
    var L = Hub.lifecycle;
    return '<ol class="hub-activity-feed">' + events.map(function (e) {
      var title = L.EVENT_LABELS[e.event] || e.event || 'Update';
      var sub = '';
      if (e.event === 'stage_advanced' || e.event === 'stage_reverted') {
        sub = L.stageLabel(e.fromStage) + ' → ' + L.stageLabel(e.toStage);
      } else if (e.reason) { sub = 'Reason: ' + e.reason; }
      return ''
        + '<li class="hub-activity-item">'
        +   '<div class="hub-activity-head">'
        +     '<span class="hub-activity-title">' + esc(title) + '</span>'
        +     '<span class="hub-activity-when">' + esc(fmtDate(e.at)) + '</span>'
        +   '</div>'
        +   '<div class="hub-activity-meta">'
        +     esc(e.byName || 'Someone') + (e.byOrgName ? ' · ' + esc(e.byOrgName) : '')
        +   '</div>'
        +   (sub ? '<div class="hub-activity-sub">' + esc(sub) + '</div>' : '')
        +   (e.note ? '<div class="hub-activity-note">' + esc(e.note) + '</div>' : '')
        + '</li>';
    }).join('') + '</ol>';
  }

  function noteComposerHTML(l) {
    return ''
      + '<div class="hub-note-composer" style="margin-top:10px">'
      +   '<textarea id="hub-lead-note" rows="2" placeholder="Add a note — visible to both organizations" style="width:100%"></textarea>'
      +   '<div style="display:flex;justify-content:flex-end;margin-top:6px">'
      +     '<button class="hub-btn hub-btn-secondary" data-action="add-note" style="padding:5px 12px;font-size:12px">Add note</button>'
      +   '</div>'
      + '</div>';
  }

  function actionsHTML(l) {
    var L = Hub.lifecycle;
    var buttons = [];
    var u = global.currentUser || {};
    var myOrg = u.orgId || '';
    var isReceiver = l.toOrgId === myOrg;
    var isSender   = l.fromOrgId === myOrg;

    if (l.status === 'pending') {
      if (isReceiver) {
        buttons.push(btn('accept',  'Accept referral',  'primary'));
        buttons.push(btn('decline', 'Decline',          'ghost'));
      } else if (isSender) {
        buttons.push('<span style="color:var(--hub-muted);font-size:12px">Waiting for ' + esc(l.toOrgName || 'receiver') + ' to accept.</span>');
      }
    } else if (l.status === 'accepted' || l.status === 'in_process') {
      var next = L.nextStage(l.kind, l.stage || L.firstStage(l.kind));
      var prev = L.prevStage(l.kind, l.stage || L.firstStage(l.kind));
      if (next) buttons.push(btn('advance-' + next, 'Advance to ' + L.stageLabel(next), 'primary'));
      if (prev) buttons.push(btn('revert-' + prev, '← ' + L.stageLabel(prev), 'ghost'));
      buttons.push(btn('close-won',  'Mark closed · won',  'secondary'));
      buttons.push(btn('close-lost', 'Mark closed · lost', 'ghost'));
    } else if (L.isTerminal(l.status)) {
      buttons.push('<span style="color:var(--hub-muted);font-size:12px">' + esc(L.statusLabel(l.status)) + ' on ' + esc(fmtDate(l.closedAt || l.lastActivity)) + '</span>');
    }

    return '<div class="hub-lead-actions" style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;margin-top:20px;border-top:1px solid var(--hub-line);padding-top:16px">'
         + buttons.join('') + '</div>';

    function btn(action, label, kind) {
      var cls = 'hub-btn hub-btn-' + (kind === 'primary' ? 'primary' : kind === 'ghost' ? 'ghost' : 'secondary');
      return '<button class="' + cls + '" data-action="' + esc(action) + '">' + esc(label) + '</button>';
    }
  }

  // Wire up all in-modal interactions.
  function wireLeadModal(backdrop, lead) {
    // Stepper click = jump to a specific stage (adjacent only, to avoid wild jumps).
    backdrop.querySelectorAll('.hub-step').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var target = btn.dataset.stage;
        Hub._advanceToStage(lead.id, target);
      });
    });
    // Action buttons.
    backdrop.querySelectorAll('.hub-lead-actions [data-action]').forEach(function (btn) {
      btn.addEventListener('click', function () { handleLeadAction(lead, btn.dataset.action); });
    });
    // Note composer.
    var noteBtn = backdrop.querySelector('[data-action="add-note"]');
    if (noteBtn) noteBtn.addEventListener('click', function () { Hub._addLeadNote(lead.id); });
  }

  function handleLeadAction(lead, action) {
    if (action === 'accept')       return Hub._acceptLead(lead.id);
    if (action === 'decline')      return Hub._declineLead(lead.id);
    if (action === 'close-won')    return Hub._closeLead(lead.id, 'won');
    if (action === 'close-lost')   return Hub._closeLead(lead.id, 'lost');
    if (/^advance-/.test(action))  return Hub._advanceToStage(lead.id, action.replace(/^advance-/, ''));
    if (/^revert-/.test(action))   return Hub._advanceToStage(lead.id, action.replace(/^revert-/, ''));
  }

  // ── Lifecycle mutations ────────────────────────────────────
  Hub._acceptLead = async function (id) {
    var db = global.db; var u = global.currentUser; if (!db || !u) return;
    var doc = await db.collection('leads').doc(id).get();
    if (!doc.exists) return;
    var l = Hub.lifecycle.normalize(Object.assign({ id: doc.id }, doc.data()));
    var firstStage = Hub.lifecycle.firstStage(l.kind);
    var evt = Hub.lifecycle.makeEvent(u, global.currentOrg, { event: 'accepted', to: firstStage });
    await db.collection('leads').doc(id).update({
      status: 'accepted',
      stage: firstStage,
      stageUpdatedAt: evt.at,
      stageUpdatedBy: u.id,
      stageUpdatedByName: evt.byName,
      lastActivity: evt.at,
      timeline: (l.timeline || []).concat([evt]),
    });
    await _fanoutNotifications(l, 'accepted', evt);
    closeAllModals(); toast('Referral accepted'); Hub.go('referrals');
  };

  Hub._declineLead = async function (id) {
    var db = global.db; var u = global.currentUser; if (!db || !u) return;
    var reason = window.prompt('Reason for declining (optional):') || '';
    var doc = await db.collection('leads').doc(id).get();
    if (!doc.exists) return;
    var l = Hub.lifecycle.normalize(Object.assign({ id: doc.id }, doc.data()));
    var evt = Hub.lifecycle.makeEvent(u, global.currentOrg, { event: 'declined', reason: reason });
    await db.collection('leads').doc(id).update({
      status: 'declined',
      lastActivity: evt.at,
      closedAt: evt.at,
      timeline: (l.timeline || []).concat([evt]),
    });
    await _fanoutNotifications(l, 'declined', evt);
    closeAllModals(); toast('Referral declined'); Hub.go('referrals');
  };

  Hub._advanceToStage = async function (id, toStage) {
    var db = global.db; var u = global.currentUser; if (!db || !u) return;
    var doc = await db.collection('leads').doc(id).get();
    if (!doc.exists) return;
    var l = Hub.lifecycle.normalize(Object.assign({ id: doc.id }, doc.data()));
    var stages = Hub.lifecycle.stagesFor(l.kind);
    if (stages.indexOf(toStage) === -1) return alert('Unknown stage');
    var fromStage = l.stage || Hub.lifecycle.firstStage(l.kind);
    if (fromStage === toStage) return;
    var moving = stages.indexOf(toStage) > stages.indexOf(fromStage) ? 'stage_advanced' : 'stage_reverted';
    var evt = Hub.lifecycle.makeEvent(u, global.currentOrg, { event: moving, from: fromStage, to: toStage });
    await db.collection('leads').doc(id).update({
      status: 'in_process',
      stage: toStage,
      stageUpdatedAt: evt.at,
      stageUpdatedBy: u.id,
      stageUpdatedByName: evt.byName,
      lastActivity: evt.at,
      timeline: (l.timeline || []).concat([evt]),
    });
    await _fanoutNotifications(l, moving, evt);
    closeAllModals(); toast(Hub.lifecycle.stageLabel(toStage)); Hub.go('referrals');
  };

  Hub._closeLead = async function (id, outcome) {
    var db = global.db; var u = global.currentUser; if (!db || !u) return;
    var reason = outcome === 'lost' ? (window.prompt('What happened? (optional)') || '') : '';
    var doc = await db.collection('leads').doc(id).get();
    if (!doc.exists) return;
    var l = Hub.lifecycle.normalize(Object.assign({ id: doc.id }, doc.data()));
    var newStatus = outcome === 'won' ? 'closed_won' : 'closed_lost';
    var evt = Hub.lifecycle.makeEvent(u, global.currentOrg, { event: newStatus, reason: reason });
    await db.collection('leads').doc(id).update({
      status: newStatus,
      closedAt: evt.at,
      lastActivity: evt.at,
      timeline: (l.timeline || []).concat([evt]),
    });
    await _fanoutNotifications(l, newStatus, evt);
    closeAllModals(); toast(outcome === 'won' ? 'Closed · won' : 'Closed · lost'); Hub.go('referrals');
  };

  Hub._addLeadNote = async function (id) {
    var db = global.db; var u = global.currentUser; if (!db || !u) return;
    var ta = document.getElementById('hub-lead-note');
    if (!ta) return;
    var note = (ta.value || '').trim();
    if (!note) return;
    var doc = await db.collection('leads').doc(id).get();
    if (!doc.exists) return;
    var l = Hub.lifecycle.normalize(Object.assign({ id: doc.id }, doc.data()));
    var evt = Hub.lifecycle.makeEvent(u, global.currentOrg, { event: 'note', note: note });
    await db.collection('leads').doc(id).update({
      lastActivity: evt.at,
      timeline: (l.timeline || []).concat([evt]),
    });
    await _fanoutNotifications(l, 'note', evt);
    // Re-render the modal so they see their own note immediately.
    ta.value = '';
    closeAllModals();
    await Hub._openLead(id);
  };

  // ── Notification fan-out (stub — fully wired up in notifications.js) ─
  async function _fanoutNotifications(lead, event, evt) {
    try {
      if (Hub.notifications && typeof Hub.notifications.dispatch === 'function') {
        await Hub.notifications.dispatch(lead, event, evt);
      }
    } catch (e) { console.warn('[Hub] notification fanout failed', e); }
  }

  function closeAllModals() {
    document.querySelectorAll('.hub-modal-backdrop').forEach(function (b) { b.remove(); });
  }

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
      +       '<button class="hub-btn hub-btn-primary" id="hub-send-btn" onclick="Hub._submitReferral()">Send referral</button>'
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
    try {
      var my = u.orgId || '';
      var [a, b, orgs] = await Promise.all([
        db.collection('referralLinks').where('orgA', '==', my).where('status', '==', 'active').get().catch(function () { return { docs: [] }; }),
        db.collection('referralLinks').where('orgB', '==', my).where('status', '==', 'active').get().catch(function () { return { docs: [] }; }),
        db.collection('organizations').get().catch(function () { return { docs: [] }; }),
      ]);
      var orgMap = {};
      orgs.docs.forEach(function (d) { orgMap[d.id] = Object.assign({ id: d.id }, d.data()); });
      var partnerIds = {};
      a.docs.concat(b.docs).forEach(function (d) {
        var link = d.data();
        var other = (link.orgA === my) ? link.orgB : link.orgA;
        if (other) partnerIds[other] = true;
      });
      var partners = Object.keys(partnerIds)
        .map(function (id) { return orgMap[id]; })
        .filter(Boolean)
        .sort(function (x, y) { return (x.name || '').localeCompare(y.name || ''); });
      if (!partners.length) {
        sel.innerHTML = '<option value="">No active partners — invite one first</option>';
        return;
      }
      var preferred = opts && opts.toOrgId;
      sel.innerHTML = '<option value="">Pick a partner…</option>' + partners.map(function (p) {
        var selAttr = (p.id === preferred) ? ' selected' : '';
        return '<option value="' + esc(p.id) + '" data-name="' + esc(p.name || '') + '"' + selAttr + '>' + esc(p.name || p.id) + '</option>';
      }).join('');
    } catch (e) {
      sel.innerHTML = '<option value="">Could not load partners</option>';
    }
  }

  Hub._submitReferral = async function () {
    var u = global.currentUser;
    var db = global.db;
    if (!u || !db) return alert('Not signed in');
    var sel = document.getElementById('hub-send-org');
    var toOrgId = sel.value;
    if (!toOrgId) return alert('Pick a partner org');
    var opt = sel.options[sel.selectedIndex];
    var now = new Date().toISOString();
    var kindEl = document.getElementById('hub-send-kind');
    var firstEvt = Hub.lifecycle.makeEvent(u, global.currentOrg, { event: 'sent', note: 'Referral initiated' });
    var doc = {
      fromOrgId:       u.orgId || '',
      fromOrgName:     (global.currentOrg && global.currentOrg.name) || '',
      fromUserId:      u.id,
      fromUserName:    u.name || u.email || '',
      toOrgId:         toOrgId,
      toOrgName:       opt ? (opt.dataset.name || '') : '',
      toUserId:        '',
      kind:            kindEl ? kindEl.value : 'referral',
      borrowerName:    (document.getElementById('hub-send-name')  || {}).value || '',
      borrowerEmail:   (document.getElementById('hub-send-email') || {}).value || '',
      borrowerPhone:   (document.getElementById('hub-send-phone') || {}).value || '',
      propertyAddress: (document.getElementById('hub-send-prop')  || {}).value || '',
      propertyCity:    (document.getElementById('hub-send-city')  || {}).value || '',
      propertyState:  ((document.getElementById('hub-send-state') || {}).value || '').toUpperCase(),
      propertyZip:     (document.getElementById('hub-send-zip')   || {}).value || '',
      estPrice:        Number((document.getElementById('hub-send-price') || {}).value) || 0,
      urgency:         (document.getElementById('hub-send-urgency') || {}).value || 'normal',
      note:            (document.getElementById('hub-send-note')    || {}).value || '',
      status:          'pending',
      stage:           '',
      viewedAt:        '',
      lastReadBy:      {},
      createdAt:       now,
      lastActivity:    now,
      timeline:        [ firstEvt ],
    };
    try {
      var btn = document.getElementById('hub-send-btn');
      if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
      var ref = await db.collection('leads').add(doc);
      document.querySelectorAll('.hub-modal-backdrop').forEach(function (b) { b.remove(); });
      toast('Referral sent');
      try { await _fanoutNotifications(Object.assign({ id: ref.id }, doc), 'sent', firstEvt); } catch (e) {}
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
      +     '<button class="hub-modal-close" onclick="this.closest(\'.hub-modal-backdrop\').remove()">&times;</button></div>'
      +   '<div>'
      +     '<p style="color:var(--hub-ink-soft);font-size:13px">We\'ll email an admin at this company a link to connect their Loopenta account to yours. Once they accept, you can send each other leads directly.</p>'
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
      +       '<button class="hub-btn hub-btn-primary" onclick="Hub._submitPartnerInvite()">Send invite</button>'
      +     '</div>'
      +   '</div>'
      + '</div>';
    document.body.appendChild(backdrop);
  };

  Hub._submitPartnerInvite = async function () {
    var db = global.db; var u = global.currentUser;
    if (!db || !u) return alert('Not signed in');
    var name = (document.getElementById('hub-inv-name')  || {}).value || '';
    var email = ((document.getElementById('hub-inv-email') || {}).value || '').trim().toLowerCase();
    var orgType = (document.getElementById('hub-inv-orgtype') || {}).value || 'realEstate';
    var note = (document.getElementById('hub-inv-note') || {}).value || '';
    name = name.trim();
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

  // ── Partner Network — list of partners, with per-partner scorecards ──
  async function renderNetwork(mount) {
    var db = global.db; var u = global.currentUser;
    var body = mount.querySelector('#hub-network-body');
    if (!body) return;
    if (!db || !u) { body.innerHTML = unlocked('Sign in to manage the partner network.'); return; }
    var my = u.orgId || '';
    try {
      var [la, lb, orgs, leadsOut, leadsIn] = await Promise.all([
        db.collection('referralLinks').where('orgA', '==', my).get().catch(function () { return { docs: [] }; }),
        db.collection('referralLinks').where('orgB', '==', my).get().catch(function () { return { docs: [] }; }),
        db.collection('organizations').get().catch(function () { return { docs: [] }; }),
        db.collection('leads').where('fromOrgId', '==', my).get().catch(function () { return { docs: [] }; }),
        db.collection('leads').where('toOrgId',   '==', my).get().catch(function () { return { docs: [] }; }),
      ]);
      var orgMap = {};
      orgs.docs.forEach(function (d) { orgMap[d.id] = Object.assign({ id: d.id }, d.data()); });
      var links = la.docs.concat(lb.docs).map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      var allLeads = leadsOut.docs.concat(leadsIn.docs)
        .map(function (d) { return Object.assign({ id: d.id }, d.data()); })
        .map(Hub.lifecycle.normalize);

      // Overall scorecard across all partners.
      var overall = summarizeLeads(allLeads);

      if (!links.length) {
        body.innerHTML = ''
          + '<div class="hub-empty">'
          +   '<div class="hub-empty-icon">&#x1F331;</div>'
          +   '<h4>No partners yet</h4>'
          +   '<p>Invite a mortgage office, brokerage, CPA, or title/escrow partner to start exchanging leads.</p>'
          +   '<button class="hub-btn hub-btn-primary" style="margin-top:14px" onclick="Hub.openInvitePartner()">Invite a partner</button>'
          + '</div>';
        return;
      }

      var alertBanner = '';
      if (overall.stuck > 0) {
        alertBanner = ''
          + '<div class="hub-card" style="background:#fff6e5;border-color:#e7c77a;margin-bottom:12px">'
          +   '<div style="padding:10px 14px;font-size:12px;color:#6b4e10">'
          +     '<strong>' + overall.stuck + '</strong> referral' + (overall.stuck === 1 ? ' has' : 's have')
          +     ' been stuck in the pipeline for 14+ days with no activity.'
          +   '</div>'
          + '</div>';
      }

      var rows = links.map(function (link) {
        var otherId = (link.orgA === my) ? link.orgB : link.orgA;
        var otherOrg = orgMap[otherId] || { name: (link.pendingInvite && link.pendingInvite.email) || 'Pending…' };
        var type = Hub.orgTypeOf ? Hub.orgTypeOf(otherOrg) : '';
        var metrics = (Hub.lifecycle.computePartnerMetrics)
          ? Hub.lifecycle.computePartnerMetrics(allLeads, my, otherId)
          : { touched: 0, won: 0, closeRate: 0, avgDaysToClose: 0, stuckOver14d: 0 };
        var metricRow = (link.status === 'active')
          ? '<div style="font-size:11px;color:var(--hub-muted);margin-top:3px">'
          +   'Touched <strong>' + metrics.touched + '</strong>'
          +   ' &middot; Won <strong>' + metrics.won + '</strong>'
          +   ' &middot; Close <strong>' + (metrics.closeRate || 0) + '%</strong>'
          +   (metrics.avgDaysToClose ? ' &middot; Avg <strong>' + metrics.avgDaysToClose + 'd</strong>' : '')
          +   (metrics.stuckOver14d ? ' &middot; <span style="color:#b4721b">Stuck ' + metrics.stuckOver14d + '</span>' : '')
          + '</div>'
          : '';
        return ''
          + '<tr>'
          +   '<td><strong>' + esc(otherOrg.name || '(pending)') + '</strong>' + metricRow + '</td>'
          +   '<td>' + ((Hub.orgTypeBadgeHTML) ? Hub.orgTypeBadgeHTML(type) : esc(type || '')) + '</td>'
          +   '<td><span class="hub-pill hub-status-' + esc(link.status || 'pending') + '">' + esc(link.status || 'pending') + '</span></td>'
          +   '<td style="color:var(--hub-muted);font-size:11px">' + esc(fmtDate(link.initiatedAt)) + '</td>'
          +   '<td>'
          +     (link.status === 'pending' && link.orgB === my
                 ? '<button class="hub-btn hub-btn-primary" style="padding:4px 10px;font-size:11px" onclick="Hub._acceptLink(\'' + esc(link.id) + '\')">Accept</button>'
                 : '<button class="hub-btn hub-btn-secondary" style="padding:4px 10px;font-size:11px" onclick="Hub.openReferralSend({ toOrgId: \'' + esc(otherId) + '\' })">Send lead</button>')
          +   '</td>'
          + '</tr>';
      }).join('');

      body.innerHTML = ''
        + '<div class="hub-card" style="margin-bottom:12px"><div style="display:grid;grid-template-columns:repeat(5, 1fr);gap:0;border-top:1px solid var(--hub-line)">'
        +   kpi('Touched',      overall.touched,  'all partners')
        +   kpi('Active',       overall.active,   'in pipeline')
        +   kpi('Closed won',   overall.won,      'all-time')
        +   kpi('Close rate',   overall.closeRate, 'won vs lost')
        +   kpi('Stuck 14+d',   overall.stuck,    'need a nudge')
        + '</div></div>'
        + alertBanner
        + '<div class="hub-card"><div style="overflow-x:auto"><table class="hub-table">'
        +   '<thead><tr><th>Organization</th><th>Type</th><th>Status</th><th>Since</th><th></th></tr></thead>'
        +   '<tbody>' + rows + '</tbody>'
        + '</table></div></div>';
    } catch (e) {
      body.innerHTML = err$(e);
    }
  }

  function summarizeLeads(leads) {
    var L = Hub.lifecycle;
    var touched = leads.length;
    var active  = leads.filter(function (l) { return l.status === 'accepted' || l.status === 'in_process'; }).length;
    var won     = leads.filter(function (l) { return l.status === 'closed_won'; }).length;
    var lost    = leads.filter(function (l) { return l.status === 'closed_lost'; }).length;
    var stuck   = leads.filter(function (l) {
      if (L.isTerminal(l.status)) return false;
      var last = new Date(l.lastActivity || l.createdAt || 0).getTime();
      if (!last) return false;
      return (Date.now() - last) > 14 * 24 * 3600 * 1000;
    }).length;
    var closeRate = (won + lost) ? Math.round(won / (won + lost) * 100) : 0;
    return { touched: touched, active: active, won: won, lost: lost, stuck: stuck, closeRate: closeRate };
  }

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
      +   '<div class="hub-kpi-label">' + esc(label) + '</div>'
      +   '<div class="hub-kpi-value">' + esc(String(value)) + '</div>'
      +   '<div class="hub-kpi-delta">' + esc(sub || '') + '</div>'
      + '</div>';
  }

  function byNewest(a, b) {
    return new Date(b.lastActivity || b.createdAt || 0) - new Date(a.lastActivity || a.createdAt || 0);
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function unlocked(msg) { return '<div class="hub-empty"><div class="hub-empty-icon">&#x2139;&#xfe0f;</div><p>' + esc(msg) + '</p></div>'; }
  function err$(e)       { return '<div class="hub-empty"><div class="hub-empty-icon">&#x26A0;&#xfe0f;</div><p>' + esc(e && e.message || String(e)) + '</p></div>'; }

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

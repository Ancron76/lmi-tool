// ======================================================================
// Loopenta Hub — Manager / Admin team reporting (2026-04-22)
// Shows team members + their rolled-up activity (prospects, leads,
// flyers, LMI lookups, last-seen). CSV export.
// ======================================================================
(function (global) {
  'use strict';

  var Hub = global.Hub = global.Hub || {};

  Hub.registerRoute && Hub.registerRoute('reporting', {
    label: 'Team Activity',
    icon: '📊',
    visible: function (caps) {
      return caps && (caps.isSuperAdmin || caps.isAdmin || caps.isManager);
    },
    render: async function (mount) {
      var u = global.currentUser;
      if (!u) { mount.innerHTML = emptyState('Not signed in.'); return; }

      mount.innerHTML = skeleton();
      var teamBox = mount.querySelector('#hub-rep-team');
      var kpiBox  = mount.querySelector('#hub-rep-kpis');
      var feedBox = mount.querySelector('#hub-rep-feed');

      try {
        var scope = await resolveScope(u);
        var team  = await fetchTeamMembers(scope);
        var stats = await collectStats(team, scope);
        renderKpis(kpiBox, stats);
        renderTeam(teamBox, team, stats, scope);
        renderFeed(feedBox, stats);
      } catch (err) {
        mount.innerHTML = errorState(err);
        console.error('[Hub] reporting error', err);
      }
    },
  });

  // ── Determine scope of the viewing user ─────────────────────────
  async function resolveScope(user) {
    // Returns { orgId, teamFilter: 'all'|'team', managerUid }
    var caps = Hub.capabilities(user);
    if (caps.isSuperAdmin) return { orgId: null, teamFilter: 'all', managerUid: null, view: 'platform' };
    if (caps.isAdmin)      return { orgId: user.orgId, teamFilter: 'org', managerUid: null, view: 'org' };
    if (caps.isManager)    return { orgId: user.orgId, teamFilter: 'team', managerUid: user.id || user.firebaseAuthUid, view: 'team' };
    return { orgId: user.orgId, teamFilter: 'self', managerUid: user.id || user.firebaseAuthUid, view: 'self' };
  }

  async function fetchTeamMembers(scope) {
    var db = global.db;
    if (!db) return [];
    var snap;
    try {
      snap = await db.collection('users').get();
    } catch (e) {
      // Managers without list permission: fall back to client-filter
      // via the cachedUsers list if the host app has one.
      if (global._cachedUsers && Array.isArray(global._cachedUsers)) {
        return applyScope(global._cachedUsers, scope);
      }
      throw e;
    }
    var users = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    return applyScope(users, scope);
  }

  function applyScope(users, scope) {
    if (scope.view === 'platform') return users;
    if (scope.view === 'org')      return users.filter(function (u) { return u.orgId === scope.orgId; });
    if (scope.view === 'team')     return users.filter(function (u) {
      return u.orgId === scope.orgId
        && (u.managerId === scope.managerUid || u.id === scope.managerUid);
    });
    return users.filter(function (u) { return u.id === scope.managerUid; });
  }

  // ── Collect per-user stats ─────────────────────────────────────
  async function collectStats(team, scope) {
    var db = global.db;
    var counts = {};
    team.forEach(function (u) { counts[u.id] = { prospects: 0, activities: 0, flyers: 0, leadsOut: 0, leadsIn: 0, last: null }; });

    if (!db) return counts;

    var ids = team.map(function (u) { return u.id; });
    if (!ids.length) return counts;

    // Prospects
    await tallyByUser(db, 'prospects', 'userId', ids, counts, 'prospects', 'savedAt');
    // Activities
    await tallyByUser(db, 'activity', 'userId', ids, counts, 'activities', 'loggedAt');
    // Flyers
    await tallyByUser(db, 'flyers', 'userId', ids, counts, 'flyers', 'createdAt');
    // Leads (outgoing)
    await tallyByUser(db, 'leads', 'fromUserId', ids, counts, 'leadsOut', 'createdAt');
    // Leads (incoming)
    await tallyByUser(db, 'leads', 'toUserId', ids, counts, 'leadsIn', 'createdAt');

    return counts;
  }

  async function tallyByUser(db, coll, field, ids, counts, key, tsField) {
    // Batch "in" queries of 10 (Firestore limit)
    for (var i = 0; i < ids.length; i += 10) {
      var slice = ids.slice(i, i + 10);
      try {
        var snap = await db.collection(coll).where(field, 'in', slice).get();
        snap.forEach(function (d) {
          var data = d.data();
          var uid = data[field];
          if (!counts[uid]) counts[uid] = {};
          counts[uid][key] = (counts[uid][key] || 0) + 1;
          var ts = data[tsField];
          if (ts) {
            var prev = counts[uid].last;
            if (!prev || new Date(ts) > new Date(prev)) counts[uid].last = ts;
          }
        });
      } catch (e) {
        // collection may not exist yet — treat as zero
      }
    }
  }

  // ── Render ─────────────────────────────────────────────────────
  function renderKpis(el, stats) {
    if (!el) return;
    var total = 0, act = 0, flyer = 0, leads = 0;
    Object.keys(stats).forEach(function (uid) {
      var s = stats[uid];
      total += (s.prospects || 0); act += (s.activities || 0);
      flyer += (s.flyers || 0); leads += (s.leadsOut || 0) + (s.leadsIn || 0);
    });
    el.innerHTML = ''
      + kpi('Team prospects', total, '+saved ZIPs & borrowers')
      + kpi('Logged activities', act, 'CRA & outreach events')
      + kpi('Flyers generated', flyer, 'co-branded LMI flyers')
      + kpi('Leads in/out', leads, 'network referrals');
  }

  function kpi(label, value, sub) {
    return ''
      + '<div class="hub-kpi">'
      +   '<div class="hub-kpi-label">' + label + '</div>'
      +   '<div class="hub-kpi-value">' + value + '</div>'
      +   '<div class="hub-kpi-delta">' + sub + '</div>'
      + '</div>';
  }

  function renderTeam(el, team, stats, scope) {
    if (!el) return;
    if (!team || !team.length) {
      el.innerHTML = '<div class="hub-empty"><div class="hub-empty-icon">👥</div><h4>No team members yet</h4><p>Invite Home Loan Advisors, Realtors, or Referral Partners to start building your team.</p></div>';
      return;
    }
    var rows = team.map(function (u) {
      var s = stats[u.id] || {};
      var last = s.last ? timeago(s.last) : '—';
      return ''
        + '<tr>'
        +   '<td><strong>' + esc(u.name || u.email || '—') + '</strong>'
        +     '<div style="font-size:11px;color:#94a3b8">' + esc(u.email || '') + '</div></td>'
        +   '<td>' + Hub.roleBadgeHTML(u.role) + '</td>'
        +   '<td>' + (u.active === false ? '<span class="hub-status paused">Inactive</span>' : '<span class="hub-status active">Active</span>') + '</td>'
        +   '<td>' + (s.prospects || 0) + '</td>'
        +   '<td>' + (s.activities || 0) + '</td>'
        +   '<td>' + (s.flyers || 0) + '</td>'
        +   '<td>' + (s.leadsOut || 0) + ' / ' + (s.leadsIn || 0) + '</td>'
        +   '<td style="color:#64748b">' + last + '</td>'
        +   '<td>' + actionCell(u) + '</td>'
        + '</tr>';
    }).join('');
    el.innerHTML = ''
      + '<div class="hub-card">'
      +   '<div class="hub-card-header">'
      +     '<div><div class="hub-card-title">👥 Your team</div>'
      +     '<div class="hub-card-sub">' + (scope.view === 'platform' ? 'All platform users' : scope.view === 'org' ? 'Everyone in your organization' : scope.view === 'team' ? 'Direct reports' : 'Just you') + '</div></div>'
      +     '<button class="hub-btn hub-btn-secondary" onclick="Hub._exportTeamCSV()">⬇️ Export CSV</button>'
      +   '</div>'
      +   '<div style="overflow-x:auto"><table class="hub-table">'
      +     '<thead><tr><th>Member</th><th>Role</th><th>Status</th><th>Prospects</th><th>Activity</th><th>Flyers</th><th>Leads (out/in)</th><th>Last seen</th><th></th></tr></thead>'
      +     '<tbody>' + rows + '</tbody>'
      +   '</table></div>'
      + '</div>';

    Hub._lastReportData = { team: team, stats: stats };
  }

  function actionCell(u) {
    var caps = Hub.capabilities(global.currentUser || null);
    if (!caps.canAssignLeads) return '';
    return ''
      + '<button class="hub-btn hub-btn-secondary" style="padding:4px 10px;font-size:11px" '
      +   'onclick="Hub._openAssignToUser(\'' + esc(u.id) + '\',\'' + esc(u.name || u.email || '') + '\')">'
      +   'Assign lead'
      + '</button>';
  }

  function renderFeed(el, stats) {
    if (!el) return;
    el.innerHTML = ''
      + '<div class="hub-card" style="margin-top:18px">'
      +   '<div class="hub-card-header"><div class="hub-card-title">🧭 Coaching insights</div></div>'
      +   coachingInsights(stats)
      + '</div>';
  }

  function coachingInsights(stats) {
    var dormant = [];
    var stars   = [];
    var now = Date.now();
    Object.keys(stats).forEach(function (uid) {
      var s = stats[uid];
      if (!s.last || (now - new Date(s.last).getTime()) > 7 * 24 * 3600 * 1000) dormant.push(uid);
      if ((s.prospects || 0) + (s.activities || 0) > 20) stars.push(uid);
    });
    var html = '<ul style="margin:0;padding-left:18px;line-height:1.9;color:#334155">';
    if (dormant.length) {
      html += '<li><strong>' + dormant.length + '</strong> teammate' + (dormant.length === 1 ? '' : 's') + ' with no activity in the last 7 days — consider a check-in.</li>';
    } else {
      html += '<li>Everyone active in the last 7 days. Nice.</li>';
    }
    if (stars.length) {
      html += '<li><strong>' + stars.length + '</strong> teammate' + (stars.length === 1 ? '' : 's') + ' trending high on prospects + logged activity — recognize them.</li>';
    }
    html += '<li>Tip: use the <em>Assign lead</em> action on any row to route an incoming referral directly.</li>';
    html += '</ul>';
    return html;
  }

  // ── Export ─────────────────────────────────────────────────────
  Hub._exportTeamCSV = function () {
    var data = Hub._lastReportData;
    if (!data) return;
    var rows = [['Name', 'Email', 'Role', 'Status', 'Prospects', 'Activity', 'Flyers', 'Leads Out', 'Leads In', 'Last Activity']];
    data.team.forEach(function (u) {
      var s = data.stats[u.id] || {};
      rows.push([
        u.name || '', u.email || '', Hub.roleLabel(u.role),
        u.active === false ? 'Inactive' : 'Active',
        s.prospects || 0, s.activities || 0, s.flyers || 0,
        s.leadsOut || 0, s.leadsIn || 0, s.last || '',
      ]);
    });
    var csv = rows.map(function (r) { return r.map(csvCell).join(','); }).join('\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = 'loopenta-team-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 500);
  };

  function csvCell(v) {
    var s = (v == null) ? '' : String(v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  // ── Inline assign (opens the referrals send form pre-targeted) ──
  Hub._openAssignToUser = function (uid, name) {
    if (Hub.openReferralSend) Hub.openReferralSend({ assignToUserId: uid, assignToName: name });
    else alert('Assign to ' + name + ' — referral module not yet loaded.');
  };

  // ── Helpers ────────────────────────────────────────────────────
  function skeleton() {
    return ''
      + '<div class="hub-section-h"><div><h2>Team activity</h2><div class="hub-section-sub">Rolled-up by member across prospects, activities, flyers, and leads.</div></div></div>'
      + '<div class="hub-kpis" id="hub-rep-kpis"></div>'
      + '<div id="hub-rep-team" style="margin-top:18px"></div>'
      + '<div id="hub-rep-feed"></div>';
  }

  function emptyState(msg) {
    return '<div class="hub-empty"><div class="hub-empty-icon">ℹ️</div><p>' + esc(msg) + '</p></div>';
  }
  function errorState(err) {
    return '<div class="hub-empty"><div class="hub-empty-icon">⚠️</div><h4>Could not load team activity</h4><p>' + esc(err && err.message ? err.message : String(err)) + '</p></div>';
  }

  function esc(s) {
    return (s == null ? '' : String(s)).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function timeago(iso) {
    var t = new Date(iso).getTime();
    if (isNaN(t)) return iso;
    var diff = Date.now() - t;
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + ' hr ago';
    var days = Math.floor(hrs / 24);
    if (days < 30) return days + 'd ago';
    var months = Math.floor(days / 30);
    return months + 'mo ago';
  }

})(typeof window !== 'undefined' ? window : globalThis);

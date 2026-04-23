// ======================================================================
// Loopenta Hub — Referral Lifecycle config (2026-04-22)
// Stage sets by referral kind, label maps, helper utilities.
// All lifecycle logic reads through Hub.lifecycle so there is ONE source
// of truth for valid stages, transitions, and display labels.
// ======================================================================
(function (global) {
  'use strict';

  var Hub = global.Hub = global.Hub || {};
  var L = Hub.lifecycle = Hub.lifecycle || {};

  // ── Pipeline stages by referral kind ─────────────────────────────────
  // In-process stages only. Terminal statuses (closed_won, closed_lost,
  // declined) are tracked on the `status` field, not in the stage list.
  L.STAGES_BY_KIND = {
    borrower:  ['application', 'pre_qual', 'processing', 'underwriting', 'cleared_to_close', 'funded'],
    refinance: ['application', 'pre_qual', 'processing', 'underwriting', 'cleared_to_close', 'funded'],
    buyer:     ['showing',     'offer_out','under_contract','inspection','appraisal',         'closed'],
    seller:    ['listing_prep','listed',   'under_contract','inspection','appraisal',         'closed'],
    referral:  ['working',     'qualified','closed'],
  };

  // Human-readable labels for stages + statuses.
  L.STAGE_LABELS = {
    // mortgage
    application:      'Application',
    pre_qual:         'Pre-qualified',
    processing:       'Processing',
    underwriting:     'Underwriting',
    cleared_to_close: 'Cleared to Close',
    funded:           'Funded',
    // real estate
    showing:          'Showing',
    offer_out:        'Offer Out',
    under_contract:   'Under Contract',
    inspection:       'Inspection',
    appraisal:        'Appraisal',
    closed:           'Closed',
    listing_prep:     'Listing Prep',
    listed:           'Listed',
    // general
    working:          'Working',
    qualified:        'Qualified',
  };

  // Top-level statuses (orthogonal to stage).
  //   pending      — referral has been sent, receiver hasn't accepted yet
  //   accepted     — receiver accepted; stage is now active
  //   declined     — receiver declined (terminal)
  //   in_process   — actively moving through stages
  //   closed_won   — funded / closed in our favor (terminal)
  //   closed_lost  — deal died (terminal)
  L.STATUSES = ['pending', 'accepted', 'declined', 'in_process', 'closed_won', 'closed_lost'];
  L.STATUS_LABELS = {
    pending:     'Pending',
    accepted:    'Accepted',
    declined:    'Declined',
    in_process:  'In process',
    closed_won:  'Closed · Won',
    closed_lost: 'Closed · Lost',
  };
  L.TERMINAL_STATUSES = ['declined', 'closed_won', 'closed_lost'];

  // ── Legacy-status translation ────────────────────────────────────────
  // The existing `leads` docs use a flat status vocab (sent/accepted/
  // working/won/lost/declined). Map it into the new {status, stage}
  // model when we read, so old records still render correctly.
  L.normalize = function (lead) {
    if (!lead) return lead;
    var out = Object.assign({}, lead);
    if (!out.status) out.status = 'pending';
    // If the doc already has a new-world status, keep it.
    if (L.STATUSES.indexOf(out.status) === -1) {
      var map = {
        sent:      'pending',
        working:   'in_process',
        won:       'closed_won',
        lost:      'closed_lost',
        declined:  'declined',
        accepted:  'accepted',
      };
      out.status = map[out.status] || 'pending';
    }
    // Derive a sensible stage if none is set.
    if (!out.stage && (out.status === 'in_process' || out.status === 'accepted')) {
      out.stage = L.firstStage(out.kind);
    }
    return out;
  };

  // ── Stage helpers ────────────────────────────────────────────────────
  L.stagesFor = function (kind) {
    return L.STAGES_BY_KIND[kind] || L.STAGES_BY_KIND.referral;
  };
  L.firstStage = function (kind) {
    var s = L.stagesFor(kind);
    return s[0];
  };
  L.lastStage = function (kind) {
    var s = L.stagesFor(kind);
    return s[s.length - 1];
  };
  L.stageIndex = function (kind, stage) {
    return L.stagesFor(kind).indexOf(stage);
  };
  L.nextStage = function (kind, stage) {
    var s = L.stagesFor(kind);
    var i = s.indexOf(stage);
    if (i === -1) return s[0];
    if (i >= s.length - 1) return null;
    return s[i + 1];
  };
  L.prevStage = function (kind, stage) {
    var s = L.stagesFor(kind);
    var i = s.indexOf(stage);
    if (i <= 0) return null;
    return s[i - 1];
  };
  L.isTerminal = function (status) {
    return L.TERMINAL_STATUSES.indexOf(status) !== -1;
  };
  L.stageLabel = function (stage) {
    return L.STAGE_LABELS[stage] || (stage || '').replace(/_/g, ' ');
  };
  L.statusLabel = function (status) {
    return L.STATUS_LABELS[status] || status || '';
  };

  // ── Activity / timeline events ───────────────────────────────────────
  // Event types written to `lead.timeline[]`:
  //   'sent'              — initial creation
  //   'viewed'            — receiver opened it for the first time
  //   'accepted'          — receiver accepted
  //   'declined'          — receiver declined (with reason)
  //   'stage_advanced'    — stage moved forward (from → to)
  //   'stage_reverted'    — stage moved backward (correction)
  //   'note'              — someone left a note
  //   'closed_won'        — deal closed successfully
  //   'closed_lost'       — deal closed unsuccessfully (with reason)
  //   'reassigned'        — assigned to a different user on the receiver side
  L.EVENT_LABELS = {
    sent:             'Referral sent',
    viewed:           'Opened by receiver',
    accepted:         'Accepted',
    declined:         'Declined',
    stage_advanced:   'Stage advanced',
    stage_reverted:   'Stage reverted',
    note:             'Note added',
    closed_won:       'Closed — Won',
    closed_lost:      'Closed — Lost',
    reassigned:       'Reassigned',
  };

  // Build a timeline entry. Caller passes { event, from, to, note, reason }.
  L.makeEvent = function (u, orgCtx, evt) {
    return {
      at:        new Date().toISOString(),
      by:        (u && u.id) || '',
      byName:    (u && (u.name || u.email)) || '',
      byOrgId:   (u && u.orgId) || '',
      byOrgName: (orgCtx && orgCtx.name) || '',
      event:     evt.event,
      fromStage: evt.from || '',
      toStage:   evt.to || '',
      note:      evt.note || '',
      reason:    evt.reason || '',
    };
  };

  // ── Metrics helpers (for scorecards) ─────────────────────────────────
  // Given an array of lead docs, compute counts/rates for a partner.
  L.computePartnerMetrics = function (leads, myOrgId, partnerOrgId) {
    var m = {
      sentToPartner:    0,  // we sent → them
      receivedFromPartner: 0, // they sent → us
      accepted:         0,
      declined:         0,
      inProcess:        0,
      closedWon:        0,
      closedLost:       0,
      acceptRate:       0,
      closeRate:        0,
      avgDaysToClose:   0,
      stuckOver14d:     0,
    };
    var closeDurations = [];
    var now = Date.now();
    leads.forEach(function (lRaw) {
      var l = L.normalize(lRaw);
      var involves =
        (l.fromOrgId === myOrgId && l.toOrgId === partnerOrgId) ||
        (l.fromOrgId === partnerOrgId && l.toOrgId === myOrgId);
      if (!involves) return;
      if (l.fromOrgId === myOrgId) m.sentToPartner++;
      else m.receivedFromPartner++;
      if (l.status === 'accepted')    m.accepted++;
      if (l.status === 'declined')    m.declined++;
      if (l.status === 'in_process')  m.inProcess++;
      if (l.status === 'closed_won')  m.closedWon++;
      if (l.status === 'closed_lost') m.closedLost++;
      if (l.status === 'closed_won' && l.createdAt && l.closedAt) {
        var days = (new Date(l.closedAt) - new Date(l.createdAt)) / (86400000);
        if (days > 0) closeDurations.push(days);
      }
      if (l.status === 'in_process' && l.stageUpdatedAt) {
        var sinceDays = (now - new Date(l.stageUpdatedAt).getTime()) / 86400000;
        if (sinceDays > 14) m.stuckOver14d++;
      }
    });
    var touched = m.sentToPartner + m.receivedFromPartner;
    var resolved = m.accepted + m.declined + m.closedWon + m.closedLost + m.inProcess;
    if (resolved > 0) m.acceptRate = Math.round((m.accepted + m.inProcess + m.closedWon + m.closedLost) / resolved * 100);
    var finalTouched = m.closedWon + m.closedLost;
    if (finalTouched > 0) m.closeRate = Math.round(m.closedWon / finalTouched * 100);
    if (closeDurations.length) {
      var sum = closeDurations.reduce(function (a, b) { return a + b; }, 0);
      m.avgDaysToClose = Math.round(sum / closeDurations.length);
    }
    m.touched = touched;
    return m;
  };

  // ── Unread tracking ──────────────────────────────────────────────────
  // `lead.lastReadBy[uid]` is an ISO string. A lead is "unread for user"
  // if timeline has any entry newer than that, OR if no entry exists and
  // user isn't the sender.
  L.isUnreadFor = function (lead, uid) {
    if (!lead || !uid) return false;
    var lastRead = (lead.lastReadBy || {})[uid] || '';
    var latest = '';
    (lead.timeline || []).forEach(function (e) {
      if (e && e.at && e.at > latest) latest = e.at;
    });
    if (!latest) return !lastRead && lead.fromUserId !== uid;
    return !lastRead || lastRead < latest;
  };

  console.info('[Hub.lifecycle] loaded');

})(typeof window !== 'undefined' ? window : globalThis);

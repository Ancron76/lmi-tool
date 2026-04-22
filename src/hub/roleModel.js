// ======================================================================
// Loopenta Hub — Role & Organization model (additive, 2026-04-22)
// ----------------------------------------------------------------------
// Single source of truth for org types and roles, loaded from index.html.
// Attaches to window.Hub — the existing app keeps working; this layer
// just adds semantics, labels, and helpers.
// ----------------------------------------------------------------------
// See ROLES_SPEC.md for the full design rationale.
// ======================================================================
(function (global) {
  'use strict';

  var Hub = global.Hub = global.Hub || {};

  // ── Org types ─────────────────────────────────────────────────────
  Hub.ORG_TYPES = {
    mortgage: {
      key: 'mortgage',
      label: 'Mortgage Organization',
      short: 'Mortgage',
      icon: '🏦',
      description: 'Lenders, brokerages, credit unions. Home Loan Advisors and their Managers.',
      defaultRoleForInvitee: 'mlo',
      availableRoles: ['admin', 'manager', 'mlo'],
    },
    realEstate: {
      key: 'realEstate',
      label: 'Real Estate Organization',
      short: 'Real Estate',
      icon: '🏠',
      description: 'Brokerages. Realtors and their Broker / Manager.',
      defaultRoleForInvitee: 'realtor',
      availableRoles: ['admin', 'manager', 'realtor'],
    },
    referralPartner: {
      key: 'referralPartner',
      label: 'Referral Partner',
      short: 'Referral',
      icon: '🤝',
      description: 'CPAs, financial advisors, insurance agents, attorneys, and other trusted referral sources.',
      defaultRoleForInvitee: 'referralUser',
      availableRoles: ['admin', 'manager', 'referralUser'],
    },
    title: {
      key: 'title',
      label: 'Title Company',
      short: 'Title',
      icon: '📄',
      description: 'Title officers coordinating with lenders and realtors on closings.',
      defaultRoleForInvitee: 'titleUser',
      availableRoles: ['admin', 'manager', 'titleUser'],
    },
    escrow: {
      key: 'escrow',
      label: 'Escrow Company',
      short: 'Escrow',
      icon: '🔐',
      description: 'Escrow officers managing the closing timeline and funds.',
      defaultRoleForInvitee: 'escrowUser',
      availableRoles: ['admin', 'manager', 'escrowUser'],
    },
  };
  Hub.ORG_TYPE_KEYS = Object.keys(Hub.ORG_TYPES);

  // ── Roles ─────────────────────────────────────────────────────────
  // NOTE: 'mlo' is intentionally the stored value for "Home Loan
  // Advisor" so we don't invalidate years of existing Firestore data.
  // The label mapping below relabels it at the UI layer only.
  Hub.ROLES = {
    superadmin: {
      key: 'superadmin',
      label: 'Super Admin',
      description: 'Platform-wide access. Not scoped to any org.',
      orgTypes: [], // platform role
      tier: 100,
    },
    admin: {
      key: 'admin',
      label: 'Admin',
      description: 'Full control of one organization.',
      orgTypes: ['mortgage', 'realEstate', 'referralPartner', 'title', 'escrow'],
      tier: 80,
    },
    manager: {
      key: 'manager',
      label: 'Manager',
      description: 'Supervises a team within one org. Sees their activity and assigns leads.',
      orgTypes: ['mortgage', 'realEstate', 'referralPartner', 'title', 'escrow'],
      tier: 60,
    },
    mlo: {
      key: 'mlo',
      label: 'Home Loan Advisor',
      shortLabel: 'HLA',
      description: 'Individual producer on a Mortgage team.',
      orgTypes: ['mortgage'],
      tier: 40,
    },
    realtor: {
      key: 'realtor',
      label: 'Realtor',
      description: 'Individual agent on a Real Estate team.',
      orgTypes: ['realEstate'],
      tier: 40,
    },
    referralUser: {
      key: 'referralUser',
      label: 'Referral Partner',
      description: 'Professional who refers clients to mortgage / real-estate orgs.',
      orgTypes: ['referralPartner'],
      tier: 40,
    },
    titleUser: {
      key: 'titleUser',
      label: 'Title Officer',
      description: 'Title-company team member on the closing workflow.',
      orgTypes: ['title'],
      tier: 40,
    },
    escrowUser: {
      key: 'escrowUser',
      label: 'Escrow Officer',
      description: 'Escrow-company team member on the closing workflow.',
      orgTypes: ['escrow'],
      tier: 40,
    },
  };
  Hub.ROLE_KEYS = Object.keys(Hub.ROLES);

  // ── Referral Partner titles ──────────────────────────────────────
  Hub.REFERRAL_PARTNER_TITLES = [
    { key: 'cpa',              label: 'CPA / Accountant' },
    { key: 'advisor',          label: 'Financial Advisor' },
    { key: 'insurance',        label: 'Insurance Agent' },
    { key: 'attorney',         label: 'Attorney' },
    { key: 'divorceAttorney',  label: 'Divorce Attorney' },
    { key: 'estatePlanner',    label: 'Estate Planner' },
    { key: 'builder',          label: 'Builder / Developer' },
    { key: 'propertyManager',  label: 'Property Manager' },
    { key: 'inspector',        label: 'Home Inspector' },
    { key: 'appraiser',        label: 'Appraiser' },
    { key: 'contractor',       label: 'Contractor' },
    { key: 'creditRepair',     label: 'Credit Repair Specialist' },
    { key: 'investor',         label: 'Real Estate Investor' },
    { key: 'relocation',       label: 'Relocation Specialist' },
    { key: 'hrBenefits',       label: 'HR / Benefits Coordinator' },
    { key: 'custom',           label: 'Other (specify)' },
  ];

  // ── Helpers ──────────────────────────────────────────────────────
  Hub.roleLabel = function (role) {
    var r = Hub.ROLES[role];
    return r ? r.label : (role ? (role.charAt(0).toUpperCase() + role.slice(1)) : '—');
  };

  Hub.orgTypeLabel = function (orgType) {
    var t = Hub.ORG_TYPES[orgType];
    return t ? t.label : 'Organization';
  };

  Hub.roleTier = function (role) {
    var r = Hub.ROLES[role];
    return r ? r.tier : 0;
  };

  // Defaults a missing orgType to 'mortgage' for back-compat with orgs
  // created before the orgType field existed.
  Hub.orgTypeOf = function (org) {
    if (!org) return 'mortgage';
    return org.orgType || 'mortgage';
  };

  Hub.isValidRoleForOrgType = function (role, orgType) {
    var r = Hub.ROLES[role];
    if (!r) return false;
    if (r.key === 'superadmin' || r.key === 'admin' || r.key === 'manager') {
      // admin/manager/superadmin are org-type agnostic
      return true;
    }
    return r.orgTypes.indexOf(orgType) !== -1;
  };

  Hub.rolesForOrgType = function (orgType) {
    var t = Hub.ORG_TYPES[orgType];
    if (!t) return ['admin', 'manager'];
    return t.availableRoles.slice();
  };

  // Role badge color palette — consistent chips across the app.
  Hub.ROLE_COLORS = {
    superadmin:  { bg: '#1c1812', fg: '#f5d896', border: '#c4943a' }, // brand
    admin:       { bg: '#eef4ff', fg: '#1558c0', border: '#1558c0' },
    manager:     { bg: '#fef3c7', fg: '#a16207', border: '#d97706' },
    mlo:         { bg: '#ecfdf5', fg: '#047857', border: '#10b981' },
    realtor:     { bg: '#fdf4ff', fg: '#9333ea', border: '#a855f7' },
    referralUser:{ bg: '#fff7ed', fg: '#c2410c', border: '#ea580c' },
    titleUser:   { bg: '#f0f9ff', fg: '#0369a1', border: '#0ea5e9' },
    escrowUser:  { bg: '#f5f3ff', fg: '#5b21b6', border: '#7c3aed' },
  };

  Hub.orgTypeBadgeHTML = function (orgType) {
    var t = Hub.ORG_TYPES[orgType] || Hub.ORG_TYPES.mortgage;
    return ''
      + '<span class="hub-orgtype-chip" data-orgtype="' + t.key + '">'
      + '<span class="hub-orgtype-chip-icon">' + t.icon + '</span>'
      + '<span>' + t.short + '</span>'
      + '</span>';
  };

  Hub.roleBadgeHTML = function (role) {
    var meta = Hub.ROLES[role];
    var label = meta ? meta.label : (role || '—');
    var c = Hub.ROLE_COLORS[role] || { bg: '#f1f5f9', fg: '#475569', border: '#cbd5e1' };
    return ''
      + '<span class="hub-role-chip" '
      + 'style="background:' + c.bg + ';color:' + c.fg + ';border:1px solid ' + c.border + '">'
      + label
      + '</span>';
  };

  // Given a currentUser document, what privileged abilities do they have?
  // Returns a small capability object other modules can consult.
  Hub.capabilities = function (user) {
    if (!user) return { any: false };
    return {
      isSuperAdmin:   user.role === 'superadmin',
      isAdmin:        user.role === 'admin',
      isManager:      user.role === 'manager',
      isHla:          user.role === 'mlo',
      isRealtor:      user.role === 'realtor',
      isReferralUser: user.role === 'referralUser',
      isTitleUser:    user.role === 'titleUser',
      isEscrowUser:   user.role === 'escrowUser',
      isAnyAdmin:     user.role === 'admin' || user.role === 'superadmin',
      hasTeamView:    user.role === 'admin'
                     || user.role === 'superadmin'
                     || user.role === 'manager',
      canInvite:      user.role === 'admin'
                     || user.role === 'superadmin'
                     || user.role === 'manager',
      canAssignLeads: user.role === 'admin'
                     || user.role === 'superadmin'
                     || user.role === 'manager',
      canPartnerWith: !!user.role && user.role !== 'superadmin',
      orgId:          user.orgId || '',
      managerId:      user.managerId || '',
    };
  };

  // Feature-flag aware of orgType. Tier ceilings still apply from the
  // existing FEATURE_CATALOG; this just adds an orgType filter layer.
  Hub.FEATURE_ORGTYPE_MAP = {
    lmi_search:          null, // all
    for_sale_listings:   null,
    prospect_list:       null,
    deal_pipeline:       ['mortgage'],
    borrowers:           ['mortgage'],
    past_customers:      ['mortgage'],
    refi_alerts:         ['mortgage'],
    realtor_scorecard:   ['mortgage'],
    mlo_scorecards:      ['mortgage'],
    // Realtor side
    listings_board:      ['realEstate'],
    buyer_pipeline:      ['realEstate'],
    showing_scheduler:   ['realEstate'],
    // Cross-org
    referral_inbox:      null,
    shared_deals:        null,
    manager_reports:     null,
    // Title/Escrow portals
    title_portal:        ['title'],
    escrow_portal:       ['escrow'],
  };

  Hub.isFeatureVisibleForOrgType = function (flag, orgType) {
    var allowed = Hub.FEATURE_ORGTYPE_MAP[flag];
    if (!allowed) return true; // null / undefined = visible everywhere
    return allowed.indexOf(orgType || 'mortgage') !== -1;
  };

  // Version stamp for diagnostics.
  Hub.VERSION = '2026.04.22-hub-1';

  if (global.console && global.console.info) {
    try { global.console.info('[Hub] roleModel loaded', Hub.VERSION); } catch(e){}
  }

})(typeof window !== 'undefined' ? window : globalThis);

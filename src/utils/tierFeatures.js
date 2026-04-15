// ── Tier Feature Definitions ────────────────────────────────────
// Defines which features belong to which product tier.
// Tier 1 = "lmi_only" (LMI Tool)
// Tier 2 = "full" (Loopenta CRM)

var TIER_FEATURES = {

  // ── LMI Tool tier (lmi_only) ─────────────────────────
  // Available to ALL tiers
  lmi_only: [
    "lmi_search",        // Census tract LMI lookup
    "oyz_open_houses",   // Open house prospecting
    "analytics",         // CRA analytics and reporting
    "cra_reports",       // CRA report generation
    "activity_log",      // CRA activity logging
    "dashboard",         // Team dashboard
    "marketing",         // Flyers and materials
    "realtor_basic",     // Basic realtor list (no scorecard)
    "notifications",     // In-app notifications
  ],

  // ── Loopenta full tier ───────────────────────────────
  // Available to "full" tier ONLY
  full: [
    // Everything in lmi_only PLUS:
    "deal_pipeline",     // Kanban pipeline
    "borrowers",         // Borrower profiles
    "contacts_full",     // Full contacts CRM
    "communications",    // Email + SMS communications
    "realtor_scorecard", // Realtor ROI scorecards
    "sequences",         // Automated follow-up sequences
    "past_customers",    // Past customer refi tracking
    "refi_alerts",       // Refi opportunity engine
    "mlo_scorecards",    // Individual MLO scorecards
    "leaderboard",       // Team leaderboard
    "lmi_auto_screen",   // LMI auto-screening on forms
  ],
};

function hasFeature(tier, feature) {
  if (tier === "full") {
    return TIER_FEATURES.lmi_only.indexOf(feature) !== -1 ||
           TIER_FEATURES.full.indexOf(feature) !== -1;
  }
  return TIER_FEATURES.lmi_only.indexOf(feature) !== -1;
}

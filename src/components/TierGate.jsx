// ── TierGate — React component for feature gating ──────────────
// Usage in React components that import this:
//   <TierGate feature="deal_pipeline" tier={tier}>
//     <DealPipelineModule />
//   </TierGate>
//
// Note: Most tier gating in this app is done via vanilla JS
// in index.html using hasFeature(). This component is for
// any React-rendered sections that need gating.

import React from "react";

export function TierGate({ feature, tier, children, fallback }) {
  // Import from global scope (set by index.html)
  const check = window.hasFeature || function() { return true; };
  if (check(tier, feature)) {
    return children;
  }
  return fallback || null;
}

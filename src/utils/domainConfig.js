// ── Domain Detection & Branding ─────────────────────────────────
// Determines which product branding to show based on hostname.
// Both lmitool.com and loopenta.com serve the same deployment;
// this config drives the correct branding for each.

var hostname = window.location.hostname;

var DOMAIN_CONFIG = {
  isLoopenta: hostname.indexOf("loopenta.com") !== -1 ||
              hostname.indexOf("loopenta") !== -1,
  isLmiTool:  hostname.indexOf("lmitool.com") !== -1 ||
              hostname.indexOf("lmi-tool") !== -1 ||
              hostname.indexOf("localhost") !== -1,  // dev default

  // Branding
  appName:    hostname.indexOf("loopenta") !== -1
                ? "Loopenta"
                : "LMI Prospect Finder",
  appTagline: hostname.indexOf("loopenta") !== -1
                ? "Mortgage CRM"
                : "LMI Compliance Tool",
  logoLetter: "L",
  primaryColor: "#c4943a",  // same for both — can diverge later

  // Default tier for new tenants from this domain
  defaultTier: hostname.indexOf("loopenta") !== -1 ? "full" : "lmi_only",
};

// TODO Phase 24: Loopenta gets distinct branding
// - Different color scheme (TBD)
// - Loopenta logo asset
// - Marketing landing page at loopenta.com root
// - Login at app.loopenta.com (subdomain)

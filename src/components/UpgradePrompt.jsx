// ── UpgradePrompt — React component for locked feature screen ───
// Shown when an lmi_only user tries to access a full-tier feature.
//
// Note: The primary upgrade prompt is rendered via vanilla JS
// in index.html (showUpgradePrompt function). This React version
// is for any React-rendered contexts that need it.

import React from "react";

const C = {
  pageBg: "#f2ede4", cardBg: "#faf8f4", border: "#ddd4c0",
  textPrimary: "#1a1410", textSecondary: "#7a6a58", textMuted: "#a89880",
  sand: "#c4943a",
};

export function UpgradePrompt({ featureName }) {
  return React.createElement("div", {
    style: {
      display: "flex", alignItems: "center", justifyContent: "center",
      minHeight: "60vh", padding: "20px",
    }
  },
    React.createElement("div", {
      style: {
        background: C.cardBg, border: "1px solid " + C.border,
        borderRadius: "16px", padding: "48px 40px", textAlign: "center",
        maxWidth: "440px", width: "100%",
        boxShadow: "0 2px 12px rgba(0,0,0,0.06)",
      }
    },
      React.createElement("div", {
        style: {
          width: "56px", height: "56px", borderRadius: "50%",
          background: "#f5f0e8", display: "inline-flex",
          alignItems: "center", justifyContent: "center",
          marginBottom: "20px", fontSize: "24px",
        }
      }, "\uD83D\uDD12"),
      React.createElement("h2", {
        style: {
          fontFamily: "'Cormorant Garamond', serif",
          fontSize: "22px", fontWeight: 700, color: C.textPrimary,
          margin: "0 0 10px",
        }
      }, "This feature is part of Loopenta"),
      React.createElement("p", {
        style: {
          fontSize: "14px", color: C.textSecondary,
          lineHeight: 1.6, margin: "0 0 24px",
        }
      }, (featureName || "This feature") + ", Borrower Profiles, and the full CRM suite are available in the Loopenta tier. Contact your administrator to upgrade."),
      React.createElement("a", {
        href: "https://loopenta.com",
        target: "_blank",
        rel: "noopener noreferrer",
        style: {
          display: "inline-block", background: C.sand, color: "white",
          border: "none", borderRadius: "10px", padding: "12px 28px",
          fontSize: "14px", fontWeight: 700, textDecoration: "none",
          cursor: "pointer",
        }
      }, "Learn about Loopenta \u2192"),
      React.createElement("div", {
        style: {
          marginTop: "16px", fontSize: "12px", color: C.textMuted,
        }
      }, "Already upgraded? Contact admin@lmitool.com")
    )
  );
}

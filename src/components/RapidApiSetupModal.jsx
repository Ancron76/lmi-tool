// ── RapidApiSetupModal — shown when RAPIDAPI_KEY is not set ─────
// Mirrors the SMS setup-instructions pattern used elsewhere in the
// app. Presentational only — the host opens/closes it.

import React from "react";

const C = {
  pageBg: "#f2ede4", cardBg: "#faf8f4", border: "#ddd4c0",
  text:   "#1a1410", sub: "#7a6a58", muted: "#a89880",
  sand:   "#c4943a",
};

const STEPS = [
  ["Go to rapidapi.com", "Sign up (free). Email verification takes under a minute."],
  ["Subscribe to Zillow Com1", "Search \"Zillow\" → select \"Zillow Com\". Basic plan is free (20 requests/day)."],
  ["Copy your RapidAPI key", "Dashboard → Default Application → right panel shows the key."],
  ["Add it to the Worker", "Cloudflare → Worker Settings → Variables → add RAPIDAPI_KEY."],
];

export function RapidApiSetupModal({ open, onClose }) {
  if (!open) return null;

  return React.createElement("div", {
    role: "dialog", "aria-modal": "true",
    style: {
      position: "fixed", inset: 0, background: "rgba(26,20,16,0.55)",
      zIndex: 9000, display: "flex", alignItems: "flex-end", justifyContent: "center",
    },
    onClick: onClose,
  },
    React.createElement("div", {
      onClick: e => e.stopPropagation(),
      style: {
        background: C.pageBg, width: "100%", maxWidth: 520,
        maxHeight: "92vh", overflowY: "auto",
        borderTopLeftRadius: 18, borderTopRightRadius: 18,
        padding: "22px 18px 28px",
      },
    },
      React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 } },
        React.createElement("h2", {
          style: { fontFamily: "'Cormorant Garamond', serif", fontSize: 22, fontWeight: 700, color: C.text, margin: 0 },
        }, "Enable Zillow Enrichment"),
        React.createElement("button", {
          onClick: onClose,
          style: { minHeight: 44, minWidth: 44, background: "transparent", border: "none", fontSize: 22, color: C.sub, cursor: "pointer" },
          "aria-label": "Close",
        }, "✕"),
      ),

      React.createElement("p", { style: { fontSize: 14, color: C.sub, lineHeight: 1.55, marginBottom: 16 } },
        "The Property Intelligence engine works without Zillow — county assessor, HUD, HomePath and deed data still load. Zillow adds list prices, photos, and listing-agent contacts."
      ),

      STEPS.map((step, i) =>
        React.createElement("div", {
          key: i,
          style: {
            background: C.cardBg, border: "1px solid " + C.border,
            borderRadius: 12, padding: 14, marginBottom: 10,
            display: "flex", gap: 12, alignItems: "flex-start",
          },
        },
          React.createElement("div", {
            style: {
              width: 28, height: 28, borderRadius: "50%",
              background: C.sand, color: "white", fontWeight: 700,
              display: "flex", alignItems: "center", justifyContent: "center",
              flexShrink: 0, fontSize: 13,
            },
          }, String(i + 1)),
          React.createElement("div", { style: { flex: 1, minWidth: 0 } },
            React.createElement("div", { style: { fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 3 } }, step[0]),
            React.createElement("div", { style: { fontSize: 13, color: C.sub, lineHeight: 1.5 } }, step[1])
          )
        )
      ),

      React.createElement("div", {
        style: {
          background: "#f5f0e8", border: "1px solid " + C.border,
          borderRadius: 12, padding: 12, marginTop: 6, marginBottom: 18,
          fontSize: 12, color: C.sub, lineHeight: 1.5,
        },
      },
        React.createElement("strong", { style: { color: C.text } }, "Pricing note: "),
        "Free tier gives 20 Zillow lookups/day. At $10/month you get unlimited lookups. The engine caches results for 24 hours to minimize API calls."
      ),

      React.createElement("a", {
        href: "https://rapidapi.com/apimaker/api/zillow-com1",
        target: "_blank", rel: "noopener noreferrer",
        style: {
          display: "block", textAlign: "center",
          background: C.sand, color: "white",
          padding: "12px 20px", borderRadius: 10,
          fontSize: 14, fontWeight: 700, textDecoration: "none",
          minHeight: 44,
        },
      }, "Open RapidAPI → Zillow Com1 →")
    )
  );
}

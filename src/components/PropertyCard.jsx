// ── PropertyCard — individual property cell ─────────────────────
// Mobile-first card showing score, photo, core facts, source pills,
// listing agent (if any), and three primary actions.
//
// The onAction callbacks are intentionally plumbed to the host app
// so this component stays presentation-only. The host wires them to
// the existing Add Realtor / OYZ / LMI pre-screen flows.

import React from "react";

const C = {
  cardBg:  "#faf8f4", border: "#ddd4c0",
  text:    "#1a1410", sub: "#7a6a58", muted: "#a89880",
  sand:    "#c4943a", ocean: "#7a9eaa", positive: "#5a8a6a",
  warning: "#b07030", negative: "#9a4a3a",
};

const SCORE_STYLE = (score) => {
  if (score >= 80) return { bg: "#eef4f0", fg: "#5a8a6a" };
  if (score >= 50) return { bg: "#faf0e4", fg: "#b07030" };
  return               { bg: "#f5f1ec", fg: "#9e8e7a" };
};

const SOURCE_STYLE = {
  hud:              { label: "HUD",              bg: "#eef4f0", fg: "#5a8a6a" },
  homepath:         { label: "HomePath",         bg: "#eef4f0", fg: "#5a8a6a" },
  homesteps:        { label: "HomeSteps",        bg: "#eef4f0", fg: "#5a8a6a" },
  zillow_for_sale:  { label: "Zillow: For Sale", bg: "#f0f4ff", fg: "#2563eb" },
  deed_recording:   { label: "Recent Transfer",  bg: "#faf0e4", fg: "#b07030" },
  craigslist:       { label: "Craigslist",       bg: "#f5f1ec", fg: "#9e8e7a" },
  ca_assessor:      { label: "Assessor",         bg: "#f5f1ec", fg: "#9e8e7a" },
  la_county_assessor: { label: "LA Assessor",    bg: "#f5f1ec", fg: "#9e8e7a" },
};

function pill(style, key) {
  return React.createElement("span", {
    key,
    style: {
      display: "inline-block",
      background: style.bg, color: style.fg,
      padding: "3px 9px", borderRadius: "99px",
      fontSize: "11px", fontWeight: 700, whiteSpace: "nowrap",
      marginRight: 6, marginBottom: 4,
    },
  }, style.label);
}

function fmtPrice(n) {
  if (!Number.isFinite(n) || !n) return null;
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000)     return "$" + Math.round(n / 1_000) + "K";
  return "$" + n.toLocaleString();
}

export function PropertyCard({ property, onAddRealtor, onScheduleOpenHouse, onLmiPreScreen, lmiBadgeSlot }) {
  const p = property || {};
  const z = p.zillowData || {};
  const score = Math.round(p.score || 0);
  const scoreStyle = SCORE_STYLE(score);
  const price = z.listPrice || p.govListing?.price || p.assessedValue || p.lastSalePrice;
  const photo = (z.photos || [])[0];

  const sources = [];
  if (p.govListing?.source && SOURCE_STYLE[p.govListing.source]) sources.push(SOURCE_STYLE[p.govListing.source]);
  if (z.isForSale) sources.push(SOURCE_STYLE.zillow_for_sale);
  if (p.deedInfo)  sources.push(SOURCE_STYLE.deed_recording);
  if (p.source && SOURCE_STYLE[p.source] && !sources.some(s => s.label === SOURCE_STYLE[p.source].label)) {
    sources.push(SOURCE_STYLE[p.source]);
  }

  return React.createElement("div", {
    style: {
      background: C.cardBg, border: "1px solid " + C.border,
      borderRadius: 14, padding: 14, marginBottom: 12,
      boxShadow: "0 1px 3px rgba(0,0,0,.04)",
    },
  },
    // ── top row ──────────────────────────────────────────────
    React.createElement("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, marginBottom: 10 } },
      React.createElement("div", { style: { fontSize: 14, fontWeight: 700, color: C.text, flex: 1, minWidth: 0, wordBreak: "break-word" } },
        p.address || "(no address on record)"
      ),
      React.createElement("span", {
        style: {
          background: scoreStyle.bg, color: scoreStyle.fg,
          padding: "4px 10px", borderRadius: 99,
          fontSize: 11, fontWeight: 700, whiteSpace: "nowrap",
        },
      }, "Score: " + score)
    ),

    // ── photo ────────────────────────────────────────────────
    photo && React.createElement("img", {
      src: photo, alt: "",
      style: { width: "100%", height: 140, objectFit: "cover", borderRadius: 8, marginBottom: 10, background: "#eee" },
      loading: "lazy",
    }),

    // ── data row ─────────────────────────────────────────────
    React.createElement("div", { style: { fontSize: 13, color: C.sub, marginBottom: 4 } },
      [z.beds || p.beds, z.baths || p.baths, z.sqft || p.sqft, z.yearBuilt || p.yearBuilt]
        .map((v, i) => {
          const labels = ["bd", "ba", "sqft", ""];
          if (v == null || v === "") return null;
          return i === 2 ? Number(v).toLocaleString() + " sqft"
               : i === 3 ? "Built " + v
               : v + " " + labels[i];
        })
        .filter(Boolean)
        .join(" · ")
    ),
    price && React.createElement("div", { style: { fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 4 } }, fmtPrice(price)),
    z.daysOnMarket != null && React.createElement("div", { style: { fontSize: 12, color: C.muted, marginBottom: 8 } }, z.daysOnMarket + " days on market"),

    // ── source pills ─────────────────────────────────────────
    sources.length > 0 && React.createElement("div", { style: { marginBottom: 10, overflowX: "auto", whiteSpace: "nowrap" } },
      sources.map((s, i) => pill(s, i))
    ),

    // ── listing agent ────────────────────────────────────────
    p.listingAgent && React.createElement("div", {
      style: { fontSize: 12, color: C.sub, marginBottom: 10, padding: "8px 10px", background: "#f5f0e8", borderRadius: 8 },
    },
      React.createElement("div", { style: { fontWeight: 700, color: C.text } }, "👤 " + p.listingAgent),
      z.brokerage && React.createElement("div", null, z.brokerage),
      p.agentPhone && React.createElement("a", { href: "tel:" + p.agentPhone, style: { color: C.ocean, textDecoration: "none" } }, p.agentPhone)
    ),

    // ── LMI slot (host renders <LmiBadge />) ─────────────────
    lmiBadgeSlot && React.createElement("div", { style: { marginBottom: 10 } }, lmiBadgeSlot),

    // ── actions ──────────────────────────────────────────────
    React.createElement("div", { style: { display: "grid", gridTemplateColumns: "1fr", gap: 6 } },
      React.createElement("button", {
        onClick: () => onAddRealtor && onAddRealtor(p),
        disabled: !p.listingAgent,
        style: actionBtn(p.listingAgent ? C.sand : C.muted, p.listingAgent),
      }, "+ Add Agent as Realtor"),
      React.createElement("button", {
        onClick: () => onScheduleOpenHouse && onScheduleOpenHouse(p),
        style: actionBtn(C.ocean, true),
      }, "📅 Schedule Open House"),
      React.createElement("button", {
        onClick: () => onLmiPreScreen && onLmiPreScreen(p),
        style: actionBtn(C.positive, true),
      }, "🏠 LMI Pre-Screen"),
    )
  );
}

function actionBtn(color, enabled) {
  return {
    minHeight: 44,
    background: enabled ? color : "#d6cfc3",
    color: "white", border: "none", borderRadius: 10,
    padding: "10px 14px", fontSize: 13, fontWeight: 700,
    cursor: enabled ? "pointer" : "not-allowed",
    fontFamily: "inherit",
  };
}

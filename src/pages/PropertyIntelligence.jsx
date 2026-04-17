// ── PropertyIntelligence — tract-level property view ─────────────
// Ties together:
//   • usePropertyIntelligence (Worker call)
//   • PropertyViewSwitcher (All | Likely | Active)
//   • PropertyCard (per-property render)
//   • HmdaInsightsPanel (lending intel)
//
// Props:
//   tractId, zip, county   — query params from the LMI Search page
//   cityName               — optional, for header subtitle
//   onBack                 — back-to-search handler
//   onAddRealtor, onScheduleOpenHouse, onLmiPreScreen
//     — callbacks plumbed down to each card; host wires these to the
//       existing Add Realtor / OYZ / LMI auto-screen flows.

import React, { useMemo, useState } from "react";
import { usePropertyIntelligence } from "../hooks/usePropertyIntelligence";
import { PropertyCard } from "../components/PropertyCard";
import { PropertyViewSwitcher } from "../components/PropertyViewSwitcher";
import { HmdaInsightsPanel } from "../components/HmdaInsightsPanel";

const C = {
  pageBg: "#f2ede4", cardBg: "#faf8f4", border: "#ddd4c0",
  text:   "#1a1410", sub: "#7a6a58", muted: "#a89880",
  sand:   "#c4943a", ocean: "#7a9eaa", positive: "#5a8a6a",
};

function summaryPill(num, label, color) {
  return React.createElement("div", {
    style: {
      flex: "0 0 auto",
      background: C.cardBg, border: "1px solid " + C.border,
      borderRadius: 12, padding: "10px 14px",
      minWidth: 110, textAlign: "left",
    },
  },
    React.createElement("div", { style: { fontSize: 18, fontWeight: 800, color: color || C.text, fontFamily: "'Cormorant Garamond', serif" } }, num),
    React.createElement("div", { style: { fontSize: 11, color: C.sub, textTransform: "uppercase", letterSpacing: 0.4 } }, label)
  );
}

function skeletonCard(i) {
  return React.createElement("div", {
    key: "skel-" + i,
    style: {
      background: C.cardBg, border: "1px solid " + C.border,
      borderRadius: 14, padding: 14, marginBottom: 12,
    },
  },
    React.createElement("div", { style: { height: 14, width: "65%", background: "#efe9dd", borderRadius: 4, marginBottom: 10, animation: "skeletonPulse 1.5s ease-in-out infinite" } }),
    React.createElement("div", { style: { height: 120, background: "#efe9dd", borderRadius: 8, marginBottom: 10, animation: "skeletonPulse 1.5s ease-in-out infinite" } }),
    React.createElement("div", { style: { height: 12, width: "45%", background: "#efe9dd", borderRadius: 4, animation: "skeletonPulse 1.5s ease-in-out infinite" } }),
  );
}

export function PropertyIntelligence({
  tractId, zip, county, cityName,
  onBack, onAddRealtor, onScheduleOpenHouse, onLmiPreScreen,
}) {
  const { data, loading, error, status } = usePropertyIntelligence(tractId, zip, county);
  const [view, setView] = useState("all");

  const filtered = useMemo(() => {
    const props = data?.properties || [];
    if (view === "confirmed") return props.filter(p => p.isConfirmed);
    if (view === "likely")    return props.filter(p => p.isLikelyToList);
    return props;
  }, [data, view]);

  const counts = useMemo(() => {
    const props = data?.properties || [];
    return {
      all:       props.length,
      likely:    props.filter(p => p.isLikelyToList).length,
      confirmed: props.filter(p => p.isConfirmed).length,
    };
  }, [data]);

  const s = data?.summary || {};
  const hmda = data?.hmdaInsights || {};
  const craScore = s.craOpportunityScore || 0;
  const banner = craScore > 60 ? {
    bg: "#eef4f0", fg: "#5a8a6a",
    text: `🎯 High CRA Opportunity — only ${s.approvalRate || 0}% approval rate in this tract with ${s.activeLenders || 0} active lenders`,
  } : craScore < 30 && s.totalHmdaLoans > 0 ? {
    bg: "#f5f0e8", fg: "#7a6a58",
    text: `This tract has ${s.approvalRate || 0}% approval rate with ${s.activeLenders || 0} active lenders`,
  } : null;

  return React.createElement("div", { style: { background: C.pageBg, minHeight: "100vh", padding: "12px 14px 28px", fontFamily: "'DM Sans', sans-serif" } },

    // ── header ──────────────────────────────────────────────
    React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 10, marginBottom: 10 } },
      React.createElement("button", {
        onClick: onBack,
        style: { minWidth: 44, minHeight: 44, border: "none", background: "transparent", color: C.text, fontSize: 22, cursor: "pointer" },
        "aria-label": "Back to search",
      }, "←"),
      React.createElement("div", { style: { flex: 1, minWidth: 0 } },
        React.createElement("h1", { style: { fontFamily: "'Cormorant Garamond', serif", fontSize: 20, fontWeight: 700, color: C.text, margin: 0, lineHeight: 1.2 } }, "Properties · Tract " + (tractId || "")),
        React.createElement("div", { style: { fontSize: 12, color: C.sub } }, "ZIP " + (zip || "") + (cityName ? " · " + cityName : ""))
      )
    ),

    // ── summary pills ───────────────────────────────────────
    !loading && !error && React.createElement("div", {
      style: { display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4, marginBottom: 10, WebkitOverflowScrolling: "touch" },
    },
      summaryPill(s.confirmedListings || 0, "Active Listings", C.positive),
      summaryPill(s.likelyToListCount || 0, "Likely to List",  C.sand),
      summaryPill(s.governmentOwned   || 0, "Gov. Owned",      C.ocean),
      summaryPill((s.craOpportunityScore || 0) + "/100", "CRA Score", C.text)
    ),

    // ── HMDA banner ─────────────────────────────────────────
    banner && React.createElement("div", {
      style: {
        background: banner.bg, color: banner.fg,
        padding: "10px 12px", borderRadius: 10,
        fontSize: 13, lineHeight: 1.45, marginBottom: 12, fontWeight: 600,
      },
    }, banner.text),

    // ── view switcher ──────────────────────────────────────
    !loading && !error && React.createElement(PropertyViewSwitcher, { view, counts, onChange: setView }),

    // ── loading state ──────────────────────────────────────
    loading && React.createElement("div", null,
      React.createElement("div", {
        style: { fontSize: 13, color: C.sub, marginBottom: 10, textAlign: "center" },
      }, status),
      [0, 1, 2].map(skeletonCard)
    ),

    // ── error state ────────────────────────────────────────
    error && React.createElement("div", {
      style: {
        background: "#faf0e4", color: "#b07030",
        padding: 14, borderRadius: 12, fontSize: 13, marginTop: 8,
      },
    }, "⚠ Could not load property intelligence: " + error),

    // ── empty state ────────────────────────────────────────
    !loading && !error && filtered.length === 0 && React.createElement("div", {
      style: {
        background: C.cardBg, border: "1px solid " + C.border,
        borderRadius: 12, padding: 22, textAlign: "center",
        color: C.sub, fontSize: 13,
      },
    }, "No properties in this view yet. The engine is still gathering data for this tract — try again in a few hours."),

    // ── property list ──────────────────────────────────────
    !loading && !error && filtered.map((p, i) =>
      React.createElement(PropertyCard, {
        key: (p.apn || p.address || "p") + "-" + i,
        property: p,
        onAddRealtor,
        onScheduleOpenHouse,
        onLmiPreScreen,
      })
    ),

    // ── HMDA panel ──────────────────────────────────────────
    !loading && !error && s.totalHmdaLoans > 0 && React.createElement(HmdaInsightsPanel, { hmda })
  );
}

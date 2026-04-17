// ── PropertyViewSwitcher — 3-tab filter above the property list ─
// All Properties | Likely to List | Active Listings
//
// Purely presentational. Host owns the active view state.

import React from "react";

const VIEWS = [
  { id: "all",       label: "All Properties"  },
  { id: "likely",    label: "Likely to List"  },
  { id: "confirmed", label: "Active Listings" },
];

export function PropertyViewSwitcher({ view, counts, onChange }) {
  return React.createElement("div", {
    style: {
      display: "flex", gap: 6, padding: "4px",
      background: "#f5f0e8", borderRadius: 10,
      marginBottom: 14, overflowX: "auto",
    },
  },
    VIEWS.map(v => {
      const active = view === v.id;
      const count  = counts?.[v.id];
      return React.createElement("button", {
        key: v.id,
        onClick: () => onChange(v.id),
        style: {
          minHeight: 36, flex: "1 1 auto", whiteSpace: "nowrap",
          background: active ? "#c4943a" : "transparent",
          color:      active ? "white"   : "#7a6a58",
          border: "none", borderRadius: 8,
          padding: "8px 12px", fontSize: 13, fontWeight: 700,
          cursor: "pointer", fontFamily: "inherit",
        },
      },
        v.label,
        count != null && React.createElement("span", {
          style: { opacity: 0.75, fontSize: 11, marginLeft: 6 },
        }, "(" + count + ")")
      );
    })
  );
}

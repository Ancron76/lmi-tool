// ── HmdaInsightsPanel — collapsible lending-intelligence block ──
// Shows tract-level CFPB HMDA stats. Renders a simple bar comparing
// this tract's approval rate to a CA benchmark (default 65%, which
// is roughly the statewide purchase-loan origination rate from the
// most recent HMDA vintage — callers can override via `caBenchmark`).

import React, { useState } from "react";

const C = {
  cardBg: "#faf8f4", border: "#ddd4c0",
  text:   "#1a1410", sub: "#7a6a58", muted: "#a89880",
  sand:   "#c4943a", positive: "#5a8a6a", warning: "#b07030",
};

function row(label, value) {
  return React.createElement("div", { style: { display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #efe9dd", fontSize: 13 } },
    React.createElement("span", { style: { color: C.sub } }, label),
    React.createElement("span", { style: { color: C.text, fontWeight: 700 } }, value)
  );
}

export function HmdaInsightsPanel({ hmda, caBenchmark = 65 }) {
  const [open, setOpen] = useState(true);
  const h = hmda || {};
  const rate = Math.round(h.approvalRate || 0);
  const diff = rate - caBenchmark;

  return React.createElement("div", {
    style: {
      background: C.cardBg, border: "1px solid " + C.border,
      borderRadius: 14, padding: 14, marginTop: 16,
    },
  },
    React.createElement("button", {
      onClick: () => setOpen(!open),
      style: {
        minHeight: 44, width: "100%", display: "flex",
        justifyContent: "space-between", alignItems: "center",
        background: "transparent", border: "none",
        padding: 0, cursor: "pointer", fontFamily: "inherit",
        color: C.text, fontSize: 14, fontWeight: 700,
      },
    },
      "📊 Lending Intelligence for This Tract",
      React.createElement("span", { style: { color: C.muted, fontSize: 18 } }, open ? "−" : "+")
    ),

    open && React.createElement("div", { style: { marginTop: 12 } },
      row("Loan applications last year", (h.totalApplications || 0).toLocaleString()),
      row("Approval rate",                rate + "%"),
      row("Active lenders",               (h.lenders || 0).toLocaleString()),
      row("Avg loan amount",              h.avgLoanAmount ? "$" + Number(h.avgLoanAmount).toLocaleString() : "—"),
      row("Minority population",          h.minorityPct != null ? Math.round(h.minorityPct) + "%" : "—"),
      row("CRA opportunity score",        (h.craOpportunityScore || 0) + "/100"),

      // ── benchmark bar ──
      React.createElement("div", { style: { marginTop: 14, fontSize: 12, color: C.sub } },
        "This tract's approval rate is " + rate + "% vs CA avg " + caBenchmark + "%"
      ),
      React.createElement("div", {
        style: { position: "relative", height: 10, background: "#efe9dd", borderRadius: 99, marginTop: 8, overflow: "hidden" },
      },
        React.createElement("div", {
          style: {
            width: Math.min(100, rate) + "%", height: "100%",
            background: diff >= 0 ? C.positive : C.warning,
            borderRadius: 99, transition: "width .4s",
          },
        }),
        // benchmark marker
        React.createElement("div", {
          style: {
            position: "absolute", top: -3, bottom: -3,
            left: `calc(${Math.min(100, caBenchmark)}% - 1px)`,
            width: 2, background: C.text, opacity: 0.55,
          },
        })
      )
    )
  );
}

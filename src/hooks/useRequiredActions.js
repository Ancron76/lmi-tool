import { useState, useEffect } from "react";
import { collection, doc, getDoc, getDocs, query, where } from "firebase/firestore";
import { db } from "../firebase";

// ── Tier gating ─────────────────────────────────────────────────
// Mirrors the vanilla-JS implementation in index.html (_loadTier +
// hasFeature). Full-tier checks (pipeline, contacts CRM, sequences,
// communications, past-customer refi, mlo_scorecards) are skipped
// for lmi_only tenants so the LMI Tool product stays focused on
// its own feature set.
const TIER_FEATURES = {
  lmi_only: [
    "lmi_search", "oyz_open_houses", "analytics", "cra_reports",
    "activity_log", "dashboard", "marketing", "realtor_basic",
    "notifications",
  ],
  full: [
    "deal_pipeline", "borrowers", "contacts_full", "communications",
    "realtor_scorecard", "sequences", "past_customers", "refi_alerts",
    "mlo_scorecards", "leaderboard", "lmi_auto_screen",
  ],
};

function hasFeature(tier, feature) {
  if (tier === "full") {
    return TIER_FEATURES.lmi_only.indexOf(feature) !== -1 ||
           TIER_FEATURES.full.indexOf(feature) !== -1;
  }
  return TIER_FEATURES.lmi_only.indexOf(feature) !== -1;
}

export function useRequiredActions(uid, tenantId) {
  const [actions, setActions] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!uid) return;

    async function fetchActions() {
      setLoading(true);

      // Resolve tier. Prefer the tenantId arg; fall back to the
      // window._currentTier global that the vanilla-JS loader sets
      // after login; final fallback is lmi_only (the safe product).
      let tier = "lmi_only";
      if (tenantId) {
        try {
          const tSnap = await getDoc(doc(db, "tenants", tenantId));
          if (tSnap.exists()) tier = tSnap.data()?.tier || "lmi_only";
        } catch (e) { /* fall through to global */ }
      } else if (typeof window !== "undefined" && window._currentTier) {
        tier = window._currentTier;
      }

      const results = [];
      const now = new Date();
      const in7Days   = new Date(now.getTime() + 7  * 24 * 60 * 60 * 1000);
      const ago14Days = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

      // 1. Deal Pipeline — rate lock expiring within 7 days (full tier only)
      if (hasFeature(tier, "deal_pipeline")) {
        try {
          const snap = await getDocs(collection(db, "deals"));
          snap.forEach(doc => {
            const d = doc.data();
            if (d.stage === "Closed" || d.stage === "Lost") return;
            if (!d.rateLockExpiry) return;
            const expiry = d.rateLockExpiry.toDate ? d.rateLockExpiry.toDate() : new Date(d.rateLockExpiry);
            if (expiry <= in7Days && expiry >= now) {
              const daysLeft = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
              results.push({
                priority: daysLeft <= 2 ? "high" : "med",
                label: `Rate lock expires in ${daysLeft} day${daysLeft !== 1 ? "s" : ""}`,
                detail: `${d.borrowerName || "Deal"} — ${d.loanAmount ? "$" + Number(d.loanAmount).toLocaleString() : ""}`,
                module: "Deal Pipeline", moduleIc: "pipe", moduleColor: "#7a9eaa",
                navTarget: `/pipeline?deal=${doc.id}`, docId: doc.id,
              });
            }
          });
        } catch (e) { console.warn("deals", e); }
      }

      // 2. Pre-qual requests — pending (full tier only — contacts CRM)
      if (hasFeature(tier, "contacts_full")) {
        try {
          const snap = await getDocs(
            query(collection(db, "prequal"), where("status", "==", "pending"))
          );
          snap.forEach(doc => {
            const d = doc.data();
            results.push({
              priority: "high",
              label: "Pre-qual request pending review",
              detail: `Submitted by: ${d.realtorName || d.submittedBy || "Realtor"}`,
              module: "Contacts", moduleIc: "contacts", moduleColor: "#7a9eaa",
              navTarget: `/contacts?prequal=${doc.id}`, docId: doc.id,
            });
          });
        } catch (e) { console.warn("prequal", e); }
      }

      // 3. Realtors — overdue follow-up (>14 days)
      try {
        const snap = await getDocs(collection(db, "realtors"));
        snap.forEach(doc => {
          const d = doc.data();
          if (!d.lastContact) return;
          const last = d.lastContact.toDate ? d.lastContact.toDate() : new Date(d.lastContact);
          if (last <= ago14Days) {
            const daysAgo = Math.floor((now - last) / (1000 * 60 * 60 * 24));
            results.push({
              priority: "med",
              label: `Realtor follow-up overdue · ${daysAgo}d`,
              detail: `${d.name || "Realtor"} — ${d.area || d.territory || d.city || ""}`,
              module: "Realtors", moduleIc: "realtors", moduleColor: "#c4943a",
              navTarget: `/realtors?id=${doc.id}`, docId: doc.id,
            });
          }
        });
      } catch (e) { console.warn("realtors", e); }

      // 4. Open houses — past events without submitted report
      try {
        const snap = await getDocs(collection(db, "oyz"));
        snap.forEach(doc => {
          const d = doc.data();
          if (d.reportSubmitted === true) return;
          const eventDate = d.openHouseDate
            ? (d.openHouseDate.toDate ? d.openHouseDate.toDate() : new Date(d.openHouseDate))
            : null;
          if (!eventDate || eventDate >= now) return;
          results.push({
            priority: "med",
            label: "Open house report not submitted",
            detail: `${d.propertyAddress || d.streetAddress || "Event"} — ${eventDate.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`,
            module: "Open Houses", moduleIc: "house", moduleColor: "#5a8a6a",
            navTarget: `/open-houses?id=${doc.id}`, docId: doc.id,
          });
        });
      } catch (e) { console.warn("oyz", e); }

      // 5. Activity log — unlogged CRA activities
      try {
        const snap = await getDocs(collection(db, "activity"));
        const unlogged = snap.docs.filter(doc => {
          const d = doc.data();
          return d.logged !== true && (d.craQualifying === true || d.type === "cra" || d.type === "lmi_outreach");
        });
        if (unlogged.length > 0) {
          results.push({
            priority: "med",
            label: `${unlogged.length} CRA activit${unlogged.length === 1 ? "y" : "ies"} unlogged`,
            detail: `${unlogged.length} entr${unlogged.length === 1 ? "y needs" : "ies need"} submission`,
            module: "Activity Log", moduleIc: "log", moduleColor: "#9e8e7a",
            navTarget: "/activity-log?filter=unlogged", docId: "actlog",
          });
        }
      } catch (e) { console.warn("activities", e); }

      // 6. Communications — unread notifications (full tier only)
      if (hasFeature(tier, "communications")) {
        try {
          const snap = await getDocs(collection(db, "notifications"));
          const unread = snap.docs.filter(doc => {
            const d = doc.data();
            return d.read !== true && (!d.userId || d.userId === uid);
          });
          if (unread.length > 0) {
            results.push({
              priority: "low",
              label: `${unread.length} unread message${unread.length === 1 ? "" : "s"}`,
              detail: `Communications inbox · ${unread.length} unread`,
              module: "Communications", moduleIc: "comms", moduleColor: "#b07030",
              navTarget: "/communications?filter=unread", docId: "comms",
            });
          }
        } catch (e) { console.warn("notifications", e); }
      }

      // 7. Stuck deals — deals sitting in same stage too long (full tier only)
      if (hasFeature(tier, "deal_pipeline")) {
        try {
          const prefsDoc = await getDocs(collection(db, "users"));
          let threshold = 3;
          prefsDoc.forEach(doc => {
            if (doc.id === uid && doc.data()?.preferences?.stuckThresholdDays) {
              threshold = doc.data().preferences.stuckThresholdDays;
            }
          });
          const dealsSnap = await getDocs(collection(db, "deals"));
          dealsSnap.forEach(doc => {
            const d = doc.data();
            if (!d.stageUpdatedAt) return;
            if (d.stage === "Funded" || d.stage === "Dead/Lost") return;
            const updated = d.stageUpdatedAt.toDate ? d.stageUpdatedAt.toDate() : new Date(d.stageUpdatedAt);
            const daysStuck = Math.floor((new Date() - updated) / 86400000);
            if (daysStuck >= threshold) {
              results.push({
                priority: daysStuck >= threshold * 2 ? "high" : "med",
                label: `${d.borrowerName || "Deal"} stuck in ${d.stage} · ${daysStuck}d`,
                detail: d.loanAmount ? `$${Number(d.loanAmount).toLocaleString()}` : "",
                module: "Deal Pipeline", moduleIc: "pipe", moduleColor: "#7a9eaa",
                navTarget: `/pipeline?deal=${doc.id}`, docId: doc.id,
              });
            }
          });
        } catch (e) { console.warn("stuck deals", e); }
      }

      // 8. Cold realtors — no contact in 60+ days
      try {
        const rSnap = await getDocs(collection(db, "realtors"));
        const sixtyDaysAgo = new Date(now.getTime() - 60 * 86400000);
        rSnap.forEach(doc => {
          const r = doc.data();
          if (!r.lastContact) return;
          const last = r.lastContact.toDate ? r.lastContact.toDate() : new Date(r.lastContact);
          if (last <= sixtyDaysAgo) {
            const daysSince = Math.floor((now - last) / 86400000);
            results.push({
              priority: "low",
              label: `${r.name || "Realtor"} partnership going cold · ${daysSince}d`,
              detail: `No contact or referral in ${daysSince} days`,
              module: "Realtors", moduleIc: "realtors", moduleColor: "#c4943a",
              navTarget: `/realtors?id=${doc.id}`, docId: doc.id,
            });
          }
        });
      } catch (e) { console.warn("cold realtors", e); }

      const order = { high: 0, med: 1, low: 2 };
      results.sort((a, b) => order[a.priority] - order[b.priority]);
      setActions(results);
      setLoading(false);
    }

    fetchActions();
  }, [uid, tenantId]);

  return { actions, loading };
}

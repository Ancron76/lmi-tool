// ── useTier hook ────────────────────────────────────────────────
// Reads the product tier from Firestore tenants collection.
// Returns { tier, isFullTier, isLmiOnly, loading }
//
// Note: In this app, the tier is primarily loaded via vanilla JS
// (_loadTier in index.html) and stored in _currentTier global.
// This hook is for React components that need tier reactively.

import { useState, useEffect } from "react";
import { doc, getDoc } from "firebase/firestore";
import { db } from "../firebase";

export function useTier(tenantId) {
  const [tier, setTier] = useState("lmi_only"); // safe default
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!tenantId) return;
    getDoc(doc(db, "tenants", tenantId)).then(snap => {
      if (snap.exists()) {
        setTier(snap.data()?.tier || "lmi_only");
      }
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [tenantId]);

  const isFullTier = tier === "full";
  const isLmiOnly  = tier === "lmi_only";

  return { tier, isFullTier, isLmiOnly, loading };
}

import { useState, useEffect } from "react";
import { doc, getDoc } from "firebase/firestore";
import { db } from "../firebase";

export function useFeatureFlags(tenantId) {
  const [flags, setFlags] = useState({
    smsEnabled: false, // default off until explicitly enabled
  });

  useEffect(() => {
    if (!tenantId) return;
    getDoc(doc(db, "tenants", tenantId)).then(snap => {
      if (snap.exists()) {
        setFlags(prev => ({
          ...prev,
          ...(snap.data()?.features || {}),
        }));
      }
    });
  }, [tenantId]);

  return flags;
}

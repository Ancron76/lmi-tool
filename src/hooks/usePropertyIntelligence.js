// ── usePropertyIntelligence ──────────────────────────────────────
// Fetches a tract's unified property intelligence from the Cloudflare
// Worker orchestrator at PROXY_URL + /property-intelligence. Returns
// { data, loading, error, status } where `status` cycles through the
// human-readable loading messages shown in the mobile skeleton.

import { useEffect, useState } from "react";

// Match the vanilla-JS global defined in index.html so this hook
// stays in lock-step with the rest of the app without a hard import.
const DEFAULT_PROXY =
  (typeof window !== "undefined" && window.PROXY_URL) ||
  "https://lmi-proxy.aaronsimonson.workers.dev";

const STATUS_CYCLE = [
  "Checking county assessor records…",
  "Searching government listings…",
  "Analyzing lending patterns…",
  "Enriching with market data…",
];

export function usePropertyIntelligence(tractId, zip, county) {
  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);
  const [status,  setStatus]  = useState(STATUS_CYCLE[0]);

  useEffect(() => {
    if (!tractId || !zip) return;
    let cancelled = false;
    let statusTimer = null;

    setLoading(true);
    setError(null);
    setData(null);
    setStatus(STATUS_CYCLE[0]);

    // Rotate the status line every 1.4s so the skeleton feels alive.
    let idx = 0;
    statusTimer = setInterval(() => {
      idx = (idx + 1) % STATUS_CYCLE.length;
      if (!cancelled) setStatus(STATUS_CYCLE[idx]);
    }, 1400);

    const params = new URLSearchParams({ tractId, zip });
    if (county) params.set("county", county);

    fetch(`${DEFAULT_PROXY}/property-intelligence?${params.toString()}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then(json => { if (!cancelled) setData(json); })
      .catch(e    => { if (!cancelled) setError(e.message || "Request failed"); })
      .finally(() => {
        if (statusTimer) clearInterval(statusTimer);
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      if (statusTimer) clearInterval(statusTimer);
    };
  }, [tractId, zip, county]);

  return { data, loading, error, status };
}

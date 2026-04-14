import { useState, useCallback } from "react";

const PROXY_URL = "https://lmi-proxy.aaronsimonson.workers.dev";

export function useLmiLookup() {
  const [lmiResult, setLmiResult] = useState(null);

  const lookup = useCallback(async (address) => {
    if (!address || address.trim().length < 8) return;

    const zipMatch = address.match(/\b\d{5}\b/);
    if (!zipMatch) return;
    const zip = zipMatch[0];

    setLmiResult({ loading: true, eligible: null });

    try {
      const res = await fetch(`${PROXY_URL}?zip=${zip}`);
      const data = await res.json();
      if (!data || !data.length) {
        setLmiResult({ loading: false, eligible: null, error: false });
        return;
      }

      const tract = data[0];
      const tractId = tract.tract_id || tract.census_tract || "";
      const incomeRatio = tract.income_ratio || null;
      const eligible =
        tract.lmi_status === true ||
        (incomeRatio && incomeRatio <= 80) ||
        (tract.lmi_category &&
          (tract.lmi_category.indexOf("Low") !== -1 ||
            tract.lmi_category.indexOf("Moderate") !== -1));

      setLmiResult({
        loading: false,
        eligible,
        tractId,
        incomeRatio,
        tractName: tract.tract_name || "",
        error: false,
      });
    } catch (e) {
      console.warn("LMI lookup failed", e);
      setLmiResult({ loading: false, eligible: null, error: true });
    }
  }, []);

  const reset = useCallback(() => setLmiResult(null), []);

  return { lmiResult, lookup, reset };
}

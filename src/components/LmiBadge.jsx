const C = {
  positiveBg: "#eef4f0", positiveBorder: "#b8d4be", positiveText: "#3a6a4a",
  positive: "#5a8a6a", ocean: "#7a9eaa", oceanText: "#5a8a9e",
  neutralBg: "#f5f1ec", neutralBorder: "#ddd4c0", neutralText: "#7a6a58",
  muted: "#a89880",
};

export function LmiBadge({ lmiResult, onLogCRA, onEnrollSequence, compact = false }) {
  if (!lmiResult) return null;

  if (lmiResult.loading) {
    return (
      <div style={{ fontSize: 12, color: C.muted, padding: "6px 0" }}>
        Checking LMI status...
      </div>
    );
  }

  if (lmiResult.error || lmiResult.eligible === null) return null;

  if (lmiResult.eligible) {
    return (
      <div style={{ background: C.positiveBg, border: `1px solid ${C.positiveBorder}`, borderRadius: 10, padding: compact ? "6px 10px" : "10px 14px", marginTop: compact ? 0 : 6 }}>
        <div style={{ fontSize: compact ? 11 : 13, fontWeight: 700, color: C.positiveText }}>
          ✓ LMI Eligible · Tract {lmiResult.tractId}
        </div>
        {!compact && lmiResult.incomeRatio && (
          <div style={{ fontSize: 11, color: C.positive, marginTop: 2 }}>
            Income ratio: {lmiResult.incomeRatio}% of AMI
          </div>
        )}
        {!compact && (
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            {onLogCRA && (
              <button onClick={onLogCRA} style={{ background: C.positiveBg, border: `1px solid ${C.positive}`, color: C.positive, borderRadius: 8, padding: "7px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", minHeight: 36 }}>
                Log as CRA Activity
              </button>
            )}
            {onEnrollSequence && (
              <button onClick={onEnrollSequence} style={{ background: "rgba(122,158,170,.1)", border: `1px solid ${C.ocean}`, color: C.oceanText, borderRadius: 8, padding: "7px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", minHeight: 36 }}>
                Enroll in LMI Sequence
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ background: C.neutralBg, border: `1px solid ${C.neutralBorder}`, borderRadius: 10, padding: compact ? "4px 8px" : "8px 12px", marginTop: compact ? 0 : 6 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: C.neutralText }}>
        ○ Not LMI · Tract {lmiResult.tractId}
      </span>
    </div>
  );
}

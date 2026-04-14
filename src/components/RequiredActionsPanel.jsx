import { useRequiredActions } from "../hooks/useRequiredActions";

const C = {
  cardBg:"#faf8f4", border:"#ddd4c0", pageBg:"#f2ede4",
  textPrimary:"#1a1410", textSecondary:"#7a6a58", textMuted:"#a89880",
  negative:"#9a4a3a", negativeBg:"#f8ecea",
  warning:"#b07030", warningBg:"#faf0e4", stone:"#9e8e7a",
};
const PM = {
  high:{ dot:"#9a4a3a", bg:"#f8ecea", label:"Urgent"    },
  med: { dot:"#b07030", bg:"#faf0e4", label:"Follow-up" },
  low: { dot:"#9e8e7a", bg:"#f5f1ec", label:"Info"      },
};

function Skeleton() {
  return (
    <div style={{ padding:"12px 14px", borderBottom:`1px solid ${C.border}` }}>
      <div style={{ display:"flex", gap:10 }}>
        <div style={{ width:7, height:7, borderRadius:"50%", background:C.border, marginTop:5, flexShrink:0 }} />
        <div style={{ flex:1 }}>
          <div style={{ height:11, borderRadius:6, background:C.border, width:"68%", marginBottom:7 }} />
          <div style={{ height:9,  borderRadius:6, background:C.pageBg,  width:"45%" }} />
        </div>
      </div>
    </div>
  );
}

export function RequiredActionsPanel({ uid, navigate, isMobile = false }) {
  const { actions, loading } = useRequiredActions(uid);
  const urgentCount = actions.filter(a => a.priority === "high").length;

  const go = (a) => {
    if (!a.navTarget) return;
    if (typeof navigate === "function") navigate(a.navTarget);
    else window.location.hash = a.navTarget;
  };

  return (
    <div>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
        <div style={{ fontSize:9.5, fontWeight:700, letterSpacing:".1em", color:C.textMuted, textTransform:"uppercase" }}>Required Actions</div>
        {urgentCount > 0 && (
          <span style={{ fontSize:9.5, fontWeight:700, background:C.negativeBg, color:C.negative, borderRadius:99, padding:"2px 8px" }}>
            {urgentCount} Urgent
          </span>
        )}
      </div>

      <div style={{ background:C.cardBg, borderRadius:14, border:`1px solid ${C.border}`, overflow:"hidden", boxShadow:"0 1px 3px rgba(0,0,0,.03)" }}>

        {loading && <><Skeleton /><Skeleton /><Skeleton /></>}

        {!loading && actions.length === 0 && (
          <div style={{ padding:"28px 20px", display:"flex", flexDirection:"column", alignItems:"center", gap:10 }}>
            <div style={{ width:36, height:36, borderRadius:"50%", background:"#eef4f0", display:"flex", alignItems:"center", justifyContent:"center" }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#5a8a6a" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            </div>
            <div style={{ fontSize:13, fontWeight:600, color:C.textPrimary }}>You're all caught up</div>
            <div style={{ fontSize:11.5, color:C.textMuted, textAlign:"center", lineHeight:1.5 }}>No actions needed right now.</div>
          </div>
        )}

        {!loading && actions.map((a, i) => {
          const pm = PM[a.priority];
          return (
            <div key={`${a.docId}-${i}`} onClick={() => go(a)}
              style={{ padding: isMobile ? "13px 14px" : "12px 14px", borderBottom: i < actions.length - 1 ? `1px solid ${C.border}` : "none", cursor:"pointer", background:C.cardBg, transition:"background .13s" }}
              onMouseEnter={e => e.currentTarget.style.background = "#f5f0e8"}
              onMouseLeave={e => e.currentTarget.style.background = C.cardBg}>
              <div style={{ display:"flex", gap:10, alignItems:"flex-start" }}>
                <div style={{ width:7, height:7, borderRadius:"50%", background:pm.dot, flexShrink:0, marginTop:5 }} />
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize: isMobile ? 13 : 12, fontWeight:600, color:C.textPrimary, marginBottom:2 }}>{a.label}</div>
                  <div style={{ fontSize: isMobile ? 11.5 : 10.5, color:C.textMuted, marginBottom:6 }}>{a.detail}</div>
                  <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                    <span style={{ fontSize:10, color:C.textSecondary, fontWeight:500 }}>{a.module}</span>
                    <span style={{ fontSize:9.5, fontWeight:600, padding:"1.5px 7px", borderRadius:99, background:pm.bg, color:pm.dot }}>{pm.label}</span>
                  </div>
                </div>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={C.border} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink:0, marginTop:3 }}>
                  <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
                </svg>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

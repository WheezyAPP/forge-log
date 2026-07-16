import { useState, useMemo, useEffect } from "react";
import { Dumbbell, ChevronDown, ChevronUp, CalendarDays, Target, Check, RotateCcw, Repeat, ExternalLink, X as XIcon } from "lucide-react";
import { SPLITS, pickExercises, EX, WEAK_POINT_OPTIONS, WEAK_POINT_MAX_PICKS, buildWeakDayGroups } from "../lib/splits";
import { setUserSplitId, getUserWeakPointGroups, setUserWeakPointGroups } from "../lib/storage";
import { EXERCISE_LINKS } from "../overload/exerciseLinks";

const DAY_NAMES  = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const MON_NAMES  = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DIFF_COLORS = {
  "Beginner":              "#DDDE68",
  "Lower Intermediate":    "#A5B2EB",
  "Advanced Intermediate": "#DA935D",
  "Advanced":              "#E8707A",
};
const C = {
  bg:"#212230", surface:"#2B2D3B", raised:"#363850",
  border:"#494C65", cream:"#F2F1E8", creamDim:"#B7B7C9", ember:"#DA935D",
};

function fmtDay(d) {
  return `${DAY_NAMES[d.getDay()]} ${MON_NAMES[d.getMonth()]} ${d.getDate()}`;
}
function addDays(d, n) {
  const x = new Date(d); x.setDate(x.getDate() + n); return x;
}

function buildSchedule(split, today, weekNum, statuses) {
  return Array.from({ length: 10 }, (_, i) => {
    const date    = addDays(today, i);
    const pi      = (date.getDay() + 6) % 7;
    const dayType = split.pattern[pi];
    const isRest  = dayType === "Rest";
    const def     = isRest ? null : split.defs[dayType];
    const exs     = def
      ? Object.fromEntries(def.groups.map(g => [g.n, pickExercises(g.n, weekNum, i, g.c)]))
      : {};

    const status  = statuses[i] || null;
    let adapt     = null;
    if (!isRest && !status) {
      const p1 = i > 0 && statuses[i-1] === "skipped" && split.pattern[((addDays(today,i-1).getDay()+6)%7)] !== "Rest";
      const p2 = i > 1 && statuses[i-1] === "skipped" && statuses[i-2] === "skipped";
      if (p2) adapt = { msg: "Soft re-entry: ~70% volume, compound lifts only.", sev: "warn" };
      else if (p1) adapt = { msg: "Catch-up: aim to hit this session to get back on schedule.", sev: "info" };
    }
    return { i, date, dateStr: fmtDay(date), dayType, isRest, isToday: i === 0, def, exs, status, adapt };
  });
}

export default function LiftingSchedule({ userId, userSplitId, onSplitChange }) {
  const [selected, setSelected]   = useState(() => SPLITS.find(s => s.id === userSplitId) || null);
  const [weekNum, setWeekNum]     = useState(1);
  const [statuses, setStatuses]   = useState({});
  const [showDet, setShowDet]     = useState(false);
  const [weakPointKeys, setWeakPointKeys] = useState([]); // exclusive to ppl_weak_day
  const [overrides, setOverrides] = useState({}); // { "dayIdx|group|slotIdx": "Replacement Exercise" }
  const [swapOpen, setSwapOpen]   = useState(null); // { dayIdx, group, slotIdx, current } | null

  // Every exercise available for a muscle group, in a stable order
  // (primary lift first, then compounds, then isolation).
  function allExercisesFor(group) {
    const db = EX[group];
    if (!db) return [];
    return [...(db.primary || []), ...(db.compound || []), ...(db.isolation || [])];
  }

  // Alternatives for a swap popover: same muscle group, excluding whatever
  // is already showing for that group on that day (so you don't get offered
  // a duplicate of an exercise you're already doing that session).
  function getAlternatives(group, currentlyShown) {
    const shown = new Set(currentlyShown);
    return allExercisesFor(group).filter(ex => !shown.has(ex));
  }

  function requestSwap(dayIdx, group, slotIdx, original, current) {
    setSwapOpen({ dayIdx, group, slotIdx, original, current });
  }

  function applySwap(replacement) {
    if (!swapOpen) return;
    const key = `${swapOpen.dayIdx}|${swapOpen.group}|${swapOpen.slotIdx}`;
    setOverrides(prev => ({ ...prev, [key]: replacement }));
    setSwapOpen(null);
  }

  function revertSwap(dayIdx, group, slotIdx) {
    const key = `${dayIdx}|${group}|${slotIdx}`;
    setOverrides(prev => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  useEffect(() => {
    const s = SPLITS.find(s => s.id === userSplitId);
    if (s && s.id !== selected?.id) setSelected(s);
  }, [userSplitId]);

  // Load the user's saved weak-point preference once (harmless if they've
  // never picked one — just stays []).
  useEffect(() => {
    if (!userId) return;
    (async () => {
      const saved = await getUserWeakPointGroups(userId);
      setWeakPointKeys(saved || []);
    })();
  }, [userId]);

  const today = useMemo(() => { const d = new Date(); d.setHours(0,0,0,0); return d; }, []);

  // For the PPL + Weak Point split only, swap in the user's chosen muscle
  // group(s) for the "Weak Day" session. Every other split is untouched.
  const effectiveSplit = useMemo(() => {
    if (!selected) return null;
    if (selected.id !== "ppl_weak_day") return selected;
    const wd = buildWeakDayGroups(weakPointKeys);
    return {
      ...selected,
      defs: { ...selected.defs, "Weak Day": { ...selected.defs["Weak Day"], groups: wd.groups, label: wd.label } },
    };
  }, [selected, weakPointKeys]);

  const sched = useMemo(() => effectiveSplit ? buildSchedule(effectiveSplit, today, weekNum, statuses) : [], [effectiveSplit, today, weekNum, statuses]);

  async function toggleWeakPoint(key) {
    setWeakPointKeys(prev => {
      let next;
      if (prev.includes(key)) next = prev.filter(k => k !== key);
      else if (prev.length >= WEAK_POINT_MAX_PICKS) return prev; // cap reached, ignore
      else next = [...prev, key];
      setUserWeakPointGroups(userId, next);
      return next;
    });
  }
  function resetWeakPoint() {
    setWeakPointKeys([]);
    setUserWeakPointGroups(userId, []);
  }

  async function choose(split) {
    setSelected(split); setStatuses({}); setWeekNum(1);
    await setUserSplitId(userId, split.id);
    onSplitChange(split.id);
  }
  function toggleStatus(i, s) {
    setStatuses(prev => { const n={...prev}; n[i]===s ? delete n[i] : (n[i]=s); return n; });
  }

  const phaseLabel = weekNum <= 4 ? "Foundation — building habits"
    : weekNum <= 8 ? "Progression — increasing variety"
    : "Peak — full rotation active";

  return (
    <div>
      {/* Split picker */}
      <div className="ft-label" style={{ marginBottom: 10 }}>Select your split — saved to your profile</div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill, minmax(200px, 1fr))", gap:8, marginBottom:18 }}>
        {SPLITS.map(s => {
          const active = selected?.id === s.id;
          const dc = DIFF_COLORS[s.difficulty];
          return (
            <div key={s.id} onClick={() => choose(s)} style={{
              background: active ? `${s.accentColor}18` : C.surface,
              border: `${active?1.5:1}px solid ${active ? s.accentColor : C.border}`,
              borderRadius:10, padding:"12px 13px", cursor:"pointer", position:"relative",
            }}>
              {active && <div style={{ position:"absolute", top:9, right:9, width:7, height:7, borderRadius:4, background:s.accentColor }} />}
              <div style={{ fontSize:9, fontWeight:700, padding:"2px 7px", borderRadius:20, background:`${dc}20`, color:dc, border:`1px solid ${dc}40`, display:"inline-block", letterSpacing:".05em", textTransform:"uppercase", marginBottom:5 }}>{s.difficulty}</div>
              <div style={{ fontWeight:600, fontSize:13, color:C.cream, marginBottom:3, paddingRight:12 }}>{s.name}</div>
              <div style={{ fontSize:10, color:C.creamDim, marginBottom:2 }}>{s.tagline}</div>
              <div style={{ fontSize:10, color:s.accentColor, fontStyle:"italic" }}>{s.target}</div>
            </div>
          );
        })}
      </div>

      {selected && (<>
        {/* Split detail */}
        <div className="ft-card" style={{ padding:16, marginBottom:14, borderColor:`${selected.accentColor}40` }}>
          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:8, flexWrap:"wrap" }}>
            <div style={{ fontWeight:600, fontSize:14, color:selected.accentColor }}>{selected.name}</div>
            <button className="ft-btn ft-btn-ghost" style={{ marginLeft:"auto", fontSize:11, display:"flex", alignItems:"center", gap:5 }} onClick={() => setShowDet(d=>!d)}>
              {showDet ? <><ChevronUp size={12}/> Hide</> : <><ChevronDown size={12}/> Strengths &amp; weaknesses</>}
            </button>
          </div>
          <div style={{ fontSize:12, color:C.creamDim, lineHeight:1.6, marginBottom:showDet?12:0 }}>{selected.description}</div>
          {showDet && (
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:12 }}>
              <div>
                <div className="ft-label" style={{ color:"#DDDE68", marginBottom:5 }}>Strengths</div>
                {selected.strengths.map(s => <div key={s} style={{ fontSize:11, color:C.creamDim, padding:"2px 0", display:"flex", gap:5 }}><span style={{color:"#DDDE68"}}>✓</span>{s}</div>)}
              </div>
              <div>
                <div className="ft-label" style={{ color:"#E8707A", marginBottom:5 }}>Weaknesses</div>
                {selected.weaknesses.map(w => <div key={w} style={{ fontSize:11, color:C.creamDim, padding:"2px 0", display:"flex", gap:5 }}><span style={{color:"#E8707A"}}>✗</span>{w}</div>)}
              </div>
            </div>
          )}
          {/* Week pattern dots */}
          <div className="ft-label" style={{ marginBottom:6 }}>Weekly pattern</div>
          <div style={{ display:"flex", gap:5, flexWrap:"wrap" }}>
            {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map((label, i) => {
              const type = effectiveSplit.pattern[i]; const isRest = type==="Rest"; const def = effectiveSplit.defs[type];
              return (
                <div key={label} style={{ textAlign:"center" }}>
                  <div style={{ fontSize:9, color:C.creamDim, marginBottom:2 }}>{label}</div>
                  <div style={{ width:32, height:32, borderRadius:6, background:isRest?C.raised:`${def?.color||C.ember}20`, border:`1px solid ${isRest?C.border:(def?.color||C.ember)}`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:7.5, color:isRest?C.creamDim:(def?.color||C.ember), fontWeight:700, textTransform:"uppercase", lineHeight:1.1, textAlign:"center", padding:2 }}>
                    {isRest?"—":type.slice(0,5)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Weak Point picker — exclusive to the PPL + Weak Point Day split */}
        {selected.id === "ppl_weak_day" && (
          <div className="ft-card" style={{ padding:16, marginBottom:14, borderColor:"#fb718540" }}>
            <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8, flexWrap:"wrap" }}>
              <Target size={14} color="#fb7185" />
              <div style={{ fontWeight:600, fontSize:13, color:"#fb7185" }}>Choose your weak point</div>
              <span style={{ fontSize:10, color:C.creamDim }}>— exclusive to this split, pick up to {WEAK_POINT_MAX_PICKS}</span>
              {weakPointKeys.length > 0 && (
                <button className="ft-btn ft-btn-ghost" style={{ marginLeft:"auto", fontSize:10, display:"flex", alignItems:"center", gap:4 }} onClick={resetWeakPoint}>
                  <RotateCcw size={11} /> Reset to default
                </button>
              )}
            </div>
            <div style={{ fontSize:11, color:C.creamDim, marginBottom:10, lineHeight:1.5 }}>
              Your 4th session will specialize in whatever you pick here, layered on top of the standard Push/Pull/Legs work. Leave nothing selected to use the default (Shoulders, Arms, Abs).
            </div>
            <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
              {WEAK_POINT_OPTIONS.map(opt => {
                const active = weakPointKeys.includes(opt.key);
                const disabled = !active && weakPointKeys.length >= WEAK_POINT_MAX_PICKS;
                return (
                  <button
                    key={opt.key}
                    onClick={() => toggleWeakPoint(opt.key)}
                    disabled={disabled}
                    style={{
                      display:"flex", alignItems:"center", gap:5, fontSize:12, fontWeight:600,
                      padding:"6px 12px", borderRadius:20, cursor:disabled?"not-allowed":"pointer",
                      background: active ? "#fb718520" : C.raised,
                      border: `1px solid ${active ? "#fb7185" : C.border}`,
                      color: active ? "#fb7185" : disabled ? C.creamDim+"80" : C.creamDim,
                      opacity: disabled ? 0.5 : 1,
                    }}
                  >
                    {active && <Check size={11} />}
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* 3-month slider */}
        <div className="ft-card-raised" style={{ padding:"10px 14px", marginBottom:12, display:"flex", alignItems:"center", gap:12, flexWrap:"wrap" }}>
          <span className="ft-label" style={{ marginBottom:0, whiteSpace:"nowrap" }}>3-month variety — week:</span>
          <input type="range" min={1} max={12} value={weekNum} onChange={e => setWeekNum(+e.target.value)} style={{ flex:1, minWidth:80, accentColor:selected.accentColor }} />
          <span style={{ fontSize:13, fontWeight:600, color:selected.accentColor, minWidth:64 }}>Week {weekNum}</span>
          <span style={{ fontSize:11, color:C.creamDim, fontStyle:"italic" }}>{phaseLabel}</span>
        </div>

        <div style={{ fontSize:11, color:C.creamDim, marginBottom:10 }}>
          Mark days Done or Skipped to see how the schedule adapts. Log workouts in the Overload Log tab to count toward your attendance grade.
        </div>

        {/* 10-day horizontal schedule */}
        <div style={{ overflowX:"auto", paddingBottom:8, WebkitOverflowScrolling:"touch" }}>
          <div style={{ display:"flex", gap:8, minWidth:"max-content" }}>
            {sched.map(day => {
              const ac = day.def?.color || C.creamDim;
              const bg = day.status==="done" ? "#DDDE6812" : day.status==="skipped" ? "#E8707A12" : day.isToday ? `${C.ember}10` : C.surface;
              const bd = day.status==="done" ? "#DDDE6850" : day.status==="skipped" ? "#E8707A50" : day.isToday ? `${C.ember}80` : C.border;
              return (
                <div key={day.i} style={{ background:bg, border:`1px solid ${bd}`, borderRadius:10, padding:"11px 12px", minWidth:184, maxWidth:196 }}>
                  <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:7 }}>
                    <div>
                      <div style={{ fontSize:12, fontWeight:600, color:day.isToday?C.ember:C.cream }}>{day.dateStr}</div>
                      {day.isToday && <div style={{ fontSize:9, color:C.ember, fontWeight:700, letterSpacing:".07em", textTransform:"uppercase" }}>TODAY</div>}
                      {day.status && <div style={{ fontSize:10, fontWeight:600, color:day.status==="done"?"#DDDE68":"#E8707A", marginTop:1 }}>{day.status==="done"?"✓ Completed":"✗ Skipped"}</div>}
                    </div>
                    <div style={{ fontSize:8, fontWeight:700, padding:"2px 5px", borderRadius:5, background:day.isRest?C.raised:`${ac}20`, color:day.isRest?C.creamDim:ac, border:`1px solid ${day.isRest?C.border:ac}40`, textTransform:"uppercase", letterSpacing:".04em", maxWidth:72, textAlign:"center", lineHeight:1.3, wordBreak:"break-word" }}>
                      {day.isRest?"Rest":day.dayType}
                    </div>
                  </div>
                  {day.adapt && (
                    <div style={{ background:day.adapt.sev==="warn"?"#f0a04015":"#6ab0e815", border:`1px solid ${day.adapt.sev==="warn"?"#f0a04040":"#6ab0e840"}`, borderRadius:6, padding:"5px 7px", marginBottom:7, fontSize:10, color:day.adapt.sev==="warn"?"#f0a040":"#6ab0e8", lineHeight:1.4 }}>
                      ⚡ {day.adapt.msg}
                    </div>
                  )}
                  {!day.isRest && day.def ? (
                    <div style={{ display:"flex", flexDirection:"column", gap:5 }}>
                      {day.def.groups.map(g => {
                        const rawList = day.exs[g.n] || [];
                        return (
                          <div key={g.n}>
                            <div style={{ fontSize:8, color:ac, letterSpacing:".07em", textTransform:"uppercase", fontWeight:700, marginBottom:2 }}>{g.n}</div>
                            {rawList.map((ex, slotIdx) => {
                              const key = `${day.i}|${g.n}|${slotIdx}`;
                              const shown = overrides[key] || ex;
                              const isSwapped = !!overrides[key];
                              return (
                                <div
                                  key={slotIdx}
                                  onClick={() => requestSwap(day.i, g.n, slotIdx, ex, shown)}
                                  title="Click to swap for another exercise targeting the same muscle"
                                  style={{
                                    fontSize:10, color:isSwapped?ac:C.creamDim, paddingLeft:6,
                                    borderLeft:`2px solid ${ac}40`, lineHeight:1.5, cursor:"pointer",
                                    display:"flex", alignItems:"center", justifyContent:"space-between", gap:4,
                                  }}
                                >
                                  <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{shown}</span>
                                  <Repeat size={9} style={{ flexShrink:0, opacity:0.55 }} />
                                </div>
                              );
                            })}
                          </div>
                        );
                      })}
                    </div>
                  ) : day.isRest ? (
                    <div style={{ color:C.creamDim, fontSize:11, textAlign:"center", padding:"8px 0", lineHeight:1.5 }}>Recovery — sleep, hydrate, prepare</div>
                  ) : null}
                  {!day.isRest && (
                    <div style={{ display:"flex", gap:5, marginTop:9 }}>
                      {["done","skipped"].map(s => (
                        <button key={s} onClick={() => toggleStatus(day.i, s)} style={{ flex:1, fontSize:10, padding:"5px 0", borderRadius:5, cursor:"pointer", border:"none", fontWeight:600, background:day.status===s?(s==="done"?"#DDDE68":"#E8707A"):C.raised, color:day.status===s?"#212230":C.creamDim }}>
                          {s==="done"?"✓ Done":"✗ Skip"}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </>)}

      {!selected && (
        <div className="ft-card" style={{ padding:40, textAlign:"center" }}>
          <CalendarDays size={28} color={C.creamDim} style={{ margin:"0 auto 10px", display:"block" }} />
          <div className="ft-display" style={{ fontSize:18, marginBottom:6 }}>PICK YOUR SPLIT</div>
          <div style={{ fontSize:13, color:C.creamDim }}>Select a training split above to get your personalized 10-day adaptive schedule with exercise guidance and variety that evolves over 3 months.</div>
        </div>
      )}

      {/* Swap popover — pick a replacement targeting the same muscle group */}
      {swapOpen && (() => {
        const day = sched.find(d => d.i === swapOpen.dayIdx);
        const currentlyShownForGroup = day
          ? (day.exs[swapOpen.group] || []).map((ex, idx) => overrides[`${swapOpen.dayIdx}|${swapOpen.group}|${idx}`] || ex)
          : [];
        const alternatives = getAlternatives(swapOpen.group, currentlyShownForGroup);
        const wasSwapped = swapOpen.current !== swapOpen.original;

        return (
          <div
            style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.65)", zIndex:1000, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}
            onClick={(e) => { if (e.target === e.currentTarget) setSwapOpen(null); }}
          >
            <div className="ft-card" style={{ padding:18, maxWidth:380, width:"100%", maxHeight:"75vh", overflowY:"auto", overscrollBehavior:"contain" }}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:4 }}>
                <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                  <Repeat size={14} color={C.ember} />
                  <div style={{ fontWeight:700, fontSize:13 }}>Swap exercise</div>
                </div>
                <button onClick={() => setSwapOpen(null)} style={{ background:"none", border:"none", color:C.creamDim, cursor:"pointer", padding:4 }}>
                  <XIcon size={14} />
                </button>
              </div>
              <div style={{ fontSize:11, color:C.creamDim, marginBottom:12 }}>
                Currently: <span style={{ color:C.cream, fontWeight:600 }}>{swapOpen.current}</span> · {swapOpen.group}
              </div>

              {wasSwapped && (
                <button
                  onClick={() => { revertSwap(swapOpen.dayIdx, swapOpen.group, swapOpen.slotIdx); setSwapOpen(null); }}
                  style={{ width:"100%", textAlign:"left", background:C.raised, border:`1px solid ${C.border}`, borderRadius:8, padding:"9px 11px", marginBottom:8, cursor:"pointer", display:"flex", alignItems:"center", gap:8 }}
                >
                  <RotateCcw size={13} color={C.creamDim} />
                  <div style={{ fontSize:12, color:C.creamDim }}>Revert to original: <span style={{ color:C.cream, fontWeight:600 }}>{swapOpen.original}</span></div>
                </button>
              )}

              <div style={{ fontSize:10, color:C.creamDim, letterSpacing:".06em", textTransform:"uppercase", fontWeight:700, marginBottom:6 }}>
                Same target muscle — {swapOpen.group}
              </div>
              <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                {alternatives.length === 0 && (
                  <div style={{ fontSize:12, color:C.creamDim, padding:"8px 0" }}>No other exercises available for this muscle group.</div>
                )}
                {alternatives.map(alt => {
                  const tutUrl = EXERCISE_LINKS[alt];
                  return (
                    <div key={alt} style={{ display:"flex", alignItems:"center", gap:6, background:C.raised, border:`1px solid ${C.border}`, borderRadius:8, padding:"8px 10px" }}>
                      <button
                        onClick={() => applySwap(alt)}
                        style={{ flex:1, textAlign:"left", background:"none", border:"none", color:C.cream, fontSize:12, fontWeight:600, cursor:"pointer", padding:0 }}
                      >
                        {alt}
                      </button>
                      {tutUrl && (
                        <a
                          href={tutUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          title="Form & tutorial"
                          style={{ color:C.ember, display:"flex", alignItems:"center", flexShrink:0 }}
                        >
                          <ExternalLink size={13} />
                        </a>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// GroupTrainingBoard — the merged, per-exercise view for a live group
// training session (host + up to 3 joined members, 4 total).
//
// Replaces the old approach of mounting one full SplitDashboard per
// person side-by-side: with more than 2 people that meant scrolling
// through each person's entire day just to find where they are on
// whichever exercise everyone's actually doing right now. Here it's
// inverted — one card PER EXERCISE, and every person's own row (name,
// their exercise for that slot, their own weight/reps inputs, their
// own save) sits stacked inside that same card. Logging set 1 for
// everyone means staying on one card, not visiting N dashboards.
//
// Sync model: the host's exercise queue (hostBlocks) is the backbone —
// every slot's default exercise for every member comes from there,
// and updates live as the host adds/reorders/changes exercises
// (updateSessionHostBlocks, broadcast over Realtime by the caller).
// A member can swap ONE slot to something else for themselves only
// (setMemberOverride) — that slot then stops following the host until
// the member swaps it again or the host force-resyncs everyone. The
// swap button renders blue specifically to flag "this one's desynced",
// nothing else changes visually.
//
// Each person's own weight suggestion/default comes from THEIR OWN
// logged history for that exercise — never the host's or another
// member's numbers, same principle the old "Follow my partner" card
// already used.

import { useState, useMemo } from "react";
import { Repeat, Check, Plus, Users, LogOut, RefreshCw, ChevronRight, X as XIcon } from "lucide-react";
import { EX, getProgressionSuggestion } from "../lib/splits";
import { defaultWeightForPerson, REPS_ONLY_EXERCISES } from "../lib/groupTraining";

const C = {
  bg: "#1C1E26", surface: "#262933", raised: "#30343E",
  border: "#40465A", cream: "#F3F5F9", creamDim: "#9CA1B5", ember: "#4FADFF",
  lime: "#2BE6A8", warn: "#FF7A85",
};

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// One person's effective exercise at a given slot index — the host's
// pick unless this specific person has overridden that index.
//
// KNOWN LIMITATION found in review, not fixed here: overrides are
// keyed by raw array position, not a stable per-exercise identity —
// there isn't one in the underlying data model (SplitDashboard's own
// blocks are positional throughout, no persistent id per block).
// So if the host removes or reorders an exercise BEFORE a slot a
// member has desynced, everything after that point shifts and the
// member's override can end up attached to the wrong exercise. Adding
// stable ids would mean threading a new field through SplitDashboard's
// block add/remove/reorder/swap logic, which is out of scope for this
// pass — "Force sync everyone" is the practical recovery if this ever
// bites: it wipes all overrides back to a clean, correctly-aligned
// slate.
function effectiveExerciseFor(person, index, hostBlocks) {
  const base = hostBlocks[index];
  if (!base) return null;
  if (!person.isHost && person.overrides && person.overrides[index]) {
    return { ...base, ...person.overrides[index] };
  }
  return base;
}

export default function GroupTrainingBoard({
  sessionId, currentUserId, isHost, hostUserId, hostName,
  hostBlocks, members, // members: [{ userId, name, overrides }]
  peopleData, // { [userId]: { latestWeight, gender, dedicatedProgressiveOverload, workoutSessions } }
  onHostBlocksChange, // (nextBlocks) => void — host only
  onSetOverride, // (index, override|null) => void — current user's own override
  onLogSet, // (personId, exercise, grp, sets) => Promise
  onForceResync, // () => void — host only
  onEndOrLeave,
  hideOwnRow, // true when the host already has their own full dashboard rendered elsewhere and this board should only show members
}) {
  const [swapOpen, setSwapOpen] = useState(null); // { index } | null
  // Per-person, per-slot draft sets — not persisted until that row's
  // save is tapped. Seeded lazily the first time a slot/person combo
  // is touched so switching between slots doesn't require pre-building
  // every possible draft up front.
  const [drafts, setDrafts] = useState({}); // `${userId}:${index}` -> [{w,r}]

  const people = useMemo(() => {
    const list = [{ userId: hostUserId, name: hostName, isHost: true, overrides: {} }];
    for (const m of members) list.push({ userId: m.userId, name: m.name, isHost: false, overrides: m.overrides || {} });
    return hideOwnRow ? list.filter(p => p.userId !== currentUserId) : list;
  }, [hostUserId, hostName, members, hideOwnRow, currentUserId]);

  const today = todayStr();

  // Keyed by exercise too, not just person+slot — critical: if the
  // effective exercise at a slot changes (host edits their list live,
  // a member resyncs, or a host force-resync wipes overrides), an
  // in-progress draft must NOT silently get attributed to the new
  // exercise. Keying on exercise means a stale draft just becomes
  // unreferenced (harmless) the moment the slot's exercise changes,
  // rather than being shown/logged against the wrong lift.
  function draftKey(userId, index, exercise) { return `${userId}:${index}:${exercise}`; }

  function getDraft(person, index, exercise, grp) {
    const key = draftKey(person.userId, index, exercise);
    if (drafts[key]) return drafts[key];
    const repsOnly = REPS_ONLY_EXERCISES.has(exercise);
    const pd = peopleData[person.userId] || {};
    const setCount = Math.max(1, hostBlocks[index]?.setCount || 3);
    if (repsOnly) {
      return Array.from({ length: setCount }, () => ({ w: "", r: "" }));
    }
    const history = (pd.workoutSessions || []).filter(s => s.exercise === exercise);
    const sugg = getProgressionSuggestion(history, grp, exercise, null, pd.dedicatedProgressiveOverload);
    const w = defaultWeightForPerson(exercise, sugg, pd.latestWeight);
    return Array.from({ length: setCount }, () => ({ w, r: "" }));
  }

  function updateDraftSet(person, index, exercise, grp, si, patch) {
    const key = draftKey(person.userId, index, exercise);
    setDrafts(prev => {
      const current = prev[key] || getDraft(person, index, exercise, grp);
      const next = current.map((s, i) => i === si ? { ...s, ...patch } : s);
      return { ...prev, [key]: next };
    });
  }
  function addDraftSet(person, index, exercise, grp) {
    const key = draftKey(person.userId, index, exercise);
    setDrafts(prev => {
      const current = prev[key] || getDraft(person, index, exercise, grp);
      return { ...prev, [key]: [...current, { w: current[current.length - 1]?.w || "", r: "" }] };
    });
  }
  function removeDraftSet(person, index, exercise, si) {
    const key = draftKey(person.userId, index, exercise);
    setDrafts(prev => {
      const current = prev[key];
      if (!current || current.length <= 1) return prev;
      return { ...prev, [key]: current.filter((_, i) => i !== si) };
    });
  }

  function alreadyLoggedToday(person, exercise) {
    const pd = peopleData[person.userId] || {};
    return (pd.workoutSessions || []).some(s => s.exercise === exercise && s.date === today);
  }

  async function saveRow(person, index) {
    const ex = effectiveExerciseFor(person, index, hostBlocks);
    if (!ex) return;
    const repsOnly = REPS_ONLY_EXERCISES.has(ex.exercise);
    const key = draftKey(person.userId, index, ex.exercise);
    const draft = drafts[key] || getDraft(person, index, ex.exercise, ex.grp);
    const filled = draft.filter(s => repsOnly ? s.r !== "" : (s.w !== "" && s.r !== ""));
    if (!filled.length) return;
    const sets = filled.map(s => repsOnly
      ? { weight: 0, reps: parseInt(s.r) || 0 }
      : { weight: parseFloat(s.w) || 0, reps: parseInt(s.r) || 0 });
    await onLogSet(person.userId, ex.exercise, ex.grp, sets);
    setDrafts(prev => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  function pickSwap(alt) {
    const index = swapOpen.index;
    const grp = hostBlocks[index]?.grp;
    if (isHost) {
      const next = hostBlocks.map((b, i) => i !== index ? b : { ...b, exercise: alt });
      onHostBlocksChange(next);
    } else {
      onSetOverride(index, { exercise: alt, grp });
    }
    setSwapOpen(null);
  }
  function resyncOwn(index) {
    onSetOverride(index, null);
  }

  if (!hostBlocks.length) {
    return (
      <div className="ft-card" style={{ padding: 32, textAlign: "center", color: C.creamDim }}>
        Waiting on {isHost ? "your" : `${hostName}'s`} exercise queue — {isHost ? "add exercises from your own log to get started." : "hang tight, nothing's queued yet."}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="ft-card" style={{ padding: "10px 14px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: C.creamDim }}>
          <Users size={14} color={C.ember} />
          {isHost ? <>Hosting · <b style={{ color: C.cream }}>{people.length}</b> total</> : <>Training with <b style={{ color: C.cream }}>{hostName}</b></>}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {isHost && (
            <button className="ft-btn ft-btn-ghost" style={{ fontSize: 11 }} onClick={onForceResync} title="Snap every member back onto your exact list">
              <RefreshCw size={12} /> Force sync everyone
            </button>
          )}
          <button className="ft-btn ft-btn-ghost" style={{ fontSize: 11.5 }} onClick={onEndOrLeave}>
            <LogOut size={12} /> {isHost ? "End session" : "Leave session"}
          </button>
        </div>
      </div>

      {hideOwnRow && members.length === 0 ? (
        <div className="ft-card" style={{ padding: 32, textAlign: "center", color: C.creamDim, fontSize: 12.5 }}>
          Nobody's joined yet — this session stays open and syncs automatically the moment someone does.
        </div>
      ) : hostBlocks.map((slot, index) => (
        <div key={index} className="ft-card" style={{ padding: 14 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <div style={{ fontSize: 10.5, color: C.creamDim, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" }}>
              Exercise {index + 1} of {hostBlocks.length} · {slot.grp}
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {people.map(person => {
              const ex = effectiveExerciseFor(person, index, hostBlocks);
              if (!ex) return null;
              const isMe = person.userId === currentUserId;
              const canLogFor = isMe || isHost; // host can log sets on behalf of anyone in the session
              const desynced = !person.isHost && !!person.overrides?.[index];
              const canSwap = isMe; // swapping only ever changes YOUR OWN row — the host's own row is "isMe" for the host, same rule, no special-casing needed
              const draft = drafts[draftKey(person.userId, index, ex.exercise)] || getDraft(person, index, ex.exercise, ex.grp);
              const logged = alreadyLoggedToday(person, ex.exercise);
              return (
                <div key={person.userId} style={{ padding: "10px 0", borderTop: person === people[0] ? "none" : `1px solid ${C.border}` }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                      <span style={{ fontSize: 11.5, fontWeight: 700, color: person.isHost ? C.ember : C.lime, whiteSpace: "nowrap" }}>
                        {person.name}{isMe ? " (you)" : ""}
                      </span>
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: C.cream, overflow: "hidden", textOverflow: "ellipsis" }}>{ex.exercise}</span>
                      {logged && <Check size={12} color={C.lime} />}
                    </div>
                    {canSwap && (
                      <button
                        onClick={() => setSwapOpen({ index })}
                        title={desynced ? "Desynced from host — swap again or resync" : "Swap exercise"}
                        style={{
                          background: desynced ? `${C.ember}1c` : "none",
                          border: `1px solid ${desynced ? C.ember : "transparent"}`,
                          borderRadius: 6, padding: "3px 6px", cursor: "pointer",
                          color: desynced ? C.ember : C.creamDim, display: "flex", alignItems: "center", gap: 4, flexShrink: 0,
                        }}
                      >
                        <Repeat size={12} />
                        {desynced && <span style={{ fontSize: 9.5, fontWeight: 700 }}>DESYNCED</span>}
                      </button>
                    )}
                  </div>

                  {desynced && isMe && (
                    <button className="ft-btn ft-btn-ghost" style={{ fontSize: 10, padding: "3px 8px", marginBottom: 6, color: C.ember, borderColor: C.ember }} onClick={() => resyncOwn(index)}>
                      Resync to {hostName}'s pick
                    </button>
                  )}

                  {canLogFor ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      {draft.map((s, si) => {
                        const repsOnly = REPS_ONLY_EXERCISES.has(ex.exercise);
                        return (
                          <div key={si} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            {!repsOnly && (
                              <input
                                className="ft-input" placeholder="lbs" inputMode="decimal" value={s.w}
                                onChange={e => updateDraftSet(person, index, ex.exercise, ex.grp, si, { w: e.target.value })}
                                style={{ flex: 1, padding: "6px 8px", fontSize: 13 }}
                              />
                            )}
                            <input
                              className="ft-input" placeholder="reps" inputMode="numeric" value={s.r}
                              onChange={e => updateDraftSet(person, index, ex.exercise, ex.grp, si, { r: e.target.value })}
                              style={{ flex: 1, padding: "6px 8px", fontSize: 13 }}
                            />
                            <button onClick={() => removeDraftSet(person, index, ex.exercise, si)} aria-label="Remove set" style={{ background: "none", border: "none", color: C.creamDim, cursor: "pointer", padding: 2 }}><XIcon size={12} /></button>
                          </div>
                        );
                      })}
                      <div style={{ display: "flex", gap: 6, marginTop: 2 }}>
                        <button className="ft-btn ft-btn-ghost" style={{ fontSize: 10.5, padding: "4px 8px" }} onClick={() => addDraftSet(person, index, ex.exercise, ex.grp)}><Plus size={11} /> Set</button>
                        <button className="ft-btn ft-btn-primary" style={{ fontSize: 10.5, padding: "4px 10px" }} onClick={() => saveRow(person, index)}><Check size={11} /> Log</button>
                      </div>
                    </div>
                  ) : (
                    <div style={{ fontSize: 11, color: C.creamDim }}>
                      {logged ? "Logged today" : "Hasn't logged this yet"} — {person.isHost ? "hosting" : "joined"}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {swapOpen && (() => {
        const grp = hostBlocks[swapOpen.index]?.grp;
        const db = EX[grp];
        if (!db) return null;
        const currentExercise = effectiveExerciseFor(people.find(p => p.userId === currentUserId) || people[0], swapOpen.index, hostBlocks)?.exercise;
        const allEx = [...(db.primary || []), ...(db.compound || []), ...(db.isolation || [])];
        const alternatives = allEx.filter(ex => ex !== currentExercise).sort((a, b) => a.localeCompare(b));
        return (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.65)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={e => { if (e.target === e.currentTarget) setSwapOpen(null); }}>
            <div className="ft-card" style={{ maxWidth: 420, width: "100%", maxHeight: "80vh", overflow: "auto", padding: 16 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <div style={{ fontWeight: 700, fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}><Repeat size={14} color={C.ember} /> Swap exercise — {grp}</div>
                <button onClick={() => setSwapOpen(null)} style={{ background: "none", border: "none", color: C.creamDim, cursor: "pointer" }}><XIcon size={14} /></button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {alternatives.map(alt => (
                  <button
                    key={alt}
                    onClick={() => pickSwap(alt)}
                    style={{ display: "flex", justifyContent: "space-between", background: C.raised, border: `1px solid ${C.border}`, borderRadius: 6, padding: "8px 10px", color: C.cream, fontSize: 12.5, cursor: "pointer", textAlign: "left" }}
                  >
                    {alt} <ChevronRight size={13} color={C.creamDim} />
                  </button>
                ))}
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// Partner Training — reworked for real multi-person sessions (host +
// up to 3 joined members, 4 total) instead of exactly one pairwise
// partner. Host and Join are now two genuinely distinct actions that
// can happen from two separate devices, not one person driving both
// sides from a single phone:
//
//   - HOST creates an open session. Your own exercise queue (built the
//     normal way, in your own full SplitDashboard below) IS the
//     session's shared queue — it's pushed to every joined member
//     automatically as you change it (add/reorder/swap), no separate
//     "send" step required for the common case.
//   - JOIN picks one of the currently-open sessions from the list and
//     copies that host's CURRENT queue into your own board. From then
//     on your queue keeps following the host's live, exercise for
//     exercise — UNLESS you swap one specific exercise for yourself,
//     which desyncs just that one slot (shown with a blue "DESYNCED"
//     tag) until you resync it or the host force-resyncs everyone.
//
// The actual per-exercise, multi-person logging surface is
// GroupTrainingBoard — one card per exercise, every person's row
// (name, their exercise for that slot, their own inputs) stacked
// together, so tracking 2-4 people means staying on one card instead
// of scrolling between N full separate dashboards. The host still gets
// their own full SplitDashboard for BUILDING their day (exercise
// picker, reorder, off-split additions, everything that already
// existed) — the board underneath it shows only the joined members'
// rows, since the host's own row would just duplicate what's already
// right above it.
//
// Realtime: one channel per session, subscribed to the session row
// itself (host_blocks/status) and the members table (joins/leaves/
// overrides), plus workout_sessions for every current participant so
// sets logged on ANY device (including a member's own separate phone)
// show up live everywhere else.

import { useState, useEffect, useRef } from "react";
import { Users, X, RefreshCw, Wifi, WifiOff, LogOut } from "lucide-react";
import SplitDashboard from "./SplitDashboard";
import GroupTrainingBoard from "./GroupTrainingBoard";
import {
  loadProfile, loadEntries, loadWorkoutSessions,
  createTrainingSession, updateSessionHostBlocks, endTrainingSession, listActiveTrainingSessions,
  loadSessionMembers, joinTrainingSession, leaveTrainingSession, setMemberOverride, forceResyncAllMembers,
  insertWorkoutSessions,
} from "../lib/storage";
import { supabase } from "../lib/supabase";

const C = {
  bg: "#1C1E26", surface: "#262933", raised: "#30343E",
  border: "#40465A", cream: "#F3F5F9", creamDim: "#9CA1B5", ember: "#4FADFF",
  lime: "#2BE6A8",
};

const MAX_MEMBERS = 3; // + host = 4 total

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function PartnerTraining({
  userId, userName, userSplitId, splitStartedOn, workoutSessions, setWorkoutSessions,
  latestWeight, gender, dedicatedProgressiveOverload, onSplitChange, onExit,
  customDayPlans, onSaveCustomDayPlan, onDeleteCustomDayPlan,
  customSplitTemplates, onSaveCustomSplitTemplate, onDeleteCustomSplitTemplate,
  workoutAttendance, onToggleWorkoutAttendance, onDirtyChange,
}) {
  // "choice" (pick host/join) | "joinPick" (browsing open sessions) | "session" (in one, either role)
  const [mode, setMode] = useState("choice");
  const [session, setSession] = useState(null); // { id, hostUserId, hostBlocks, status }
  const [isHost, setIsHost] = useState(false);
  const [members, setMembers] = useState([]); // [{ userId, name, overrides }]
  const [openSessions, setOpenSessions] = useState([]);
  const [loadingAction, setLoadingAction] = useState(false);
  const [realtimeStatus, setRealtimeStatus] = useState("connecting");

  // Per-person data the board needs — latest weight, gender, dedicated
  // mode, and full workout history (for progression suggestions and
  // "logged today" checks). Keyed by userId, always includes the host
  // and every current member. Refetched per-person after any log/join/
  // leave rather than trying to patch it incrementally — session sizes
  // here are small (max 4), so simplicity wins over cleverness.
  const [peopleData, setPeopleData] = useState({});

  const [hostDirty, setHostDirty] = useState(false);
  useEffect(() => { onDirtyChange?.(hostDirty); }, [hostDirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  // Realtime's workout_sessions handler needs to check "is this user
  // part of my current session" against the LIVE roster, not whatever
  // `members` looked like at the moment the channel subscribed — a
  // plain closure over `members` would go stale the instant someone
  // else joins or leaves mid-session (the exact staleness bug already
  // fixed once elsewhere in this app, for SplitDashboard's "today").
  const membersRef = useRef(members);
  useEffect(() => { membersRef.current = members; }, [members]);
  const peopleDataRef = useRef(peopleData);
  useEffect(() => { peopleDataRef.current = peopleData; }, [peopleData]);

  // ── Loading each participant's board data ──────────────────────────
  async function loadPersonData(pid) {
    const [profile, entries, sessions] = await Promise.all([
      loadProfile(pid), loadEntries(pid), loadWorkoutSessions(pid),
    ]);
    const dates = Object.keys(entries).sort();
    const latest = dates[dates.length - 1];
    return {
      latestWeight: latest ? entries[latest].weight ?? null : null,
      gender: profile?.gender,
      dedicatedProgressiveOverload: profile?.dedicatedProgressiveOverload,
      workoutSessions: sessions,
    };
  }
  async function refreshPersonData(pid) {
    const data = await loadPersonData(pid);
    setPeopleData(prev => ({ ...prev, [pid]: data }));
  }

  // ── Hosting ─────────────────────────────────────────────────────────
  async function startHosting() {
    setLoadingAction(true);
    try {
      const created = await createTrainingSession(userId);
      if (!created) return;
      setSession(created);
      setIsHost(true);
      setMembers([]);
      setPeopleData({ [userId]: await loadPersonData(userId) });
      setMode("session");
    } finally {
      setLoadingAction(false);
    }
  }

  // Debounced push of the host's live exercise queue — SplitDashboard
  // reports every blocks change (including mid-typing weight/rep
  // edits, which don't matter here); only exercise/group/set-count
  // actually needs to reach the session, and only needs to go out a
  // few times a second at most, not on every keystroke.
  const pushTimer = useRef(null);
  // SplitDashboard's onBlocksChange already reports blocks pre-shaped
  // as {exercise, grp, setCount} — no re-shaping needed or wanted here.
  function handleHostBlocksChange(blocks) {
    if (!isHost || !session) return;
    const shaped = blocks || [];
    setSession(prev => prev ? { ...prev, hostBlocks: shaped } : prev);
    clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(() => updateSessionHostBlocks(session.id, shaped), 400);
  }
  // Board-driven swap of the host's OWN row — same shape, immediate
  // (no debounce needed, it's a single deliberate tap not a stream of
  // keystrokes).
  function handleHostBlocksChangeImmediate(nextBlocks) {
    if (!session) return;
    setSession(prev => prev ? { ...prev, hostBlocks: nextBlocks } : prev);
    updateSessionHostBlocks(session.id, nextBlocks);
  }

  async function handleForceResync() {
    if (!session) return;
    await forceResyncAllMembers(session.id);
    setMembers(prev => prev.map(m => ({ ...m, overrides: {} })));
  }

  // ── Joining ─────────────────────────────────────────────────────────
  async function openJoinPicker() {
    setLoadingAction(true);
    try {
      const sessions = await listActiveTrainingSessions(userId);
      setOpenSessions(sessions);
      setMode("joinPick");
    } finally {
      setLoadingAction(false);
    }
  }

  async function joinSession(s) {
    if (s.memberCount >= MAX_MEMBERS) return; // full — 4 total already
    setLoadingAction(true);
    try {
      const member = await joinTrainingSession(s.id, userId);
      if (!member) return;
      const [hostData, freshMembers] = await Promise.all([
        loadPersonData(s.hostUserId),
        loadSessionMembers(s.id),
      ]);
      const others = await Promise.all(freshMembers.filter(m => m.userId !== userId).map(async m => [m.userId, await loadPersonData(m.userId)]));
      setPeopleData({ [s.hostUserId]: hostData, [userId]: await loadPersonData(userId), ...Object.fromEntries(others) });
      setSession(s);
      setIsHost(false);
      setMembers(freshMembers);
      setMode("session");
    } finally {
      setLoadingAction(false);
    }
  }

  async function handleSetOverride(index, override) {
    if (!session || isHost) return;
    await setMemberOverride(session.id, userId, index, override);
    setMembers(prev => prev.map(m => {
      if (m.userId !== userId) return m;
      const next = { ...(m.overrides || {}) };
      if (override) next[index] = override; else delete next[index];
      return { ...m, overrides: next };
    }));
  }

  // ── Leaving / ending ─────────────────────────────────────────────────
  async function endOrLeave() {
    if (!session) return;
    if (isHost) await endTrainingSession(session.id);
    else await leaveTrainingSession(session.id, userId);
    setSession(null);
    setMembers([]);
    setPeopleData({});
    setMode("choice");
  }

  // ── Logging a set for anyone in the session ─────────────────────────
  async function handleLogSet(personId, exercise, grp, sets) {
    await insertWorkoutSessions(personId, [{ date: todayStr(), exercise, group: grp, sets, splitId: null }]);
    if (personId === userId) {
      // Keep the host's own SplitDashboard's session list in sync too —
      // it reads from the same `workoutSessions` prop this component
      // owns for the logged-in user.
      const fresh = await loadWorkoutSessions(userId);
      setWorkoutSessions(fresh);
    }
    await refreshPersonData(personId);
  }

  // ── Realtime — one channel per active session ───────────────────────
  useEffect(() => {
    if (!session?.id) return;
    setRealtimeStatus("connecting");

    async function refetchMembers() {
      const fresh = await loadSessionMembers(session.id);
      setMembers(fresh);
      // Anyone brand-new to the roster needs their board data loaded —
      // existing members/host are left alone here (their data refreshes
      // on their own log events instead) to avoid re-fetching everyone
      // on every single join/leave.
      const known = new Set(Object.keys(peopleDataRef.current));
      const missing = fresh.filter(m => !known.has(m.userId));
      if (missing.length) {
        const loaded = await Promise.all(missing.map(async m => [m.userId, await loadPersonData(m.userId)]));
        setPeopleData(prev => ({ ...prev, ...Object.fromEntries(loaded) }));
      }
    }
    async function onSessionRowChange(payload) {
      const row = payload.new;
      if (!row) return;
      if (row.status === "ended") {
        // Host ended it — everyone still inside gets dropped back out.
        setSession(null);
        setMembers([]);
        setPeopleData({});
        setMode("choice");
        return;
      }
      setSession(prev => prev ? { ...prev, hostBlocks: row.host_blocks || [] } : prev);
    }
    async function onWorkoutSessionChange(payload) {
      const uid = payload.new?.user_id || payload.old?.user_id;
      if (!uid) return;
      const relevant = uid === session.hostUserId || uid === userId || membersRef.current.some(m => m.userId === uid);
      if (!relevant) return;
      await refreshPersonData(uid);
      if (uid === userId) setWorkoutSessions(await loadWorkoutSessions(userId));
    }

    const channel = supabase
      .channel(`training-session-${session.id}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "training_sessions", filter: `id=eq.${session.id}` }, onSessionRowChange)
      .on("postgres_changes", { event: "*", schema: "public", table: "training_session_members", filter: `session_id=eq.${session.id}` }, refetchMembers)
      .on("postgres_changes", { event: "*", schema: "public", table: "workout_sessions" }, onWorkoutSessionChange)
      .subscribe((status) => {
        if (status === "SUBSCRIBED") setRealtimeStatus("live");
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") setRealtimeStatus("offline");
      });

    return () => { supabase.removeChannel(channel); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, userId]);

  // ── Screen: choice ───────────────────────────────────────────────────
  if (mode === "choice") {
    return (
      <div className="ft-card" style={{ padding: 18 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <div style={{ fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", gap: 7 }}>
            <Users size={16} color={C.ember} /> Train with a partner
          </div>
          <button className="ft-btn ft-btn-ghost" style={{ padding: "4px 8px" }} onClick={onExit}><X size={14} /></button>
        </div>
        <div style={{ fontSize: 12, color: C.creamDim, marginBottom: 14, lineHeight: 1.5 }}>
          Host a session and your exercise queue becomes the shared plan — up to 3 others can join, on their own phones or yours. Or join someone else's session already running.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <button
            className="ft-card" onClick={startHosting} disabled={loadingAction}
            style={{ padding: 14, textAlign: "left", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, opacity: loadingAction ? 0.6 : 1 }}
          >
            <div style={{ width: 32, height: 32, borderRadius: "50%", background: `${C.ember}22`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <Users size={15} color={C.ember} />
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13.5 }}>Host a workout</div>
              <div style={{ fontSize: 11, color: C.creamDim }}>Your queue leads — up to 3 people can join and follow it live.</div>
            </div>
          </button>
          <button
            className="ft-card" onClick={openJoinPicker} disabled={loadingAction}
            style={{ padding: 14, textAlign: "left", cursor: "pointer", display: "flex", alignItems: "center", gap: 10, opacity: loadingAction ? 0.6 : 1 }}
          >
            <div style={{ width: 32, height: 32, borderRadius: "50%", background: `${C.lime}22`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <Users size={15} color={C.lime} />
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13.5 }}>Join a workout</div>
              <div style={{ fontSize: 11, color: C.creamDim }}>Copy someone's session and follow along, your own numbers.</div>
            </div>
            {loadingAction && <RefreshCw size={13} style={{ marginLeft: "auto", animation: "spin 1.2s linear infinite" }} />}
          </button>
        </div>
      </div>
    );
  }

  // ── Screen: browsing open sessions to join ───────────────────────────
  if (mode === "joinPick") {
    return (
      <div className="ft-card" style={{ padding: 18 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Open sessions</div>
          <button className="ft-btn ft-btn-ghost" style={{ padding: "4px 8px" }} onClick={() => setMode("choice")}><X size={14} /></button>
        </div>
        {openSessions.length === 0 ? (
          <div style={{ fontSize: 13, color: C.creamDim }}>Nobody's hosting right now — have them tap "Host a workout" first.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {openSessions.map(s => {
              const full = s.memberCount >= MAX_MEMBERS;
              return (
                <button
                  key={s.id} onClick={() => !full && joinSession(s)} disabled={loadingAction || full}
                  style={{
                    display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
                    background: C.raised, border: `1px solid ${C.border}`, borderRadius: 10,
                    color: C.cream, fontSize: 13, fontWeight: 600, cursor: full ? "default" : "pointer",
                    textAlign: "left", opacity: full || loadingAction ? 0.55 : 1,
                  }}
                >
                  <div style={{ width: 30, height: 30, borderRadius: "50%", background: `linear-gradient(135deg, ${C.ember}, ${C.lime})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: C.bg, flexShrink: 0 }}>
                    {s.hostName?.[0]?.toUpperCase() || "?"}
                  </div>
                  <div style={{ flex: 1 }}>
                    {s.hostName}
                    <div style={{ fontSize: 10.5, color: C.creamDim, fontWeight: 500 }}>{s.memberCount + 1}/{MAX_MEMBERS + 1} in session{full ? " · full" : ""}</div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // ── Screen: in a session (hosting or joined) ─────────────────────────
  if (!session) return null;

  if (isHost) {
    return (
      <div>
        <div className="ft-card" style={{ padding: "10px 14px", marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: C.creamDim }}>
            <Users size={14} color={C.ember} /> Hosting · <b style={{ color: C.cream }}>{members.length + 1}</b>/{MAX_MEMBERS + 1}
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 8, fontSize: 10.5, color: realtimeStatus === "live" ? C.lime : C.creamDim }}>
              {realtimeStatus === "live" ? <Wifi size={11} /> : <WifiOff size={11} />}
              {realtimeStatus === "live" ? "Live sync" : realtimeStatus === "connecting" ? "Connecting…" : "Sync unavailable"}
            </span>
          </div>
          <button className="ft-btn ft-btn-ghost" style={{ fontSize: 11.5 }} onClick={endOrLeave}><LogOut size={12} /> End session</button>
        </div>

        <div style={{ marginBottom: 8, fontWeight: 700, fontSize: 12.5, color: C.ember, textTransform: "uppercase", letterSpacing: "0.03em" }}>{userName || "You"} — building the queue</div>
        <SplitDashboard
          userId={userId}
          userSplitId={userSplitId}
          splitStartedOn={splitStartedOn}
          onSplitChange={onSplitChange}
          workoutSessions={workoutSessions}
          setWorkoutSessions={setWorkoutSessions}
          latestWeight={latestWeight}
          gender={gender}
          subTab="trainDay"
          setTab={() => {}}
          onBlocksChange={handleHostBlocksChange}
          onDirtyChange={setHostDirty}
          dedicatedProgressiveOverload={dedicatedProgressiveOverload}
          customDayPlans={customDayPlans}
          onSaveCustomDayPlan={onSaveCustomDayPlan}
          onDeleteCustomDayPlan={onDeleteCustomDayPlan}
          customSplitTemplates={customSplitTemplates}
          onSaveCustomSplitTemplate={onSaveCustomSplitTemplate}
          onDeleteCustomSplitTemplate={onDeleteCustomSplitTemplate}
          workoutAttendance={workoutAttendance}
          onToggleWorkoutAttendance={onToggleWorkoutAttendance}
        />

        <div style={{ marginTop: 16, marginBottom: 8, fontWeight: 700, fontSize: 12.5, color: C.lime, textTransform: "uppercase", letterSpacing: "0.03em" }}>Joined with you</div>
        <GroupTrainingBoard
          sessionId={session.id}
          currentUserId={userId}
          isHost={true}
          hostUserId={userId}
          hostName={userName || "You"}
          hostBlocks={session.hostBlocks || []}
          members={members}
          peopleData={peopleData}
          onHostBlocksChange={handleHostBlocksChangeImmediate}
          onSetOverride={() => {}}
          onLogSet={handleLogSet}
          onForceResync={handleForceResync}
          onEndOrLeave={endOrLeave}
          hideOwnRow={true}
        />
      </div>
    );
  }

  // Joined (non-host) view — just the board, everyone visible, only your own row editable.
  return (
    <div>
      <div className="ft-card" style={{ padding: "10px 14px", marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: C.creamDim }}>
          <Users size={14} color={C.lime} /> Following <b style={{ color: C.cream }}>{session.hostName || "Host"}</b>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 8, fontSize: 10.5, color: realtimeStatus === "live" ? C.lime : C.creamDim }}>
            {realtimeStatus === "live" ? <Wifi size={11} /> : <WifiOff size={11} />}
            {realtimeStatus === "live" ? "Live sync" : realtimeStatus === "connecting" ? "Connecting…" : "Sync unavailable"}
          </span>
        </div>
        <button className="ft-btn ft-btn-ghost" style={{ fontSize: 11.5 }} onClick={endOrLeave}><LogOut size={12} /> Leave session</button>
      </div>

      <GroupTrainingBoard
        sessionId={session.id}
        currentUserId={userId}
        isHost={false}
        hostUserId={session.hostUserId}
        hostName={session.hostName || "Host"}
        hostBlocks={session.hostBlocks || []}
        members={members}
        peopleData={peopleData}
        onHostBlocksChange={() => {}}
        onSetOverride={handleSetOverride}
        onLogSet={handleLogSet}
        onForceResync={() => {}}
        onEndOrLeave={endOrLeave}
        hideOwnRow={false}
      />
    </div>
  );
}

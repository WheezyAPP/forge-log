// Partner Training — train alongside someone else on the same account
// system. Deliberately built as ONE feature covering three scenarios at
// once, rather than three separate modes:
//
//   1. "Logging for" a partner: with the screen split, whoever is
//      physically holding the phone can just tap into either side and
//      log for that person — no separate mode needed, the split-screen
//      IS the logging-for mechanism.
//   2. True split-screen: both profiles are simultaneously active, each
//      with its own independent exercise picker, sets, and save button.
//      Reuses SplitDashboard mounted twice rather than duplicating its
//      logic — it's already fully prop-driven with no hidden dependency
//      on "being the app's one active user", so this was a clean reuse
//      rather than a rewrite.
//   3. Real-time sync: if your partner has the app open on their own
//      separate phone and logs a set there, your view of their side
//      updates live via a Supabase Realtime subscription on
//      workout_sessions — no manual refresh needed.
//
// Design decisions made without being able to check back on them first:
//   - Each side saves independently. A shared "save both at once" button
//     was considered and rejected — if one save fails, you don't want to
//     lose the other person's data too. Independent saves are strictly
//     more robust, at the cost of two taps instead of one.
//   - Each side's exercise picker/swap/history is fully independent —
//     no shared or linked state between the two panels beyond both being
//     visible on screen together.

import { useState, useEffect, useMemo } from "react";
import { Users, X, RefreshCw, Wifi, WifiOff } from "lucide-react";
import SplitDashboard from "./SplitDashboard";
import { fetchUsers, loadProfile, loadEntries, loadWorkoutSessions, getUserSplitId, getUserSplitStartedOn } from "../lib/storage";
import { supabase } from "../lib/supabase";

const C = {
  bg: "#1C1E26", surface: "#262933", raised: "#30343E",
  border: "#40465A", cream: "#F3F5F9", creamDim: "#9CA1B5", ember: "#4FADFF",
  lime: "#2BE6A8",
};

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function PartnerTraining({
  userId, userName, userSplitId, splitStartedOn, workoutSessions, setWorkoutSessions,
  latestWeight, gender, dedicatedProgressiveOverload, onSplitChange, onExit,
}) {
  const [allUsers, setAllUsers] = useState([]);
  const [partnerId, setPartnerId] = useState(null);
  const [partnerName, setPartnerName] = useState(null);
  const [partnerData, setPartnerData] = useState(null); // { profile, latestWeight, userSplitId, splitStartedOn }
  const [loadingPartner, setLoadingPartner] = useState(false);
  const [realtimeStatus, setRealtimeStatus] = useState("connecting"); // connecting | live | offline
  // The host's current exercise queue, reported live by their
  // SplitDashboard instance via onBlocksChange — this is what "Follow my
  // partner" reads. Weight/reps are deliberately NOT included here, only
  // exercise/group/set-count, since each person's suggested weight
  // should come from their own history.
  const [hostBlocks, setHostBlocks] = useState([]);

  useEffect(() => {
    fetchUsers().then(setAllUsers);
  }, []);

  const otherUsers = useMemo(() => allUsers.filter(u => u.id !== userId), [allUsers, userId]);

  async function choosePartner(u) {
    setLoadingPartner(true);
    try {
      const [profile, entries, splitId, splitStart, sessions] = await Promise.all([
        loadProfile(u.id), loadEntries(u.id), getUserSplitId(u.id), getUserSplitStartedOn(u.id), loadWorkoutSessions(u.id),
      ]);
      const dates = Object.keys(entries).sort();
      const latest = dates[dates.length - 1];
      setPartnerData({
        profile,
        latestWeight: latest ? entries[latest].weight ?? null : null,
        userSplitId: splitId,
        splitStartedOn: splitStart,
        workoutSessions: sessions,
      });
      setPartnerName(u.name);
      setPartnerId(u.id);
    } finally {
      setLoadingPartner(false);
    }
  }

  function exitPartnerMode() {
    setPartnerId(null);
    setPartnerData(null);
    setPartnerName(null);
  }

  // Each side's workoutSessions is refetched independently rather than
  // trying to keep one shared array in sync across two SplitDashboard
  // instances with different userIds — simpler, and matches the
  // "fully independent panels" decision above.
  function partnerSetWorkoutSessions(updater) {
    setPartnerData(prev => {
      if (!prev) return prev;
      // SplitDashboard calls this the same way it calls the real one —
      // sometimes with a value, sometimes with an updater function.
      const current = prev.workoutSessions || [];
      const next = typeof updater === "function" ? updater(current) : updater;
      return { ...prev, workoutSessions: next };
    });
  }

  function handlePartnerSplitChange(splitId) {
    setPartnerData(prev => prev ? { ...prev, userSplitId: splitId, splitStartedOn: todayStr() } : prev);
  }

  // Real-time sync — only active once a partner is actually chosen.
  // Subscribes to both user_ids so this also catches the case where
  // *you're* being logged for on a third device while watching here.
  useEffect(() => {
    if (!partnerId) return;
    setRealtimeStatus("connecting");

    async function refetchPartner() {
      const sessions = await loadWorkoutSessions(partnerId);
      setPartnerData(prev => prev ? { ...prev, workoutSessions: sessions } : prev);
    }
    async function refetchSelf() {
      const sessions = await loadWorkoutSessions(userId);
      setWorkoutSessions(sessions);
    }

    const channel = supabase
      .channel(`partner-training-${userId}-${partnerId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "workout_sessions", filter: `user_id=eq.${partnerId}` }, refetchPartner)
      .on("postgres_changes", { event: "*", schema: "public", table: "workout_sessions", filter: `user_id=eq.${userId}` }, refetchSelf)
      .subscribe((status) => {
        if (status === "SUBSCRIBED") setRealtimeStatus("live");
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") setRealtimeStatus("offline");
      });

    return () => { supabase.removeChannel(channel); };
  }, [partnerId, userId, setWorkoutSessions]);

  if (!partnerId) {
    return (
      <div className="ft-card" style={{ padding: 18 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <div style={{ fontWeight: 700, fontSize: 14, display: "flex", alignItems: "center", gap: 7 }}>
            <Users size={16} color={C.ember} /> Train with a partner
          </div>
          <button className="ft-btn ft-btn-ghost" style={{ padding: "4px 8px" }} onClick={onExit}><X size={14} /></button>
        </div>
        <div style={{ fontSize: 12, color: C.creamDim, marginBottom: 14, lineHeight: 1.5 }}>
          Pick who you're training with. The screen splits in two — your day on one side, theirs on the other — each fully independent with its own save. If they've also got the app open on their own phone, changes on either side show up live on both.
        </div>
        {otherUsers.length === 0 ? (
          <div style={{ fontSize: 13, color: C.creamDim }}>No other profiles on this account yet.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {otherUsers.map(u => (
              <button
                key={u.id}
                onClick={() => choosePartner(u)}
                disabled={loadingPartner}
                style={{
                  display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
                  background: C.raised, border: `1px solid ${C.border}`, borderRadius: 10,
                  color: C.cream, fontSize: 13, fontWeight: 600, cursor: "pointer", textAlign: "left",
                  opacity: loadingPartner ? 0.6 : 1,
                }}
              >
                <div style={{ width: 30, height: 30, borderRadius: "50%", background: `linear-gradient(135deg, ${C.ember}, ${C.lime})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color: C.bg, flexShrink: 0 }}>
                  {u.name?.[0]?.toUpperCase() || "?"}
                </div>
                {u.name}
                {loadingPartner && <RefreshCw size={13} style={{ marginLeft: "auto", animation: "spin 1.2s linear infinite" }} />}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="ft-card" style={{ padding: "10px 14px", marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: C.creamDim }}>
          <Users size={14} color={C.ember} /> Training with <b style={{ color: C.cream }}>{partnerName}</b>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 8, fontSize: 10.5, color: realtimeStatus === "live" ? C.lime : C.creamDim }}>
            {realtimeStatus === "live" ? <Wifi size={11} /> : <WifiOff size={11} />}
            {realtimeStatus === "live" ? "Live sync" : realtimeStatus === "connecting" ? "Connecting…" : "Sync unavailable"}
          </span>
        </div>
        <button className="ft-btn ft-btn-ghost" style={{ fontSize: 11.5 }} onClick={exitPartnerMode}>
          <X size={12} /> End partner session
        </button>
      </div>

      <div className="ft-mobile-stack" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
        <div>
          <div style={{ textAlign: "center", fontWeight: 700, fontSize: 12.5, color: C.ember, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.03em" }}>
            {userName || "You"}
          </div>
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
            onBlocksChange={setHostBlocks}
            dedicatedProgressiveOverload={dedicatedProgressiveOverload}
          />
        </div>
        <div>
          <div style={{ textAlign: "center", fontWeight: 700, fontSize: 12.5, color: C.lime, marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.03em" }}>
            {partnerName}
          </div>
          {partnerData && (
            <SplitDashboard
              userId={partnerId}
              userSplitId={partnerData.userSplitId}
              splitStartedOn={partnerData.splitStartedOn}
              onSplitChange={handlePartnerSplitChange}
              workoutSessions={partnerData.workoutSessions || []}
              setWorkoutSessions={partnerSetWorkoutSessions}
              latestWeight={partnerData.latestWeight}
              gender={partnerData.profile?.gender}
              subTab="trainDay"
              setTab={() => {}}
              followSource={hostBlocks}
              dedicatedProgressiveOverload={partnerData.profile?.dedicatedProgressiveOverload}
            />
          )}
        </div>
      </div>
    </div>
  );
}

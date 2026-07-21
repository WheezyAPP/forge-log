import { useState, useEffect, useMemo } from "react";
import {
  Dumbbell, ChevronDown, ChevronUp, CalendarDays, Target, Check, RotateCcw,
  Repeat, ExternalLink, X as XIcon, ChevronRight, ArrowLeft, History, Trophy,
  AlertTriangle, TrendingUp, Plus, Trash2, Moon, Zap, Lock, Users, Eye, Search, BookmarkPlus, List,
} from "lucide-react";
import {
  SPLITS, pickExercises, getFixedProgram, EX, WEAK_POINT_OPTIONS, WEAK_POINT_MAX_PICKS,
  buildWeakDayGroups, calcAttendanceGrade, getProgressionSuggestion, ANATOMICAL_GROUPS as OFF_SPLIT_GROUPS,
  computeSetCoverage,
} from "../lib/splits";
import {
  setUserSplitId, getUserWeakPointGroups, setUserWeakPointGroups,
  insertWorkoutSessions, deleteWorkoutSession,
} from "../lib/storage";
import { EXERCISE_LINKS } from "../overload/exerciseLinks";
import { toastError } from "../lib/toast";
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";

const DAY_NAMES = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const MON_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DIFF_COLORS = {
  "Beginner": "#2BE6A8", "Lower Intermediate": "#8B93C9",
  "Advanced Intermediate": "#4FADFF", "Advanced": "#FF7A85",
};

// Bodyweight-loaded lifts — the "weight" isn't something to type in from
// scratch, it's your actual bodyweight (minus assistance, if the variant
// is assisted). Rather than making everyone hunt down and manually enter
// their bodyweight every set, this pulls it from the most recent Daily
// Log weight automatically. Covers pull-ups and dips — mechanically the
// same situation, just different movements.
const BODYWEIGHT_LOADED_EXERCISES = new Set([
  "Pull-Up", "Pull-Ups", "Chin-Ups", "Wide-Grip Pull-Ups", "Wide-Grip Pull-Up",
  "Neutral-Grip Pull-Up", "Neutral-Grip Pullup", "Medium-Grip Pull-Up",
  "Commando Pull-Ups", "Archer Pull-Ups", "Australian Pull-Ups", "L-Sit Pull-Ups",
  "Assisted Pull-Up", "Wide-Grip Band-Assisted Pull-Up",
  "Bench Dip", "Bench Dips", "Bodyweight Dip", "Chest Dips", "Dips",
  "Close-Grip Assisted Dip", "Paused Assisted Dip",
]);
function isAssistedBodyweight(name) {
  return /assisted/i.test(name || "") && (/pull-?up/i.test(name || "") || /dip/i.test(name || ""));
}

// Glute-ham raises and Nordic curls anchor the lower legs and move the
// torso against gravity — real resistance, but nowhere near full
// bodyweight the way a pull-up is (the anchor point takes a real share
// of the load). Rather than a fixed number, this adds a percentage of
// bodyweight on top of whatever extra weight is actually entered, so the
// user only has to log added weight and reps, same spirit as the
// assisted-pullup treatment but partial instead of full/subtracted.
const GLUTE_HAM_BODYWEIGHT_EXERCISES = new Set([
  "Glute-Ham Raise", "Slow-Eccentric Glute-Ham Raise",
  "Nordic Ham Curl", "Nordic Hamstring Curls", "Nordic Curls", "Reverse Nordic",
]);
function gluteHamBodyweightPct(gender) {
  return gender === "female" ? 0.3 : 0.5;
}
const C = {
  bg:"#1C1E26", surface:"#262933", raised:"#30343E",
  border:"#40465A", cream:"#F3F5F9", creamDim:"#9CA1B5", ember:"#4FADFF",
  lime:"#2BE6A8", warn:"#FF7A85", amber:"#8B93C9",
};

// Flattened, deduped exercise → group lookup for the off-split search bar —
// built once at module load, not per-render, since it only depends on the
// static EX database. Scoped to the same 9 anatomical groups shown as
// tiles (not the "Bodyweight X" categories) so a search result always
// lands on a group you could've picked by tapping a tile instead.
const OFF_SPLIT_EXERCISES = (() => {
  const seen = new Set();
  const list = [];
  for (const group of OFF_SPLIT_GROUPS) {
    const db = EX[group];
    if (!db) continue;
    for (const exercise of [...(db.primary||[]), ...(db.compound||[]), ...(db.isolation||[])]) {
      if (seen.has(exercise)) continue;
      seen.add(exercise);
      list.push({ exercise, group });
    }
  }
  return list.sort((a, b) => a.exercise.localeCompare(b.exercise));
})();

function fmtDay(d) { return `${DAY_NAMES[d.getDay()]} ${MON_NAMES[d.getMonth()]} ${d.getDate()}`; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function epley1RM(w, r) { return r === 1 ? w : Math.round(w * (1 + r / 30)); }
function sessionVolume(sets) { return (sets||[]).reduce((s,x) => s + (parseFloat(x.weight)||0)*(parseFloat(x.reps)||0), 0); }
function sessionBest1RM(sets) { return (sets||[]).reduce((b,x) => { const v = epley1RM(parseFloat(x.weight)||0, parseInt(x.reps)||0); return v > b ? v : b; }, 0); }
// Consistent number formatting (no "172.40000001", comma-separated thousands
// for volume totals) — same convention as the app-wide fmt() helper.
function fmtN(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Math.round(n).toLocaleString();
}

function loadDismissed(userId) {
  try { return JSON.parse(localStorage.getItem(`forge_dismissed_deloads_${userId}`) || "{}"); } catch { return {}; }
}
function saveDismissed(userId, obj) {
  try { localStorage.setItem(`forge_dismissed_deloads_${userId}`, JSON.stringify(obj)); } catch {}
}

const PR_LABELS = { e1RM: "Est. 1RM", volume: "Volume", weight: "Top weight" };

function computePRFlags(sessions) {
  // Same-day duplicates need a real chronological tiebreak — id used to
  // be used for this, but ids are random UUIDs, not chronologically
  // sortable, so which of two same-day sessions "counted first" (and
  // therefore which one could show a PR badge) was effectively random.
  const sorted = [...sessions].sort((a,b) => a.date.localeCompare(b.date) || (a.createdAt || "").localeCompare(b.createdAt || "") || String(a.id).localeCompare(String(b.id)));
  const best = {}; const seen = new Set(); const flags = {};
  for (const s of sorted) {
    const filled = (s.sets||[]).filter(x => x.weight && x.reps);
    if (!filled.length) { flags[s.id] = { isPR:false, prTypes:[] }; continue; }
    const e1 = sessionBest1RM(filled), vol = sessionVolume(filled);
    const top = Math.max(...filled.map(x => parseFloat(x.weight)||0));
    const isFirst = !seen.has(s.exercise); seen.add(s.exercise);
    const prev = best[s.exercise] || { e1:0, vol:0, top:0 };
    const types = [];
    if (!isFirst) {
      if (e1 > prev.e1) types.push("e1RM");
      if (vol > prev.vol) types.push("volume");
      if (top > prev.top) types.push("weight");
    }
    flags[s.id] = { isPR: types.length > 0, prTypes: types };
    best[s.exercise] = { e1: Math.max(prev.e1,e1), vol: Math.max(prev.vol,vol), top: Math.max(prev.top,top) };
  }
  return flags;
}

export default function SplitDashboard({ userId, userSplitId, splitStartedOn, onSplitChange, workoutSessions, setWorkoutSessions, latestWeight, gender, subTab, setTab, followSource, onBlocksChange, dedicatedProgressiveOverload, customDayPlans, onSaveCustomDayPlan, onDeleteCustomDayPlan, customSplitTemplates, onSaveCustomSplitTemplate, onDeleteCustomSplitTemplate }) {
  const [view, setView] = useState("picker");
  const [selected, setSelected] = useState(() => SPLITS.find(s => s.id === userSplitId) || null);
  const [weekNum, setWeekNum] = useState(1);
  const [showDet, setShowDet] = useState(false);
  const [weakPointKeys, setWeakPointKeys] = useState([]);
  const [dayOffset, setDayOffset] = useState(0);
  const [blocks, setBlocks] = useState([]);
  const [saving, setSaving] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  // Ported from OverloadLog (now retired) — [{exercise, prTypes}], shown
  // as a celebration banner right after a save that beat a prior best.
  const [justSavedPRs, setJustSavedPRs] = useState([]);
  const [selectedLift, setSelectedLift] = useState(null);
  const [dismissed, setDismissed] = useState(() => loadDismissed(userId));
  const [swapOpen, setSwapOpen] = useState(null);
  const [offSplitPickerOpen, setOffSplitPickerOpen] = useState(false);
  const [offSplitSearch, setOffSplitSearch] = useState("");
  const [optionalDayPickerOpen, setOptionalDayPickerOpen] = useState(null); // holds the day object (position 3) while picking, or null
  const [expandedDoneDay, setExpandedDoneDay] = useState(null); // holds a day.i while its "tap to view" summary is open, separate from tapping the card itself (which edits)
  // Assisted pull-ups: what you type is the assist amount, not the final
  // weight — this holds that raw input per set (keyed "blockIndex-setIndex")
  // separately from s.w, which stores the computed effective weight
  // (bodyweight minus assist) that the rest of the app's progression and
  // volume logic actually reads.
  const [assistInputs, setAssistInputs] = useState({});

  // Reports the current day's exercise queue up to whoever's rendering
  // this — a no-op for normal solo use (nobody's listening), but this is
  // what lets Partner Training's "Follow my partner" option know what
  // the host currently has queued for today, live, before it's even
  // saved. Deliberately reports exercise/group/set-count only, not
  // weight or reps — those stay personalized per person.
  useEffect(() => {
    if (!onBlocksChange) return;
    onBlocksChange(blocks.map(b => ({ exercise: b.exercise, grp: b.grp, setCount: b.sets.length })));
  }, [blocks, onBlocksChange]);

  useEffect(() => {
    const s = SPLITS.find(s => s.id === userSplitId);
    setSelected(s || null);
    setView(s ? "locked" : "picker");
  }, [userSplitId]);

  useEffect(() => {
    if (!userId) return;
    (async () => setWeakPointKeys((await getUserWeakPointGroups(userId)) || []))();
  }, [userId]);

  // NOT memoized with an empty dependency array — that version silently
  // went stale if this component stayed mounted across a midnight
  // boundary (logging a late workout, or just leaving the tab open),
  // which is exactly what caused sessions to save under the wrong date
  // relative to what "today" actually was by the time you hit save.
  // Date creation is trivially cheap, so there's no real cost to just
  // recomputing this on every render instead.
  const today = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();

  const effectiveSplit = useMemo(() => {
    if (!selected) return null;
    if (selected.id !== "ppl_weak_day") return selected;
    const wd = buildWeakDayGroups(weakPointKeys);
    return { ...selected, defs: { ...selected.defs, "Weak Day": { ...selected.defs["Weak Day"], groups: wd.groups, label: wd.label } } };
  }, [selected, weakPointKeys]);

  async function toggleWeakPoint(key) {
    setWeakPointKeys(prev => {
      let next;
      if (prev.includes(key)) next = prev.filter(k => k !== key);
      else if (prev.length >= WEAK_POINT_MAX_PICKS) return prev;
      else next = [...prev, key];
      setUserWeakPointGroups(userId, next, selected?.id);
      return next;
    });
  }
  function resetWeakPoint() { setWeakPointKeys([]); setUserWeakPointGroups(userId, [], selected?.id); }

  async function choose(split) {
    setSelected(split); setWeekNum(1);
    await setUserSplitId(userId, split.id);
    onSplitChange(split.id);
    setView("locked");
    setTab?.("trainDay");
  }
  function changeSplit() {
    if (window.confirm("Switch splits? You'll pick a new schedule from scratch — your logged workouts stay in History either way.")) {
      setView("picker");
      setTab?.("splitInfo");
    }
  }

  // Custom day plan builder — a one-time forward plan for specific
  // dates, not a reusable split. planDrafts is null when the planner
  // isn't open; populated from whatever's already saved (so reopening
  // to tweak a day doesn't mean starting over) the moment it opens.
  const [planDrafts, setPlanDrafts] = useState(null);
  const [planSearch, setPlanSearch] = useState({});
  // Holds the dateKey of whichever day's card opened the full A-Z browse
  // modal (null when closed) — lets someone scan every exercise in the
  // database instead of only typing a search, same OFF_SPLIT_EXERCISES
  // list already used for search, just unfiltered and grouped by letter.
  const [browseOpen, setBrowseOpen] = useState(null);

  function openPlanWeek() {
    const drafts = {};
    for (let i = 0; i < 7; i++) {
      const dateKey = localDateStr(addDays(today, i));
      const existing = customDayPlans?.[dateKey];
      drafts[dateKey] = existing
        ? { dayType: existing.isRest ? "" : existing.dayType, isRest: existing.isRest, exercises: existing.exercises }
        : { dayType: "", isRest: false, exercises: [] };
    }
    setPlanDrafts(drafts);
    setPlanSearch({});
    setView("planWeek");
  }
  function updateDraft(dateKey, patch) {
    setPlanDrafts(prev => ({ ...prev, [dateKey]: { ...prev[dateKey], ...patch } }));
  }
  function addDraftExercise(dateKey, ex) {
    setPlanDrafts(prev => {
      const draft = prev[dateKey];
      if (draft.exercises.some(e => e.exercise === ex.exercise)) return prev; // no dupes
      return { ...prev, [dateKey]: { ...draft, exercises: [...draft.exercises, ex] } };
    });
    setPlanSearch(prev => ({ ...prev, [dateKey]: "" }));
  }
  function removeDraftExercise(dateKey, exercise) {
    setPlanDrafts(prev => ({ ...prev, [dateKey]: { ...prev[dateKey], exercises: prev[dateKey].exercises.filter(e => e.exercise !== exercise) } }));
  }
  async function clearPlannedDay(dateKey) {
    setPlanDrafts(prev => ({ ...prev, [dateKey]: { dayType: "", isRest: false, exercises: [] } }));
    await onDeleteCustomDayPlan?.(dateKey);
  }
  async function lockInWeek() {
    for (let i = 0; i < 7; i++) {
      const dateKey = localDateStr(addDays(today, i));
      const draft = planDrafts[dateKey];
      const touched = draft.isRest || draft.dayType.trim() || draft.exercises.length > 0;
      if (!touched) continue;
      await onSaveCustomDayPlan?.({
        date: dateKey,
        dayType: draft.isRest ? "Rest" : (draft.dayType.trim() || "Planned day"),
        isRest: draft.isRest,
        exercises: draft.exercises,
      });
    }
    setView("locked");
  }

  // Templates store day-slots by RELATIVE position (Day 1..7), not real
  // dates — applying one just maps those 7 slots onto whichever 7 real
  // dates the planner currently has open, so the same template can be
  // reused on any future week without ever touching the dates it was
  // originally built for.
  const [templateNameInput, setTemplateNameInput] = useState("");
  const [templatePromptOpen, setTemplatePromptOpen] = useState(false);

  function applyTemplate(template) {
    const drafts = {};
    for (let i = 0; i < 7; i++) {
      const dateKey = localDateStr(addDays(today, i));
      const slot = template.days[i] || { dayType: "", isRest: false, exercises: [] };
      drafts[dateKey] = { dayType: slot.dayType || "", isRest: !!slot.isRest, exercises: slot.exercises || [] };
    }
    setPlanDrafts(drafts);
  }
  function saveAsTemplate() {
    const name = templateNameInput.trim();
    if (!name) return;
    const days = Array.from({ length: 7 }, (_, i) => {
      const dateKey = localDateStr(addDays(today, i));
      const draft = planDrafts[dateKey];
      return { dayType: draft.dayType, isRest: draft.isRest, exercises: draft.exercises };
    });
    onSaveCustomSplitTemplate?.({ name, days });
    setTemplateNameInput("");
    setTemplatePromptOpen(false);
  }

  const phaseLabel = weekNum <= 4 ? "Foundation — building habits" : weekNum <= 8 ? "Progression — increasing variety" : "Peak — full rotation active";

  const preview10 = useMemo(() => {
    if (!effectiveSplit) return [];
    return Array.from({ length: 10 }, (_, i) => {
      const date = addDays(today, i);
      const pi = (date.getDay() + 6) % 7;
      const dayType = effectiveSplit.pattern[pi];
      const isRest = dayType === "Rest";
      const def = isRest ? null : effectiveSplit.defs[dayType];
      // Which occurrence of this day type within the week (0-based) —
      // decides which fixed program variant (A/B/...) applies, if any.
      const occ = effectiveSplit.pattern.slice(0, pi).filter(t => t === dayType).length;
      const program = def ? getFixedProgram(def, occ) : null;
      const exs = program
        ? program.reduce((acc, p) => { (acc[p.group] ||= []).push(p.ex); return acc; }, {})
        : def ? Object.fromEntries(def.groups.map(g => [g.n, pickExercises(g.n, weekNum, i, g.c)])) : {};
      return { i, date, dateStr: fmtDay(date), dayType, isRest, def, occ, exs };
    });
  }, [effectiveSplit, today, weekNum]);

  const next3 = useMemo(() => {
    if (!effectiveSplit) return [];
    return Array.from({ length: 4 }, (_, i) => {
      const date = addDays(today, i);
      const dateKey = localDateStr(date);
      const loggedSessions = workoutSessions.filter(s => s.date === dateKey && s.splitId === userSplitId);
      // A custom-planned date overrides whatever the assigned split's
      // repeating pattern would normally show — but only for dates
      // actually planned. Anything past the planned range (or a date
      // that was never planned) falls straight through to the regular
      // pattern below, unaffected.
      const custom = customDayPlans?.[dateKey];
      if (custom) {
        return {
          i, date, dateKey, dateStr: fmtDay(date),
          dayType: custom.dayType, isRest: custom.isRest, def: null, occ: 0,
          isToday: i === 0, isDone: loggedSessions.length > 0, loggedSessions,
          customExercises: custom.isRest ? null : custom.exercises,
          isCustomPlanned: true,
        };
      }
      const pi = (date.getDay() + 6) % 7;
      const dayType = effectiveSplit.pattern[pi];
      const isRest = dayType === "Rest";
      const def = isRest ? null : effectiveSplit.defs[dayType];
      const occ = effectiveSplit.pattern.slice(0, pi).filter(t => t === dayType).length;
      return { i, date, dateKey, dateStr: fmtDay(date), dayType, isRest, def, occ, isToday: i === 0, isDone: loggedSessions.length > 0, loggedSessions, customExercises: null, isCustomPlanned: false };
    });
  }, [effectiveSplit, today, workoutSessions, userSplitId, customDayPlans]);

  function openDay(day) {
    setDayOffset(day.i);
    if (day.isRest) { setView("rest"); return; }
    buildDayBlocks(day);
    setView("day");
    setJustSaved(false);
    setJustSavedPRs([]);
  }
  function openAdhoc(day) { setDayOffset(day.i); setBlocks([]); setView("day"); setJustSaved(false); setJustSavedPRs([]); }

  // "Follow my partner" — always today, since this only makes sense for
  // a live joint session, not planning out someone else's future days.
  // Mirrors which exercises the host has queued, but every weight
  // suggestion comes from THIS user's own logged history for that
  // exercise, same as any other day — two people doing "the same
  // workout" should still each see their own numbers, not the host's.
  function openFollowPartner() {
    setDayOffset(0);
    setBlocks(followSource.map(item => {
      const history = workoutSessions.filter(s => s.exercise === item.exercise);
      const dismissedAt = dismissed[item.exercise] ?? null;
      const sugg = getProgressionSuggestion(history, item.grp, item.exercise, dismissedAt, dedicatedProgressiveOverload);
      const w = defaultWeightFor(item.exercise, sugg);
      const n = Math.max(1, item.setCount || 3);
      return {
        exercise: item.exercise, grp: item.grp,
        sets: Array.from({ length: n }, () => ({ w, r: "", rpe: "" })),
        sugg, repTarget: sugg?.targetReps,
        followedFrom: true,
      };
    }));
    setView("day");
    setJustSaved(false);
    setJustSavedPRs([]);
  }

  // The 4th schedule slot is always "Optional Day" rather than whatever
  // the calendar pattern would auto-assign that far out — the date stays
  // fixed (today+3), but which day-type gets trained there becomes your
  // choice instead of the split's rotation deciding for you. Reuses
  // buildDayBlocks with a synthetic day object rather than duplicating
  // its program/exercise-selection logic.
  function chooseOptionalDayType(day, dayTypeName) {
    const def = effectiveSplit.defs[dayTypeName];
    setDayOffset(day.i);
    buildDayBlocks({ ...day, dayType: dayTypeName, isRest: false, def, occ: 0 });
    setView("day");
    setJustSaved(false);
    setJustSavedPRs([]);
    setOptionalDayPickerOpen(null);
  }

  function buildDayBlocks(day) {
    if (day.isDone) {
      setBlocks(day.loggedSessions.map(s => ({
        exercise: s.exercise, grp: s.group,
        sets: (s.sets||[]).map(x => ({ w: String(x.weight ?? ""), r: String(x.reps ?? ""), rpe: x.rpe != null ? String(x.rpe) : "" })),
        sourceId: s.id,
        // Assisted pull-ups/dips store the COMPUTED weight (bodyweight
        // minus assist), not the assist number itself — reopening a saved
        // day has no way to recover what you actually typed as the assist
        // amount. Rather than showing a re-editable field that silently
        // means something different than it did originally, this locks
        // it: delete and redo the exercise if it needs to change.
        locked: isAssistedBodyweight(s.exercise),
      })));
      return;
    }
    if (day.customExercises) {
      // A custom-planned day names specific exercises directly rather
      // than a group to auto-pick from — same suggestion/default-weight
      // machinery as everywhere else, just skipping getFixedProgram and
      // the def.groups auto-pick entirely, since there's no "def" to
      // drive here.
      setBlocks(day.customExercises.map(({ exercise, group }) => {
        const history = workoutSessions.filter(s => s.exercise === exercise);
        const dismissedAt = dismissed[exercise] ?? null;
        const sugg = getProgressionSuggestion(history, group, exercise, dismissedAt, dedicatedProgressiveOverload);
        const w = defaultWeightFor(exercise, sugg);
        const sets = [{ w, r:"", rpe:"" }, { w, r:"", rpe:"" }, { w, r:"", rpe:"" }];
        return { exercise, grp: group, sets, sugg };
      }));
      return;
    }
    const program = getFixedProgram(day.def, day.occ ?? 0);
    if (program) {
      setBlocks(program.map(p => {
        const history = workoutSessions.filter(s => s.exercise === p.ex);
        const dismissedAt = dismissed[p.ex] ?? null;
        const sugg = getProgressionSuggestion(history, p.group, p.ex, dismissedAt, dedicatedProgressiveOverload);
        const n = Math.max(1, p.sets || 3);
        const w = defaultWeightFor(p.ex, sugg);
        const sets = Array.from({ length: n }, () => ({ w, r: "", rpe: "" }));
        return { exercise: p.ex, grp: p.group, sets, sugg, repTarget: p.reps };
      }));
      return;
    }
    const newBlocks = [];
    for (const g of day.def.groups) {
      const exs = pickExercises(g.n, weekNum, day.i, g.c);
      for (const ex of exs) {
        const history = workoutSessions.filter(s => s.exercise === ex);
        const dismissedAt = dismissed[ex] ?? null;
        const sugg = getProgressionSuggestion(history, g.n, ex, dismissedAt, dedicatedProgressiveOverload);
        const w = defaultWeightFor(ex, sugg);
        const sets = [{ w, r:"", rpe:"" }, { w, r:"", rpe:"" }, { w, r:"", rpe:"" }];
        newBlocks.push({ exercise: ex, grp: g.n, sets, sugg });
      }
    }
    setBlocks(newBlocks);
  }

  function setVal(bi, si, k, v) {
    setBlocks(prev => prev.map((b,i) => i!==bi ? b : { ...b, sets: b.sets.map((s,j) => j!==si ? s : { ...s, [k]: v }) }));
  }
  // Bodyweight pull-up variants default to your current logged weight
  // instead of an empty field — assisted variants stay blank here since
  // their weight comes from the assist amount you type in the set row.
  // Hoisted to component scope (not nested in buildDayBlocks) so the
  // swap-exercise flow can reuse the exact same priority: a real
  // progression suggestion always wins over the bodyweight default.
  function defaultWeightFor(exerciseName, sugg) {
    if (sugg) return String(sugg.suggestedWeight);
    if (BODYWEIGHT_LOADED_EXERCISES.has(exerciseName) && !isAssistedBodyweight(exerciseName) && latestWeight) {
      return String(latestWeight);
    }
    return "";
  }

  function addSet(bi) {
    setBlocks(prev => prev.map((b,i) => i!==bi ? b : { ...b, sets: [...b.sets, { w:"", r:"", rpe:"" }] }));
  }
  function removeSet(bi, si) {
    setBlocks(prev => prev.map((b,i) => i!==bi ? b : { ...b, sets: b.sets.filter((_,j) => j!==si) }));
  }
  // Deletes a whole exercise from today's workout — distinct from
  // removeSet, which only drops one set. Needed for split days that
  // assign an exercise you're deliberately not doing that day (a common,
  // legitimate reason to skip one lift without it being "off-split").
  function removeBlock(bi) {
    setBlocks(prev => prev.filter((_, i) => i !== bi));
  }
  // Opens a group picker instead of silently defaulting to whatever
  // muscle group the current split day happens to be — you're logging
  // this specifically because it's NOT part of the dedicated day's
  // groups, so guessing one for you would usually guess wrong.
  function addOffSplit() {
    setOffSplitSearch("");
    setOffSplitPickerOpen(true);
  }
  function closeOffSplitPicker() {
    setOffSplitPickerOpen(false);
    setOffSplitSearch("");
  }
  // Shared by both entry points into this modal: tapping a muscle-group
  // tile (which just hands over that group's primary lift) and typing
  // into the search bar (which hands over whichever specific exercise
  // was picked, plus the group it belongs to, skipping the tile step
  // entirely).
  function confirmOffSplitExercise(group, exercise) {
    const history = workoutSessions.filter(s => s.exercise === exercise);
    const dismissedAt = dismissed[exercise] ?? null;
    const sugg = getProgressionSuggestion(history, group, exercise, dismissedAt, dedicatedProgressiveOverload);
    const w = defaultWeightFor(exercise, sugg);
    setBlocks(prev => [...prev, { exercise, grp: group, sets:[{w,r:"",rpe:""}], off:true, sugg, repTarget: sugg?.targetReps }]);
    closeOffSplitPicker();
  }
  function confirmOffSplitGroup(group) {
    confirmOffSplitExercise(group, EX[group]?.primary?.[0] || "");
  }
  function dismissDeload(exercise, bi) {
    const history = workoutSessions.filter(s => s.exercise === exercise);
    const next = { ...dismissed, [exercise]: history.length };
    setDismissed(next); saveDismissed(userId, next);
    const sugg = getProgressionSuggestion(history, blocks[bi].grp, exercise, next[exercise], dedicatedProgressiveOverload);
    setBlocks(prev => prev.map((b,i) => i!==bi ? b : { ...b, sugg }));
  }

  async function handleSaveDay() {
    // Blocks exist but not one has a valid (weight>0 AND reps>0) set —
    // almost always an accidental empty save, not a deliberate one:
    // forgot to fill in a weight, or tapped Save before finishing. This
    // used to fall straight through: delete whatever was already saved
    // for this date, insert nothing in its place, then still show
    // "Saved!" — a workout could vanish with zero indication anything
    // had gone wrong. Bailing out here, before the destructive delete
    // step even runs, is what actually prevents that. An intentionally
    // EMPTY blocks array (every exercise removed on purpose, to clear a
    // day) is still let through below — only "blocks exist but are all
    // invalid" is blocked.
    const hasAnyValidSet = blocks.some(b => b.exercise && b.sets.some(s => parseFloat(s.w) > 0 && parseInt(s.r) > 0));
    if (blocks.length > 0 && !hasAnyValidSet) {
      toastError("Add a weight and reps to at least one set before saving.");
      return;
    }
    setSaving(true);
    const day = next3[dayOffset];
    // Real-life timing wins over the calendar slot: typing in weights and
    // reps means you just DID this work, so if you opened tomorrow's (or
    // +3's) card to log it — because that's the day-type you wanted, or
    // today's card was already used — it still saves under today. Saving
    // under a future date was silently corrupting rolling 7-day set
    // coverage and history ("worked it on the 14th, logged for the 17th").
    const todayKey = localDateStr(new Date());
    const dateKey = day.dateKey > todayKey ? todayKey : day.dateKey;
    // Only replace sessions logged under the CURRENTLY selected split for
    // this date — sessions from a different split (or logged before
    // split-tagging existed) are left alone rather than wiped out just
    // because you happened to reopen this date under a new split.
    const existing = workoutSessions.filter(s => s.date === dateKey && s.splitId === userSplitId);
    for (const s of existing) await deleteWorkoutSession(userId, s.id);

    const toInsert = blocks
      .filter(b => b.exercise && b.sets.some(s => parseFloat(s.w) > 0 && parseInt(s.r) > 0))
      .map(b => ({
        date: dateKey, exercise: b.exercise, group: b.grp,
        sets: b.sets.filter(s => parseFloat(s.w) > 0 && parseInt(s.r) > 0).map(s => {
          const set = { weight: parseFloat(s.w), reps: parseInt(s.r) };
          // Only attached when actually filled in — an absent rpe (vs. a
          // stored null/0) is what lets getProgressionSuggestion tell
          // "never had this feature on" apart from "logged it and RPE
          // genuinely wasn't captured," and keeps old sessions' shape
          // untouched for anyone who never turns Dedicated Progressive
          // Overload on.
          const rpeVal = parseFloat(s.rpe);
          if (!Number.isNaN(rpeVal) && rpeVal > 0) set.rpe = rpeVal;
          return set;
        }),
        splitId: userSplitId,
      }));
    const saved = toInsert.length ? await insertWorkoutSessions(userId, toInsert) : [];

    const nextSessions = [...workoutSessions.filter(s => !(s.date === dateKey && s.splitId === userSplitId)), ...saved];
    setWorkoutSessions(nextSessions);
    // Checked against the FULL updated history (not just today's blocks),
    // same logic the History tab's PR badges use — a session only counts
    // as a PR if it beats everything that came before it.
    const flags = computePRFlags(nextSessions);
    const prs = saved
      .filter(s => flags[s.id]?.isPR)
      .map(s => ({ exercise: s.exercise, prTypes: flags[s.id].prTypes }));
    setJustSavedPRs(prs);
    setSaving(false);
    setJustSaved(true);
  }

  // Recovery tool for exactly the stale-date bug that was just fixed:
  // sessions saved before that fix could be sitting under the wrong
  // date, which throws off Set Coverage and the schedule (a workout
  // dated "tomorrow" doesn't count toward a window ending today — the
  // window logic is correct, the underlying date is what's wrong). This
  // moves an already-saved day's sessions to whatever date they should
  // actually be under, rather than requiring a delete-and-redo.
  const [fixingDate, setFixingDate] = useState(false);
  const [fixDateValue, setFixDateValue] = useState("");
  async function handleFixDate() {
    if (!fixDateValue) return;
    const day = next3[dayOffset];
    const oldDateKey = day.dateKey;
    if (fixDateValue === oldDateKey) { setFixingDate(false); return; }
    const toMove = workoutSessions.filter(s => s.date === oldDateKey && s.splitId === userSplitId);
    for (const s of toMove) await deleteWorkoutSession(userId, s.id);
    const reinserted = toMove.length
      ? await insertWorkoutSessions(userId, toMove.map(s => ({ date: fixDateValue, exercise: s.exercise, group: s.group, sets: s.sets, splitId: s.splitId })))
      : [];
    setWorkoutSessions([...workoutSessions.filter(s => !(s.date === oldDateKey && s.splitId === userSplitId)), ...reinserted]);
    setFixingDate(false);
    setFixDateValue("");
    setView("locked");
  }

  const grade = calcAttendanceGrade(userSplitId, workoutSessions || [], splitStartedOn);

  const historyByExercise = useMemo(() => {
    const map = {};
    for (const s of workoutSessions) { (map[s.exercise] ||= []).push(s); }
    return Object.entries(map).map(([ex, sessions]) => {
      const sorted = [...sessions].sort((a,b) => a.date.localeCompare(b.date) || (a.createdAt || "").localeCompare(b.createdAt || ""));
      const last = sorted[sorted.length-1];
      const best = Math.max(...sorted.map(s => sessionBest1RM(s.sets)));
      const totalVolume = sorted.reduce((sum, s) => sum + sessionVolume(s.sets), 0);
      return { exercise: ex, grp: last.group, sessions: sorted, lastDate: last.date, best, totalVolume };
    }).sort((a,b) => b.lastDate.localeCompare(a.lastDate));
  }, [workoutSessions]);

  const prFlags = useMemo(() => computePRFlags(workoutSessions), [workoutSessions]);

  if (subTab === "splitInfo" || view === "picker") return (
    <div>
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
                <div className="ft-label" style={{ color:C.lime, marginBottom:5 }}>Strengths</div>
                {selected.strengths.map(s => <div key={s} style={{ fontSize:11, color:C.creamDim, padding:"2px 0", display:"flex", gap:5 }}><span style={{color:C.lime}}>✓</span>{s}</div>)}
              </div>
              <div>
                <div className="ft-label" style={{ color:C.warn, marginBottom:5 }}>Weaknesses</div>
                {selected.weaknesses.map(w => <div key={w} style={{ fontSize:11, color:C.creamDim, padding:"2px 0", display:"flex", gap:5 }}><span style={{color:C.warn}}>✗</span>{w}</div>)}
              </div>
            </div>
          )}
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
            <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
              {WEAK_POINT_OPTIONS.map(opt => {
                const active = weakPointKeys.includes(opt.key);
                const disabled = !active && weakPointKeys.length >= WEAK_POINT_MAX_PICKS;
                return (
                  <button key={opt.key} onClick={() => toggleWeakPoint(opt.key)} disabled={disabled} style={{
                    display:"flex", alignItems:"center", gap:5, fontSize:12, fontWeight:600,
                    padding:"6px 12px", borderRadius:20, cursor:disabled?"not-allowed":"pointer",
                    background: active ? "#fb718520" : C.raised, border: `1px solid ${active ? "#fb7185" : C.border}`,
                    color: active ? "#fb7185" : disabled ? C.creamDim+"80" : C.creamDim, opacity: disabled ? 0.5 : 1,
                  }}>
                    {active && <Check size={11} />}{opt.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="ft-card-raised" style={{ padding:"10px 14px", marginBottom:12, display:"flex", alignItems:"center", gap:12, flexWrap:"wrap" }}>
          <span className="ft-label" style={{ marginBottom:0, whiteSpace:"nowrap" }}>3-month variety — week:</span>
          <input type="range" min={1} max={12} value={weekNum} onChange={e => setWeekNum(+e.target.value)} style={{ flex:1, minWidth:80, accentColor:selected.accentColor }} />
          <span style={{ fontSize:13, fontWeight:600, color:selected.accentColor, minWidth:64 }}>Week {weekNum}</span>
          <span style={{ fontSize:11, color:C.creamDim, fontStyle:"italic" }}>{phaseLabel}</span>
        </div>

        <div style={{ fontSize:11, color:C.creamDim, marginBottom:10 }}>
          A preview of your next 10 days — once locked in, you'll only see the next 4 so you can adapt around a missed day. Tap the split card above to lock it in.
        </div>

        <div style={{ overflowX:"auto", paddingBottom:8, WebkitOverflowScrolling:"touch" }}>
          <div style={{ display:"flex", gap:8, minWidth:"max-content" }}>
            {preview10.map(day => {
              const ac = day.def?.color || C.creamDim;
              return (
                <div key={day.i} style={{ background:C.surface, border:`1px solid ${day.isRest?C.border:ac+"60"}`, borderRadius:10, padding:"11px 12px", minWidth:150, maxWidth:160 }}>
                  <div style={{ fontSize:12, fontWeight:600, color:C.cream, marginBottom:2 }}>{day.dateStr}</div>
                  <div style={{ fontSize:8, fontWeight:700, padding:"2px 5px", borderRadius:5, background:day.isRest?C.raised:`${ac}20`, color:day.isRest?C.creamDim:ac, border:`1px solid ${day.isRest?C.border:ac}40`, textTransform:"uppercase", letterSpacing:".04em", display:"inline-block", marginBottom:6 }}>
                    {day.isRest?"Rest":day.dayType}
                  </div>
                  {!day.isRest && day.def && (
                    <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                      {day.def.groups.map(g => (
                        <div key={g.n}>
                          <div style={{ fontSize:8, color:ac, letterSpacing:".06em", textTransform:"uppercase", fontWeight:700 }}>{g.n}</div>
                          {(day.exs[g.n]||[]).slice(0,2).map(ex => <div key={ex} style={{ fontSize:9, color:C.creamDim, paddingLeft:5, borderLeft:`2px solid ${ac}40` }}>{ex}</div>)}
                        </div>
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
          <div style={{ fontSize:13, color:C.creamDim }}>Select a training split above to preview its schedule, then lock it in to start logging.</div>
        </div>
      )}
    </div>
  );

  if (view === "locked") return (
    <div>
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:10, marginBottom:14 }}>
        <div>
          <div style={{ fontSize:10, fontWeight:700, letterSpacing:".08em", textTransform:"uppercase", color:selected.accentColor }}>Locked in</div>
          <div style={{ fontSize:20, fontWeight:800, color:C.cream }}>{selected.name}</div>
        </div>
        <div style={{ display:"flex", gap:8, alignItems:"center" }}>
          {grade && (
            <div className="ft-card-raised" style={{ padding:"8px 14px", textAlign:"center" }}>
              <div style={{ fontSize:9, color:C.creamDim }}>Grade</div>
              <div style={{ fontSize:18, fontWeight:800, color:grade.color }}>{grade.grade}</div>
            </div>
          )}
          <button className="ft-btn ft-btn-ghost" onClick={() => setView("history")}><History size={13}/> History</button>
          <button className="ft-btn ft-btn-ghost" onClick={openPlanWeek}><CalendarDays size={13}/> Plan next 7 days</button>
          <button className="ft-btn ft-btn-ghost" onClick={changeSplit}><RotateCcw size={13}/> Change split</button>
        </div>
      </div>

      <div style={{ fontSize:11, color:C.creamDim, marginBottom:10 }}>Next 4 days — tap one to log it, or reopen a logged day to edit.</div>

      {next3.map(day => {
        const ac = day.def?.color || C.creamDim;
        // The last slot is always "Optional Day" — the date stays fixed,
        // but which day-type gets trained there is your call instead of
        // the split's calendar pattern deciding for you. Once it's
        // actually been logged, it behaves like any other day again
        // (reopen to edit, shows whatever was really done). A custom
        // plan for that date always wins over the generic Optional Day
        // picker — you already made the call in advance, tapping the
        // card should open what you built, not ask you to pick again.
        const isOptionalSlot = day.i === 3 && !day.isDone && !day.isCustomPlanned;
        return (
          <div key={day.i} className="ft-card" onClick={() => isOptionalSlot ? setOptionalDayPickerOpen(day) : openDay(day)} style={{
            padding:14, marginBottom:10, cursor:"pointer",
            borderColor: day.isDone ? C.lime : (isOptionalSlot ? C.amber : (day.isToday ? ac : C.border)),
            borderStyle: isOptionalSlot ? "dashed" : "solid",
            background: day.isDone ? "rgba(221,222,104,.06)" : "transparent",
          }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
              <div>
                <div style={{ fontSize:11, color: isOptionalSlot ? C.amber : (day.isToday ? ac : C.creamDim), fontWeight:700 }}>{day.isToday ? "TODAY · " : ""}{day.dateStr}</div>
                {isOptionalSlot ? (
                  <>
                    <div style={{ fontSize:15, fontWeight:700, marginTop:2, color:C.amber }}>Optional Day</div>
                    <div style={{ fontSize:11, color:C.creamDim }}>Pick any day-type from your split</div>
                  </>
                ) : (
                  <>
                    <div style={{ fontSize:15, fontWeight:700, marginTop:2, color: day.isRest ? C.creamDim : ac, display:"flex", alignItems:"center", gap:6 }}>
                      {day.isRest ? "Rest Day" : `${day.dayType} Day`}
                      {day.isCustomPlanned && <Target size={12} color={C.ember} title="Custom planned day" />}
                    </div>
                    {!day.isRest && day.def && <div style={{ fontSize:11, color:C.creamDim }}>{day.def.groups.map(g=>g.n).join(" · ")}</div>}
                    {!day.isRest && !day.def && day.customExercises && <div style={{ fontSize:11, color:C.creamDim }}>{day.customExercises.map(e=>e.exercise).join(" · ")}</div>}
                  </>
                )}
                {day.isDone && <div style={{ fontSize:10, color:C.lime, marginTop:2 }}>{day.dayType} Day completed · {day.dateStr} · {day.loggedSessions.length} exercise{day.loggedSessions.length!==1?"s":""}</div>}
              </div>
              {day.isDone ? (
                <div style={{ display:"flex", alignItems:"center", gap:8, flexShrink:0 }}>
                  <button
                    onClick={(e) => { e.stopPropagation(); setExpandedDoneDay(expandedDoneDay === day.i ? null : day.i); }}
                    style={{ background:"none", border:`1px solid ${C.border}`, borderRadius:6, padding:"4px 7px", color:C.creamDim, cursor:"pointer", display:"flex", alignItems:"center", gap:4, fontSize:10 }}
                  >
                    <Eye size={12} /> View
                  </button>
                  <Check size={20} color={C.lime} />
                </div>
              ) : (
                <ChevronRight size={20} color={isOptionalSlot ? C.amber : C.creamDim} style={{ flexShrink:0 }} />
              )}
            </div>
            {day.isDone && expandedDoneDay === day.i && (
              <div style={{ marginTop:10, paddingTop:10, borderTop:`1px solid ${C.border}`, display:"flex", flexDirection:"column", gap:6 }} onClick={e => e.stopPropagation()}>
                {day.loggedSessions.map(s => (
                  <div key={s.id} style={{ display:"flex", alignItems:"center", justifyContent:"space-between", fontSize:12 }}>
                    <span style={{ color:C.cream }}>{s.exercise}</span>
                    <span className="ft-mono" style={{ color:C.creamDim, fontSize:11 }}>
                      {(s.sets||[]).map(x => `${x.weight}×${x.reps}`).join(", ")}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {followSource && followSource.length > 0 && (
        <div
          className="ft-card"
          onClick={openFollowPartner}
          style={{
            padding: 14, marginBottom: 10, cursor: "pointer",
            borderColor: C.lime, background: "rgba(43,230,168,.06)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontSize: 11, color: C.lime, fontWeight: 700, display: "flex", alignItems: "center", gap: 5 }}>
                <Users size={12} /> FOLLOW MY PARTNER
              </div>
              <div style={{ fontSize: 15, fontWeight: 700, marginTop: 2, color: C.lime }}>
                Mirror today's exercises
              </div>
              <div style={{ fontSize: 11, color: C.creamDim }}>
                {followSource.length} exercise{followSource.length !== 1 ? "s" : ""} queued · {followSource.map(f => f.exercise).slice(0, 3).join(", ")}{followSource.length > 3 ? "…" : ""}
              </div>
              <div style={{ fontSize: 10, color: C.creamDim, marginTop: 2 }}>Same exercises, your own weight — suggestions still come from your own history.</div>
            </div>
            <ChevronRight size={20} color={C.lime} style={{ flexShrink: 0 }} />
          </div>
        </div>
      )}
    </div>
  );

  if (view === "rest") {
    const day = next3[dayOffset];
    return (
      <div>
        <button className="ft-btn ft-btn-ghost" style={{ marginBottom:12 }} onClick={() => setView("locked")}><ArrowLeft size={13}/> Back</button>
        <div className="ft-card" style={{ padding:36, textAlign:"center" }}>
          <Moon size={26} color={C.creamDim} style={{ margin:"0 auto 10px", display:"block" }} />
          <div style={{ fontSize:16, fontWeight:700, marginBottom:4 }}>Rest day</div>
          <div style={{ fontSize:12, color:C.creamDim, maxWidth:320, margin:"0 auto 14px" }}>Nothing scheduled today — recovery is part of the plan. Want to log something anyway?</div>
          <button className="ft-btn ft-btn-ghost" onClick={() => openAdhoc(day)}><Plus size={13}/> Log something anyway</button>
        </div>
      </div>
    );
  }

  if (view === "day") {
    const day = next3[dayOffset];
    const totalVol = blocks.reduce((s,b) => s + sessionVolume(b.sets.map(x => ({ weight:x.w, reps:x.r }))), 0);
    const completed = blocks.filter(b => b.sets.some(s => s.w && s.r)).length;
    const ac = day?.def?.color || C.ember;
    return (
      <div>
        <button className="ft-btn ft-btn-ghost" style={{ marginBottom:12 }} onClick={() => setView("locked")}><ArrowLeft size={13}/> Back</button>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", flexWrap:"wrap", gap:8, marginBottom:10 }}>
          <div style={{ fontSize:16, fontWeight:700, color:ac }}>{day.dateStr} · {day.isRest ? "Off-split" : `${day.dayType} Day`}{day.isDone ? " (editing)" : ""}</div>
          <div className="ft-card-raised" style={{ padding:"5px 10px", fontSize:12, fontWeight:700, color:C.ember }}>{Math.round(totalVol)} lbs total</div>
        </div>
        {day.isDone && (
          fixingDate ? (
            <div className="ft-card-raised" style={{ padding:10, marginBottom:12, display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
              <span style={{ fontSize:11, color:C.creamDim }}>Actually logged on:</span>
              <input type="date" className="ft-input" style={{ width:150 }} value={fixDateValue} onChange={e => setFixDateValue(e.target.value)} />
              <button className="ft-btn ft-btn-primary" style={{ fontSize:11, padding:"5px 10px" }} onClick={handleFixDate}>Move it</button>
              <button className="ft-btn ft-btn-ghost" style={{ fontSize:11, padding:"5px 10px" }} onClick={() => setFixingDate(false)}>Cancel</button>
            </div>
          ) : (
            <button
              className="ft-btn ft-btn-ghost"
              style={{ fontSize:11, marginBottom:12 }}
              onClick={() => { setFixDateValue(day.dateKey); setFixingDate(true); }}
            >
              Wrong date? Fix it
            </button>
          )
        )}
        <div style={{ fontSize:11, color:C.creamDim, marginBottom:12 }}>Just weight and reps — progress charts live in History so this screen stays fast mid-workout.</div>
        {day.dateKey > localDateStr(new Date()) && !day.isDone && (
          <div className="ft-card-raised" style={{ padding:"8px 12px", marginBottom:12, fontSize:11, color:C.amber, display:"flex", alignItems:"center", gap:6 }}>
            <CalendarDays size={12} /> This is {day.dateStr}'s slot — anything you log saves under <b>today's</b> date, since that's when you're actually doing it.
          </div>
        )}

        {blocks.map((b, bi) => {
          const isDeload = b.sugg?.type === "deload";
          const accent = isDeload ? C.warn : C.ember;

          if (b.locked) {
            return (
              <div key={bi} className="ft-card-raised" style={{ padding:12, marginBottom:8, opacity:0.75 }}>
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6 }}>
                  <div style={{ fontSize:13, fontWeight:700, display:"flex", alignItems:"center", gap:6 }}>
                    <Lock size={11} color={C.creamDim} />
                    {b.exercise}
                  </div>
                </div>
                <div style={{ fontSize:10, color:C.creamDim, marginBottom:8 }}>
                  Locked — assisted pull-ups and dips can't be edited once saved, since only the computed weight is kept, not the assist amount. Delete this workout and redo it if something needs to change.
                </div>
                {b.sets.map((s, si) => (
                  <div key={si} style={{ display:"grid", gridTemplateColumns:"20px 1fr 1fr", gap:6, marginBottom:5, alignItems:"center", fontSize:12.5 }}>
                    <div style={{ fontSize:11, color:C.creamDim, textAlign:"center" }}>{si+1}</div>
                    <div className="ft-mono" style={{ color:C.cream }}>{s.w} lbs</div>
                    <div className="ft-mono" style={{ color:C.cream }}>{s.r} reps</div>
                  </div>
                ))}
              </div>
            );
          }

          return (
            <div key={bi} className="ft-card-raised" style={{ padding:12, marginBottom:8, border: isDeload ? `1px solid ${C.warn}` : undefined }}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:6 }}>
                <div style={{ fontSize:13, fontWeight:700 }}>
                  {b.exercise || "Select exercise"}
                  {b.off && <span style={{ fontSize:9, color:"#8B93C9", border:"1px solid #8B93C9", borderRadius:4, padding:"1px 5px", marginLeft:6 }}>off-split</span>}
                </div>
                <div style={{ display:"flex", alignItems:"center", gap:4 }}>
                  {EXERCISE_LINKS[b.exercise] && (
                    <a href={EXERCISE_LINKS[b.exercise]} target="_blank" rel="noopener noreferrer" className="ft-btn ft-btn-ghost" style={{ padding:"4px 7px", display:"flex" }} title="Tutorial">
                      <ExternalLink size={12} />
                    </a>
                  )}
                  <button className="ft-btn ft-btn-ghost" style={{ padding:"4px 7px" }} title="Swap exercise" onClick={() => setSwapOpen({ bi, grp: b.grp })}><Repeat size={12}/></button>
                  <button className="ft-btn ft-btn-ghost" style={{ padding:"4px 7px", color:C.warn }} title="Remove this exercise from today" onClick={() => removeBlock(bi)}><Trash2 size={12}/></button>
                </div>
              </div>
              <div style={{ fontSize:10, color:accent, marginBottom:8 }}>
                {b.grp}
                {b.repTarget && <span style={{ marginLeft:6, color:C.creamDim, border:`1px solid ${C.border}`, borderRadius:4, padding:"1px 5px" }}>{b.sets.length} × {b.repTarget}</span>}
              </div>
              {b.sugg && (
                <div style={{ display:"flex", alignItems:"flex-start", gap:6, background: isDeload ? "rgba(232,112,122,.12)" : "rgba(218,147,93,.12)", border:`1px solid ${accent}`, borderRadius:6, padding:"6px 9px", marginBottom:8, fontSize:11, color:accent }}>
                  {isDeload ? <AlertTriangle size={12} style={{marginTop:1,flexShrink:0}}/> : <TrendingUp size={12} style={{marginTop:1,flexShrink:0}}/>}
                  <div style={{ flex:1 }}>{b.sugg.msg}</div>
                  {isDeload && <button onClick={() => dismissDeload(b.exercise, bi)} style={{ background:"none", border:"none", color:accent, cursor:"pointer", fontSize:10, textDecoration:"underline", whiteSpace:"nowrap" }}>not stalled</button>}
                </div>
              )}
              {/* Early warning before the deload suggestion actually
                  appears — previously a deload showed up fully-formed on
                  session 3 with zero lead-up, which felt like it came out
                  of nowhere. This surfaces "2 of 3" one session earlier. */}
              {b.sugg && !isDeload && b.sugg.stalledStreak === 2 && (
                <div style={{ fontSize:10, color:C.creamDim, marginTop:-4, marginBottom:8 }}>
                  2 of 3 sessions stalled at this weight — one more and this'll suggest a deload.
                </div>
              )}
              {BODYWEIGHT_LOADED_EXERCISES.has(b.exercise) && !isAssistedBodyweight(b.exercise) && (
                <div style={{ fontSize:10, color:C.creamDim, marginBottom:8 }}>
                  {latestWeight ? `Using your logged weight (${Math.round(latestWeight * 10) / 10} lbs) — edit any set's weight if you're adding load.` : "Log your weight in Daily Log to auto-fill bodyweight here."}
                </div>
              )}
              {GLUTE_HAM_BODYWEIGHT_EXERCISES.has(b.exercise) && (
                <div style={{ fontSize:10, color:C.creamDim, marginBottom:8 }}>
                  {latestWeight
                    ? `Adds ${Math.round(gluteHamBodyweightPct(gender) * 100)}% of your logged weight (${Math.round(latestWeight * gluteHamBodyweightPct(gender) * 10) / 10} lbs) to whatever you enter — type only any extra weight held, 0 if bodyweight only.`
                    : "Log your weight in Daily Log so this can add the bodyweight portion automatically."}
                </div>
              )}
              {b.sets.map((s, si) => {
                const filled = s.w && s.r;
                const target = b.sugg?.targetReps || b.repTarget;
                if (isAssistedBodyweight(b.exercise)) {
                  const key = `${bi}-${si}`;
                  const assistVal = assistInputs[key] ?? "";
                  return (
                    <div key={si} style={{ display:"grid", gridTemplateColumns: dedicatedProgressiveOverload ? "20px 1fr 1fr 1fr 44px 24px" : "20px 1fr 1fr 1fr 24px", gap:6, marginBottom:5, alignItems:"center" }}>
                      <div style={{ fontSize:11, color: filled ? C.lime : C.creamDim, textAlign:"center" }}>{filled ? <Check size={12}/> : si+1}</div>
                      <input
                        className="ft-input" type="number" inputMode="decimal" onFocus={e=>e.target.select()}
                        placeholder="assist lbs" value={assistVal}
                        onChange={e => {
                          const v = e.target.value;
                          setAssistInputs(prev => ({ ...prev, [key]: v }));
                          const eff = latestWeight != null ? Math.max(0, latestWeight - (parseFloat(v) || 0)) : "";
                          setVal(bi, si, "w", eff === "" ? "" : String(Math.round(eff * 10) / 10));
                        }}
                      />
                      <div className="ft-mono" style={{ fontSize:11.5, color:C.creamDim, textAlign:"center" }}>
                        {s.w ? `≈ ${s.w} lbs` : (latestWeight == null ? "no weight logged" : "= lbs lifted")}
                      </div>
                      <input className="ft-input" type="number" inputMode="decimal" onFocus={e=>e.target.select()} placeholder={target ? `target ${target}` : "reps"} value={s.r} onChange={e => setVal(bi,si,"r",e.target.value)} />
                      {dedicatedProgressiveOverload && (
                        <input className="ft-input" type="number" inputMode="decimal" min="1" max="10" step="0.5" onFocus={e=>e.target.select()} title="RPE (1-10)" placeholder="RPE" value={s.rpe || ""} onChange={e => setVal(bi,si,"rpe",e.target.value)} />
                      )}
                      <button onClick={() => removeSet(bi,si)} aria-label="Remove set" style={{ background:"none", border:"none", color:C.creamDim, cursor:"pointer" }}><XIcon size={13}/></button>
                    </div>
                  );
                }
                if (GLUTE_HAM_BODYWEIGHT_EXERCISES.has(b.exercise)) {
                  const key = `${bi}-${si}`;
                  const addedVal = assistInputs[key] ?? "";
                  return (
                    <div key={si} style={{ display:"grid", gridTemplateColumns: dedicatedProgressiveOverload ? "20px 1fr 1fr 1fr 44px 24px" : "20px 1fr 1fr 1fr 24px", gap:6, marginBottom:5, alignItems:"center" }}>
                      <div style={{ fontSize:11, color: filled ? C.lime : C.creamDim, textAlign:"center" }}>{filled ? <Check size={12}/> : si+1}</div>
                      <input
                        className="ft-input" type="number" inputMode="decimal" onFocus={e=>e.target.select()}
                        placeholder="added lbs" value={addedVal}
                        onChange={e => {
                          const v = e.target.value;
                          setAssistInputs(prev => ({ ...prev, [key]: v }));
                          const bwShare = latestWeight != null ? latestWeight * gluteHamBodyweightPct(gender) : null;
                          const eff = bwShare != null ? bwShare + (parseFloat(v) || 0) : "";
                          setVal(bi, si, "w", eff === "" ? "" : String(Math.round(eff * 10) / 10));
                        }}
                      />
                      <div className="ft-mono" style={{ fontSize:11.5, color:C.creamDim, textAlign:"center" }}>
                        {s.w ? `≈ ${s.w} lbs` : (latestWeight == null ? "no weight logged" : "= lbs total")}
                      </div>
                      <input className="ft-input" type="number" inputMode="decimal" onFocus={e=>e.target.select()} placeholder={target ? `target ${target}` : "reps"} value={s.r} onChange={e => setVal(bi,si,"r",e.target.value)} />
                      {dedicatedProgressiveOverload && (
                        <input className="ft-input" type="number" inputMode="decimal" min="1" max="10" step="0.5" onFocus={e=>e.target.select()} title="RPE (1-10)" placeholder="RPE" value={s.rpe || ""} onChange={e => setVal(bi,si,"rpe",e.target.value)} />
                      )}
                      <button onClick={() => removeSet(bi,si)} aria-label="Remove set" style={{ background:"none", border:"none", color:C.creamDim, cursor:"pointer" }}><XIcon size={13}/></button>
                    </div>
                  );
                }
                return (
                  <div key={si} style={{ display:"grid", gridTemplateColumns: dedicatedProgressiveOverload ? "20px 1fr 1fr 44px 24px" : "20px 1fr 1fr 24px", gap:6, marginBottom:5, alignItems:"center" }}>
                    <div style={{ fontSize:11, color: filled ? C.lime : C.creamDim, textAlign:"center" }}>{filled ? <Check size={12}/> : si+1}</div>
                    <input className="ft-input" type="number" inputMode="decimal" onFocus={e=>e.target.select()} placeholder="lbs" value={s.w} onChange={e => setVal(bi,si,"w",e.target.value)} />
                    <input className="ft-input" type="number" inputMode="decimal" onFocus={e=>e.target.select()} placeholder={target ? `target ${target}` : "reps"} value={s.r} onChange={e => setVal(bi,si,"r",e.target.value)} />
                    {dedicatedProgressiveOverload && (
                      <input className="ft-input" type="number" inputMode="decimal" min="1" max="10" step="0.5" onFocus={e=>e.target.select()} title="RPE (1-10)" placeholder="RPE" value={s.rpe || ""} onChange={e => setVal(bi,si,"rpe",e.target.value)} />
                    )}
                    <button onClick={() => removeSet(bi,si)} aria-label="Remove set" style={{ background:"none", border:"none", color:C.creamDim, cursor:"pointer" }}><XIcon size={13}/></button>
                  </div>
                );
              })}
              <button className="ft-btn ft-btn-ghost" style={{ fontSize:11, padding:"4px 8px" }} onClick={() => addSet(bi)}><Plus size={12}/> Add set</button>
            </div>
          );
        })}

        <button className="ft-btn ft-btn-ghost" onClick={addOffSplit} style={{ marginBottom:14 }}><Plus size={13}/> Log something else (off-split)</button>
        <div style={{ fontSize:11, color:C.creamDim, marginBottom:10 }}>{completed} of {blocks.length} exercises have data — you can save with just what you finished.</div>
        <button className="ft-btn ft-btn-primary" onClick={handleSaveDay} disabled={saving}><Zap size={13}/> {saving ? "Saving…" : "Save workout"}</button>
        {justSaved && <span style={{ marginLeft:10, fontSize:12, color:C.lime, display:"inline-flex", alignItems:"center", gap:4 }}><Check size={13}/> Saved — day marked done</span>}

        {justSavedPRs.length > 0 && (
          <div style={{ display:"flex", alignItems:"flex-start", gap:10, marginTop:10, padding:"12px 14px", borderRadius:10, background:"linear-gradient(135deg, rgba(240,192,64,.18), rgba(240,192,64,.06))", border:`1px solid ${C.ember}` }}>
            <Trophy size={18} color={C.ember} style={{ flexShrink:0, marginTop:1 }} />
            <div style={{ flex:1 }}>
              <div style={{ fontSize:13, fontWeight:800, color:C.ember, marginBottom:3 }}>NEW PR{justSavedPRs.length > 1 ? "s" : ""}!</div>
              {justSavedPRs.map((pr, i) => (
                <div key={i} style={{ fontSize:12, color:C.cream, marginBottom:2 }}>
                  <span style={{ fontWeight:700 }}>{pr.exercise}</span> — new best {pr.prTypes.map(t => PR_LABELS[t]).join(" & ")}
                </div>
              ))}
            </div>
            <button onClick={() => setJustSavedPRs([])} style={{ background:"none", border:"none", color:C.creamDim, cursor:"pointer", padding:4 }}><XIcon size={14}/></button>
          </div>
        )}

        {offSplitPickerOpen && (() => {
          const q = offSplitSearch.trim().toLowerCase();
          const results = q ? OFF_SPLIT_EXERCISES.filter(e => e.exercise.toLowerCase().includes(q)).slice(0, 8) : [];
          return (
            <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.65)", zIndex:1000, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }} onClick={e => { if (e.target===e.currentTarget) closeOffSplitPicker(); }}>
              <div className="ft-card" style={{ padding:18, maxWidth:380, width:"100%", maxHeight:"75vh", overflowY:"auto", overscrollBehavior:"contain" }}>
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12 }}>
                  <div style={{ fontWeight:700, fontSize:13, display:"flex", alignItems:"center", gap:6 }}><Plus size={14} color={C.ember}/> What muscle group?</div>
                  <button onClick={closeOffSplitPicker} style={{ background:"none", border:"none", color:C.creamDim, cursor:"pointer" }}><XIcon size={14}/></button>
                </div>
                <div style={{ position:"relative", marginBottom:12 }}>
                  <Search size={13} color={C.creamDim} style={{ position:"absolute", left:10, top:"50%", transform:"translateY(-50%)", pointerEvents:"none" }} />
                  <input
                    type="text"
                    className="ft-input"
                    value={offSplitSearch}
                    onChange={e => setOffSplitSearch(e.target.value)}
                    placeholder="Search exercises — skips the group step"
                    autoFocus
                    style={{ paddingLeft:30 }}
                  />
                </div>
                {q ? (
                  results.length ? (
                    <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                      {results.map(r => (
                        <button
                          key={r.exercise}
                          onClick={() => confirmOffSplitExercise(r.group, r.exercise)}
                          style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:10, background:C.raised, border:`1px solid ${C.border}`, borderRadius:8, padding:"9px 12px", color:C.cream, fontSize:12.5, fontWeight:600, cursor:"pointer", textAlign:"left" }}
                        >
                          <span>{r.exercise}</span>
                          <span style={{ fontSize:9.5, fontWeight:700, color:C.creamDim, textTransform:"uppercase", letterSpacing:"0.04em", whiteSpace:"nowrap" }}>{r.group}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontSize:12, color:C.creamDim, padding:"14px 0", textAlign:"center" }}>No exercises match "{offSplitSearch.trim()}"</div>
                  )
                ) : (
                  <>
                    <div style={{ fontSize:11, color:C.creamDim, marginBottom:12 }}>Pick whichever you're actually training today — this doesn't have to match the dedicated day.</div>
                    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                      {OFF_SPLIT_GROUPS.map(group => (
                        <button
                          key={group}
                          onClick={() => confirmOffSplitGroup(group)}
                          style={{ background:C.raised, border:`1px solid ${C.border}`, borderRadius:8, padding:"10px 12px", color:C.cream, fontSize:12.5, fontWeight:600, cursor:"pointer", textAlign:"left" }}
                        >
                          {group}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          );
        })()}

        {optionalDayPickerOpen && (
          <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.65)", zIndex:1000, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }} onClick={e => { if (e.target===e.currentTarget) setOptionalDayPickerOpen(null); }}>
            <div className="ft-card" style={{ padding:18, maxWidth:380, width:"100%", maxHeight:"75vh", overflowY:"auto", overscrollBehavior:"contain" }}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:12 }}>
                <div style={{ fontWeight:700, fontSize:13, display:"flex", alignItems:"center", gap:6 }}><CalendarDays size={14} color={C.amber}/> Pick a day-type</div>
                <button onClick={() => setOptionalDayPickerOpen(null)} style={{ background:"none", border:"none", color:C.creamDim, cursor:"pointer" }}><XIcon size={14}/></button>
              </div>
              <div style={{ fontSize:11, color:C.creamDim, marginBottom:12 }}>
                {optionalDayPickerOpen.dateStr} is an optional day — train whichever day-type from {effectiveSplit?.name} makes sense right now.
              </div>
              {(() => {
                const coverage = computeSetCoverage(workoutSessions, OFF_SPLIT_GROUPS);
                const lowest = coverage.length ? coverage.reduce((min, c) => (c.sets < min.sets ? c : min), coverage[0]) : null;
                const lowestGroup = lowest && lowest.sets < 10 ? lowest.group : null;
                return (
                  <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
                    {Object.keys(effectiveSplit?.defs || {}).map(dayTypeName => {
                      const def = effectiveSplit.defs[dayTypeName];
                      const coversLowest = lowestGroup && def.groups.some(g => g.n === lowestGroup);
                      return (
                        <button
                          key={dayTypeName}
                          onClick={() => chooseOptionalDayType(optionalDayPickerOpen, dayTypeName)}
                          style={{ background:C.raised, border:`1px solid ${coversLowest ? C.lime : (def.color || C.border)}60`, borderRadius:8, padding:"10px 12px", color:C.cream, cursor:"pointer", textAlign:"left" }}
                        >
                          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                            <div style={{ fontSize:13, fontWeight:700, color: def.color || C.cream }}>{dayTypeName}</div>
                            {coversLowest && (
                              <span style={{ fontSize:9, fontWeight:700, color:C.lime, border:`1px solid ${C.lime}`, borderRadius:4, padding:"1px 5px" }}>
                                {lowestGroup} IS LOW
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize:11, color:C.creamDim, marginTop:2 }}>{def.groups.map(g=>g.n).join(" · ")}</div>
                        </button>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {swapOpen && (() => {
          const bi = swapOpen.bi;
          const db = EX[swapOpen.grp];
          const allEx = db ? [...(db.primary||[]), ...(db.compound||[]), ...(db.isolation||[])] : [];
          // Only exclude what's currently in THIS slot — not every
          // exercise used anywhere in today's workout. Someone might
          // legitimately want the same lift twice (heavy triples in one
          // block, a lighter pump-work block later), and excluding every
          // other block's exercise made that impossible.
          const alternatives = allEx.filter(ex => ex !== blocks[swapOpen?.bi]?.exercise).sort((a, b) => a.localeCompare(b));
          return (
            <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.65)", zIndex:1000, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }} onClick={e => { if (e.target===e.currentTarget) setSwapOpen(null); }}>
              <div className="ft-card" style={{ padding:18, maxWidth:380, width:"100%", maxHeight:"75vh", overflowY:"auto", overscrollBehavior:"contain" }}>
                <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
                  <div style={{ fontWeight:700, fontSize:13, display:"flex", alignItems:"center", gap:6 }}><Repeat size={14} color={C.ember}/> Swap exercise — {swapOpen.grp}</div>
                  <button onClick={() => setSwapOpen(null)} style={{ background:"none", border:"none", color:C.creamDim, cursor:"pointer" }}><XIcon size={14}/></button>
                </div>
                <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
                  {alternatives.map(alt => {
                    const tutUrl = EXERCISE_LINKS[alt];
                    return (
                      <div key={alt} style={{ display:"flex", alignItems:"center", gap:6, background:C.raised, border:`1px solid ${C.border}`, borderRadius:8, padding:"8px 10px" }}>
                        <button onClick={() => {
                          // Same lookup buildDayBlocks does for a fresh
                          // day — swapping to an exercise you've done
                          // before (just maybe not in this slot, or not
                          // under this split) should still tell you what
                          // to lift, not silently drop the suggestion.
                          const altHistory = workoutSessions.filter(s => s.exercise === alt);
                          const altDismissedAt = dismissed[alt] ?? null;
                          const altSugg = getProgressionSuggestion(altHistory, swapOpen.grp, alt, altDismissedAt, dedicatedProgressiveOverload);
                          const swapW = defaultWeightFor(alt, altSugg);
                          setBlocks(prev => prev.map((b,i) => i!==bi ? b : { ...b, exercise:alt, sugg:altSugg, repTarget: altSugg?.targetReps, sets: b.sets.map(s=>({w:swapW,r:""})) }));
                          setSwapOpen(null);
                        }} style={{ flex:1, textAlign:"left", background:"none", border:"none", color:C.cream, fontSize:12, fontWeight:600, cursor:"pointer" }}>{alt}</button>
                        {tutUrl && <a href={tutUrl} target="_blank" rel="noopener noreferrer" onClick={e=>e.stopPropagation()} style={{ color:C.ember, display:"flex" }}><ExternalLink size={13}/></a>}
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

  if (view === "planWeek" && planDrafts) return (
    <div>
      <button className="ft-btn ft-btn-ghost" style={{ marginBottom:12 }} onClick={() => setView("locked")}><ArrowLeft size={13}/> Back</button>
      <div style={{ fontSize:20, fontWeight:800, marginBottom:4 }}>Plan your next 7 days</div>
      <div style={{ fontSize:11.5, color:C.creamDim, marginBottom:16, lineHeight:1.5 }}>
        Build out exactly what each day should look like ahead of time — your own exercises, your own day names, or mark it Rest. Once locked in, these dates override your regular split until they pass; walk into the gym and just log weight and reps.
      </div>

      {customSplitTemplates && customSplitTemplates.length > 0 && (
        <div className="ft-card" style={{ padding:14, marginBottom:14 }}>
          <div style={{ fontSize:11.5, fontWeight:700, color:C.creamDim, marginBottom:8, textTransform:"uppercase", letterSpacing:"0.03em" }}>Load from a saved plan</div>
          <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
            {customSplitTemplates.map(t => (
              <div key={t.id} style={{ display:"flex", alignItems:"center", gap:8 }}>
                <button className="ft-btn ft-btn-ghost" style={{ flex:1, justifyContent:"flex-start" }} onClick={() => applyTemplate(t)}>
                  <BookmarkPlus size={13}/> {t.name}
                </button>
                <button onClick={() => onDeleteCustomSplitTemplate?.(t.id)} aria-label={`Delete ${t.name}`} style={{ background:"none", border:"none", color:C.creamDim, cursor:"pointer", padding:4 }}><XIcon size={13}/></button>
              </div>
            ))}
          </div>
          <div style={{ fontSize:10.5, color:C.creamDim, marginTop:8 }}>Loading a saved plan fills in the days below — you can still tweak anything before locking it in.</div>
        </div>
      )}

      {Array.from({ length:7 }, (_, i) => addDays(today, i)).map(date => {
        const dateKey = localDateStr(date);
        const draft = planDrafts[dateKey];
        const search = planSearch[dateKey] || "";
        const q = search.trim().toLowerCase();
        const matches = q ? OFF_SPLIT_EXERCISES.filter(e => e.exercise.toLowerCase().includes(q)).slice(0, 6) : [];
        const alreadyPlanned = !!customDayPlans?.[dateKey];

        return (
          <div key={dateKey} className="ft-card" style={{ padding:14, marginBottom:10 }}>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
              <div style={{ fontWeight:700, fontSize:13 }}>{fmtDay(date)}</div>
              <label style={{ display:"flex", alignItems:"center", gap:6, fontSize:12, color:C.creamDim, cursor:"pointer" }}>
                <input type="checkbox" checked={draft.isRest} onChange={e => updateDraft(dateKey, { isRest: e.target.checked })} />
                Rest day
              </label>
            </div>

            {!draft.isRest && (
              <>
                <input className="ft-input" placeholder="Day name (e.g. Push Day)" value={draft.dayType} onChange={e => updateDraft(dateKey, { dayType: e.target.value })} style={{ marginBottom:8 }} />

                {draft.exercises.length > 0 && (
                  <div style={{ display:"flex", flexWrap:"wrap", gap:6, marginBottom:8 }}>
                    {draft.exercises.map(ex => (
                      <span key={ex.exercise} style={{ display:"flex", alignItems:"center", gap:4, fontSize:11.5, background:C.raised, border:`1px solid ${C.border}`, borderRadius:999, padding:"4px 6px 4px 10px" }}>
                        {ex.exercise}
                        <button onClick={() => removeDraftExercise(dateKey, ex.exercise)} aria-label={`Remove ${ex.exercise}`} style={{ background:"none", border:"none", color:C.creamDim, cursor:"pointer", display:"flex" }}><XIcon size={11}/></button>
                      </span>
                    ))}
                  </div>
                )}

                <div style={{ display:"flex", gap:6 }}>
                  <input className="ft-input" placeholder="Search exercises to add…" value={search} onChange={e => setPlanSearch(prev => ({ ...prev, [dateKey]: e.target.value }))} style={{ flex:1 }} />
                  <button className="ft-btn ft-btn-ghost" style={{ padding:"0 10px" }} title="Browse every exercise A–Z" onClick={() => setBrowseOpen(dateKey)}><List size={13}/></button>
                </div>
                {matches.length > 0 && (
                  <div style={{ display:"flex", flexDirection:"column", gap:4, marginTop:6 }}>
                    {matches.map(m => (
                      <button
                        key={m.exercise}
                        onClick={() => addDraftExercise(dateKey, m)}
                        style={{ display:"flex", justifyContent:"space-between", background:C.raised, border:`1px solid ${C.border}`, borderRadius:6, padding:"7px 10px", color:C.cream, fontSize:12, cursor:"pointer", textAlign:"left" }}
                      >
                        <span>{m.exercise}</span>
                        <span style={{ color:C.creamDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.03em" }}>{m.group}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}

            {alreadyPlanned && (
              <button className="ft-btn ft-btn-ghost" style={{ fontSize:10.5, marginTop:10, padding:"4px 10px" }} onClick={() => clearPlannedDay(dateKey)}>Clear this day's plan</button>
            )}
          </div>
        );
      })}

      {browseOpen && planDrafts[browseOpen] && (() => {
        const dateKey = browseOpen;
        const draft = planDrafts[dateKey];
        const [by, bm, bd] = dateKey.split("-").map(Number);
        const dayLabel = fmtDay(new Date(by, bm - 1, bd));
        const addedSet = new Set(draft.exercises.map(e => e.exercise));
        // OFF_SPLIT_EXERCISES is already sorted alphabetically at module
        // load — this just buckets that same sorted list by first letter
        // so the modal reads as an A-Z index instead of one long scroll.
        const grouped = {};
        for (const item of OFF_SPLIT_EXERCISES) {
          const letter = /^[A-Za-z]/.test(item.exercise) ? item.exercise[0].toUpperCase() : "#";
          (grouped[letter] ||= []).push(item);
        }
        const letters = Object.keys(grouped).sort();
        return (
          <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.65)", zIndex:1000, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }} onClick={e => { if (e.target===e.currentTarget) setBrowseOpen(null); }}>
            <div className="ft-card" style={{ padding:18, maxWidth:420, width:"100%", maxHeight:"78vh", overflowY:"auto", overscrollBehavior:"contain" }}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:4 }}>
                <div style={{ fontWeight:700, fontSize:13, display:"flex", alignItems:"center", gap:6 }}><List size={14} color={C.ember}/> All exercises A–Z</div>
                <button onClick={() => setBrowseOpen(null)} style={{ background:"none", border:"none", color:C.creamDim, cursor:"pointer" }}><XIcon size={14}/></button>
              </div>
              <div style={{ fontSize:10.5, color:C.creamDim, marginBottom:12 }}>For {dayLabel} — tap to add, tap again to remove.</div>
              {letters.map(letter => (
                <div key={letter} style={{ marginBottom:10 }}>
                  <div style={{ fontSize:10.5, fontWeight:800, color:C.ember, letterSpacing:"0.05em", marginBottom:4, paddingLeft:2 }}>{letter}</div>
                  <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
                    {grouped[letter].map(item => {
                      const added = addedSet.has(item.exercise);
                      return (
                        <button
                          key={item.exercise}
                          onClick={() => added ? removeDraftExercise(dateKey, item.exercise) : addDraftExercise(dateKey, item)}
                          style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:8, background: added ? "rgba(79,173,255,0.12)" : C.raised, border:`1px solid ${added ? C.ember : C.border}`, borderRadius:6, padding:"7px 10px", color:C.cream, fontSize:12, cursor:"pointer", textAlign:"left" }}
                        >
                          <span style={{ display:"flex", alignItems:"center", gap:6 }}>
                            {added && <Check size={12} color={C.ember} />}
                            {item.exercise}
                          </span>
                          <span style={{ color:C.creamDim, fontSize:10, textTransform:"uppercase", letterSpacing:"0.03em", whiteSpace:"nowrap" }}>{item.group}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      <div className="ft-card" style={{ padding:14, marginBottom:14 }}>
        {templatePromptOpen ? (
          <div style={{ display:"flex", gap:8 }}>
            <input className="ft-input" placeholder="Name this plan (e.g. My PPL)" value={templateNameInput} onChange={e => setTemplateNameInput(e.target.value)} onFocus={e => e.target.select()} style={{ flex:1 }} autoFocus />
            <button className="ft-btn ft-btn-primary" style={{ padding:"0 12px" }} disabled={!templateNameInput.trim()} onClick={saveAsTemplate}>Save</button>
            <button className="ft-btn ft-btn-ghost" style={{ padding:"0 10px" }} onClick={() => setTemplatePromptOpen(false)}>Cancel</button>
          </div>
        ) : (
          <button className="ft-btn ft-btn-ghost" style={{ width:"100%" }} onClick={() => setTemplatePromptOpen(true)}>
            <BookmarkPlus size={13}/> Save this week as a reusable plan
          </button>
        )}
      </div>

      <button className="ft-btn ft-btn-primary" style={{ width:"100%" }} onClick={lockInWeek}><Check size={14}/> Lock in this week</button>
    </div>
  );

  if (view === "history") return (
    <div>
      <button className="ft-btn ft-btn-ghost" style={{ marginBottom:12 }} onClick={() => setView("locked")}><ArrowLeft size={13}/> Back</button>
      <div style={{ fontSize:16, fontWeight:700, marginBottom:4 }}>Lifts you've logged</div>
      <div style={{ fontSize:11, color:C.creamDim, marginBottom:12 }}>Tap a lift for full history and progress charts.</div>
      {historyByExercise.length === 0 && <div className="ft-card" style={{ padding:30, textAlign:"center", fontSize:13, color:C.creamDim }}>No workouts logged yet.</div>}
      {historyByExercise.map(h => (
        <div key={h.exercise} className="ft-card" onClick={() => { setSelectedLift(h.exercise); setView("lift"); }} style={{ padding:"12px 14px", marginBottom:8, cursor:"pointer" }}>
          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between" }}>
            <div>
              <div style={{ fontSize:14, fontWeight:700 }}>{h.exercise}</div>
              <div style={{ fontSize:11, color:C.creamDim }}>{h.grp} · {h.sessions.length} session{h.sessions.length!==1?"s":""} · last {h.lastDate}</div>
              <div className="ft-mono" style={{ fontSize:11, color:C.creamDim, marginTop:2 }}>{fmtN(h.totalVolume)} lbs total volume</div>
            </div>
            <div style={{ textAlign:"right" }}>
              <div style={{ fontSize:9, color:C.creamDim }}>best e1RM</div>
              <div style={{ fontSize:14, fontWeight:700, color:C.ember }}>{fmtN(h.best)} lbs</div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );

  if (view === "lift") {
    const h = historyByExercise.find(x => x.exercise === selectedLift);
    if (!h) { setView("history"); return null; }
    const chartData = h.sessions.map(s => ({ date: s.date.slice(5), e1rm: sessionBest1RM(s.sets), volume: sessionVolume(s.sets) }));
    const avgW = Math.round(h.sessions.reduce((s,x) => s + (x.sets[0]?.weight||0), 0) / h.sessions.length);
    // Only counted across sets that actually have an RPE logged — most
    // exercises won't, if Dedicated Progressive Overload has never been
    // on, and this stat just quietly doesn't appear for those rather
    // than showing a misleading 0.
    const rpeValues = h.sessions.flatMap(s => (s.sets || []).map(set => parseFloat(set.rpe)).filter(v => !Number.isNaN(v) && v > 0));
    const avgRpe = rpeValues.length ? Math.round((rpeValues.reduce((a,b) => a+b, 0) / rpeValues.length) * 10) / 10 : null;
    return (
      <div>
        <button className="ft-btn ft-btn-ghost" style={{ marginBottom:12 }} onClick={() => setView("history")}><ArrowLeft size={13}/> Back to lifts</button>
        <div style={{ fontSize:16, fontWeight:700 }}>{h.exercise}</div>
        <div style={{ fontSize:11, color:C.ember, marginBottom:12 }}>{h.grp}</div>
        <div style={{ display:"grid", gridTemplateColumns: avgRpe != null ? "repeat(4,1fr)" : "repeat(3,1fr)", gap:8, marginBottom:14 }}>
          <div className="ft-card-raised" style={{ padding:10, textAlign:"center" }}><div style={{ fontSize:9, color:C.creamDim }}>Best e1RM</div><div style={{ fontSize:16, fontWeight:800, color:C.ember }}>{fmtN(h.best)} lbs</div></div>
          <div className="ft-card-raised" style={{ padding:10, textAlign:"center" }}><div style={{ fontSize:9, color:C.creamDim }}>Avg weight</div><div style={{ fontSize:16, fontWeight:800 }}>{fmtN(avgW)} lbs</div></div>
          <div className="ft-card-raised" style={{ padding:10, textAlign:"center" }}><div style={{ fontSize:9, color:C.creamDim }}>Sessions</div><div style={{ fontSize:16, fontWeight:800 }}>{h.sessions.length}</div></div>
          {avgRpe != null && (
            <div className="ft-card-raised" style={{ padding:10, textAlign:"center" }}><div style={{ fontSize:9, color:C.creamDim }}>Avg RPE</div><div style={{ fontSize:16, fontWeight:800, color: avgRpe >= 9 ? C.warn : C.cream }}>{avgRpe}</div></div>
          )}
        </div>
        {chartData.length > 1 && (
          <div className="ft-card" style={{ padding:14, marginBottom:12 }}>
            <div style={{ fontSize:11, color:C.creamDim, marginBottom:6 }}>Estimated 1RM over time</div>
            <ResponsiveContainer width="100%" height={180}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis dataKey="date" stroke={C.creamDim} fontSize={10} />
                <YAxis stroke={C.creamDim} fontSize={10} domain={["auto","auto"]} />
                <Tooltip contentStyle={{ background:C.raised, border:`1px solid ${C.border}`, color:C.cream }} />
                <Line type="monotone" dataKey="e1rm" stroke={C.ember} strokeWidth={2} dot={{ r:3 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
        {chartData.length > 1 && (
          <div className="ft-card" style={{ padding:14, marginBottom:12 }}>
            <div style={{ fontSize:11, color:C.creamDim, marginBottom:6 }}>Session volume (sets × reps × weight)</div>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis dataKey="date" stroke={C.creamDim} fontSize={10} />
                <YAxis stroke={C.creamDim} fontSize={10} />
                <Tooltip contentStyle={{ background:C.raised, border:`1px solid ${C.border}`, color:C.cream }} />
                <Bar dataKey="volume" fill={C.ember} radius={[4,4,4,4]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
        <div className="ft-card" style={{ padding:"10px 14px" }}>
          <div style={{ fontSize:10, color:C.creamDim, marginBottom:6 }}>Every set logged, most recent first.</div>
          {[...h.sessions].reverse().map(s => {
            const pr = prFlags[s.id];
            const vol = sessionVolume(s.sets);
            const best = sessionBest1RM(s.sets);
            return (
              <div key={s.id} style={{ padding:"9px 0", borderBottom:`1px solid ${C.border}` }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:5 }}>
                  <span style={{ color:C.creamDim, fontSize:12, display:"flex", alignItems:"center", gap:5 }}>{s.date}{pr?.isPR && <Trophy size={12} color={C.lime}/>}</span>
                  <span className="ft-mono" style={{ fontSize:11, color:C.creamDim }}>
                    vol: <span style={{ color:C.ember }}>{fmtN(vol)} lbs</span>
                    {" · "}e1RM: <span style={{ color:C.ember }}>{fmtN(best)} lbs</span>
                  </span>
                </div>
                <div style={{ display:"flex", flexWrap:"wrap", gap:6 }}>
                  {(s.sets || []).map((set, i) => (
                    <span
                      key={i}
                      className="ft-mono"
                      style={{ fontSize:11, padding:"3px 8px", borderRadius:999, background:C.raised, border:`1px solid ${C.border}`, color:C.cream }}
                    >
                      {fmtN(parseFloat(set.weight) || 0)} lbs × {parseInt(set.reps) || 0} reps{set.rpe != null && set.rpe > 0 ? ` @ RPE ${set.rpe}` : ""}
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return null;
}

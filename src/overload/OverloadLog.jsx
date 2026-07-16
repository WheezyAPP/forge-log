import { useState, useEffect, useMemo, useRef } from "react";
import {
  Dumbbell, TrendingUp, History, Plus, Trash2, X, Zap,
  ChevronUp, ChevronDown, BarChart2, ExternalLink, Trophy,
} from "lucide-react";
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from "recharts";
import { EXERCISE_LINKS } from "./exerciseLinks";
import { getProgressionSuggestion } from "../lib/splits";
import {
  loadWorkoutSessions,
  insertWorkoutSessions,
  deleteWorkoutSession,
} from "../lib/storage";

// ─── EXERCISE DATABASE ─────────────────────────────────────────────
const EXERCISES = {
  "Chest":                    ["Barbell Bench Press","Incline Barbell Press","Floor Press","Dumbbell Bench Press","Incline Dumbbell Press","Dumbbell Flyes","Dumbbell Incline Flyes","Smith Machine Bench Press","Cable Crossovers","Pec Deck Flyes","Low to High Cable Flyes","Decline Cable Flyes","Dips","Weighted Push-Ups","Deficit Push-Ups","Feet-Elevated Push-Ups","Decline Dumbbell Press","Guillotine Press","Landmine Press","Single-Arm Cable Chest Press","Svend Press"],
  "Triceps":                  ["Tricep Cable Pushdowns","Overhead Tricep Extensions","Skull Crushers","Close-Grip Bench Press","Single-Arm Cable Tricep Kickbacks","Cross-Body Cable Tricep Extensions","Diamond Push-Ups","Bench Dips","JM Press","Rope Overhead Tricep Extensions","Tate Press"],
  "Biceps":                   ["Dumbbell Hammer Curls","Barbell Bicep Curls","Incline Dumbbell Curls","Chin-Ups","Preacher Curls","Concentration Curls","Cable Bayesian Curls","21s Bicep Curls","Cross Body Hammer Curls","EZ Bar Curls","Reverse Curls","Spider Curls","Zottman Curls"],
  "Shoulders":                ["Barbell Overhead Press","Push Press","Barbell Clean and Press","Dumbbell Shoulder Press","Seated Dumbbell Press","Arnold Press","Lateral Raises","Front Raises","Single-Arm Landmine Press","Cable Lateral Raises","Face Pulls","Reverse Pec Deck","Pike Push-Ups","Handstand Push-Ups","Bus Drivers","Cable Upright Rows","Cable Y-Raises","Dumbbell Rear Delt Flyes","Dumbbell Upright Rows"],
  "Lats":                     ["Barbell Rows","Yates Rows","Dumbbell Rows","Meadows Rows","Lat Pulldowns","Close-Grip Lat Pulldowns","Seated Cable Rows","Single-Arm Cable Rows","Pull-Ups","Straight-Arm Lat Pulldowns","Wide-Grip Pull-Ups"],
  "Rhomboids & Upper Back":   ["Pendlay Rows","Rack Pulls","Chest-Supported Dumbbell Rows","T-Bar Rows","Chest-Supported Machine Rows","Inverted Rows","Cable Face Pulls (Rope)","Renegade Rows","Seal Rows"],
  "Quads":                    ["Barbell Back Squats","Barbell Front Squats","Zercher Squats","Bulgarian Split Squats","Goblet Squats","Walking Lunges","Step-Ups","Cossack Squats","Leg Press","Hack Squats","Smith Machine Squats","Leg Extensions","Single-Leg Extensions","Sissy Squats","Wall Sits","Belt Squats","Box Squats","Cyclist Squats","Pause Squats","Single-Leg Press"],
  "Hamstrings / Glutes":      ["Conventional Deadlifts","Sumo Deadlifts","Romanian Deadlifts","Stiff-Legged Deadlifts","Barbell Hip Thrusts","Barbell Glute Bridges","Good Mornings","Reverse Lunges","Single-Leg RDLs","Lying Leg Curls","Seated Leg Curls","Standing Single-Leg Curls","Seated Calf Raises","Standing Calf Raises","Cable Pull-Throughs","Cable Glute Kickbacks","GHD Raises","Hyperextensions","Single-Leg Glute Bridges","Cable Hip Abductions","Hip Abductor Machine","Jefferson Curls","Nordic Hamstring Curls","Trap Bar Deadlifts"],
  "Abs & Core":               ["Weighted Ab Crunches","Hanging Leg Raises","Ab Wheel Rollouts","Dragon Flys","Muscle-Ups","Cable Crunches","Dead Bug","Pallof Press","Russian Twists"],
};
const ALL_EXERCISES = Object.entries(EXERCISES).flatMap(([g, exs]) =>
  exs.map(name => ({ name, group: g }))
);

// ─── DESIGN TOKENS ────────────────────────────────────────────────
// Uses a warm gold palette that complements (but visually separates from)
// the ember-orange of the main calorie tracker.
const C = {
  bg:          "#212230",
  surface:     "#2B2D3B",
  raised:      "#363850",
  border:      "#494C65",
  borderBright:"#676386",
  gold:        "#DA935D",       // Persian Orange
  goldDim:     "rgba(218,147,93,.15)",
  steel:       "#F2F1E8",
  steelDim:    "#B7B7C9",
  steelFaint:  "#6E7090",
  blue:        "#A5B2EB",       // Wondrous Wisteria
  green:       "#DDDE68",       // Succulent Lime
  red:         "#E8707A",
  goldBtn:     "#DA935D",
};

// ─── HELPERS ──────────────────────────────────────────────────────
const fmtN = (n, d = 0) => (isNaN(n) || n == null) ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
const fmtDate = (d) => new Date(d + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
// Uses LOCAL date components, not UTC — toISOString() converts to UTC
// first, which rolls the date over early for anyone west of UTC (e.g. at
// 10pm EST, UTC is already the next day).
const todayStr = () => {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};
const uuid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const epley1RM = (w, r) => r === 1 ? w : Math.round(w * (1 + r / 30));
const sessionVolume = (sets) => sets.reduce((s, x) => s + (parseFloat(x.weight) || 0) * (parseFloat(x.reps) || 0), 0);
const sessionBest1RM = (sets) => sets.reduce((b, x) => { const v = epley1RM(parseFloat(x.weight) || 0, parseInt(x.reps) || 0); return v > b ? v : b; }, 0);
const avgWeight = (sets) => sets.length ? sets.reduce((s, x) => s + (parseFloat(x.weight) || 0), 0) / sets.length : 0;

// ─── PR DETECTION ───────────────────────────────────────────────────
// Walks every session in chronological order, tracking the running best
// e1RM / volume / top-weight per exercise, and flags a session as a PR
// the moment it beats whatever came before it. The very first time an
// exercise is ever logged doesn't count as a PR — there's nothing to
// beat yet, so flagging it would just be noise.
function computePRFlags(sessions) {
  const sorted = [...sessions].sort((a, b) => a.date.localeCompare(b.date) || String(a.id).localeCompare(String(b.id)));
  const bestByExercise = {};
  const seenExercise = new Set();
  const flags = {};

  for (const s of sorted) {
    const filled = (s.sets || []).filter(x => x.weight && x.reps);
    if (!filled.length) { flags[s.id] = { isPR: false, prTypes: [] }; continue; }

    const e1RM = sessionBest1RM(filled);
    const volume = sessionVolume(filled);
    const topWeight = Math.max(...filled.map(x => parseFloat(x.weight) || 0));

    const isFirstEver = !seenExercise.has(s.exercise);
    seenExercise.add(s.exercise);

    const prev = bestByExercise[s.exercise] || { e1RM: 0, volume: 0, weight: 0 };
    const prTypes = [];
    if (!isFirstEver) {
      if (e1RM > prev.e1RM) prTypes.push("e1RM");
      if (volume > prev.volume) prTypes.push("volume");
      if (topWeight > prev.weight) prTypes.push("weight");
    }

    flags[s.id] = { isPR: prTypes.length > 0, prTypes };
    bestByExercise[s.exercise] = {
      e1RM: Math.max(prev.e1RM, e1RM),
      volume: Math.max(prev.volume, volume),
      weight: Math.max(prev.weight, topWeight),
    };
  }
  return flags;
}

const PR_LABELS = { e1RM: "Est. 1RM", volume: "Volume", weight: "Top weight" };

// ─── GLOBAL STYLES (scoped to .po-app) ────────────────────────────
const PoStyles = () => (
  <style>{`
    .po-app { font-family: 'Inter', 'Segoe UI', system-ui, sans-serif; background: ${C.bg}; color: ${C.steel}; border-radius: 14px; padding: 20px; }
    .po-display { font-family: 'Barlow Condensed', 'Bebas Neue', 'Impact', sans-serif; letter-spacing: .06em; text-transform: uppercase; }
    .po-mono { font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace; }
    .po-label { font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: ${C.steelDim}; font-weight: 600; display: block; margin-bottom: 4px; }
    .po-panel { background: ${C.surface}; border: 1px solid ${C.border}; border-radius: 10px; overflow: hidden; }
    .po-raised { background: ${C.raised}; border-radius: 7px; }
    .po-badge { font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 20px; letter-spacing:.04em; display:inline-block; }
    .po-input { background: ${C.raised}; border: 1px solid ${C.border}; border-radius: 6px; color: ${C.steel}; font-size: 13px; padding: 6px 9px; width: 100%; box-sizing: border-box; outline: none; font-family: inherit; }
    .po-input:focus { border-color: ${C.gold}; }
    .po-select { background: ${C.raised}; border: 1px solid ${C.border}; border-radius: 6px; color: ${C.steel}; font-size: 13px; padding: 6px 9px; width: 100%; box-sizing: border-box; outline: none; }
    .po-select:focus { border-color: ${C.gold}; }
    .po-btn { display: inline-flex; align-items: center; gap: 5px; padding: 6px 12px; border-radius: 6px; border: none; font-size: 12px; font-weight: 600; cursor: pointer; transition: filter .1s; white-space: nowrap; }
    .po-btn:hover { filter: brightness(1.1); }
    .po-btn-ghost { background: ${C.raised}; border: 1px solid ${C.borderBright}; color: ${C.steelDim}; }
    .po-btn-danger { background: rgba(220,60,60,.18); color: #E8707A; border: none; padding: 5px 8px; }
    .po-btn-gold { background: ${C.goldBtn}; color: #1a0e00; font-weight: 700; }
    .po-btn-tutorial { background: ${C.goldDim}; border: 1px solid ${C.gold}; color: ${C.gold}; padding: 5px 10px; font-size: 11px; }
    .po-tab-bar { display: flex; gap: 4px; margin-bottom: 18px; background: ${C.surface}; border-radius: 8px; padding: 4px; border: 1px solid ${C.border}; width: fit-content; }
    .po-tab { background: transparent; border: none; color: ${C.steelDim}; font-size: 12px; font-weight: 600; padding: 6px 14px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; gap: 6px; position: relative; letter-spacing:.02em; }
    .po-tab:hover { color: ${C.steel}; }
    .po-tab.active { background: ${C.gold}; color: #1a0e00; }
    .po-set-row { display: grid; grid-template-columns: 28px 1fr 1fr 1fr 1fr 2fr 36px; gap: 8px; align-items: center; }
    .po-set-row.header { margin-bottom: 2px; }
    .po-stat { padding: 12px 14px; }
    .po-stat-val { font-size: 18px; font-weight: 700; margin-top: 2px; }
    .po-scroll::-webkit-scrollbar { width: 4px; height: 4px; }
    .po-scroll::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 2px; }
    .po-fade { animation: poFadeIn .2s ease; }
    @keyframes poFadeIn { from { opacity:0; transform:translateY(3px) } to { opacity:1; transform:translateY(0) } }
    .recharts-tooltip-wrapper { outline: none !important; }
  `}</style>
);

// ─── TOOLTIP ──────────────────────────────────────────────────────
const TooltipBox = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: C.raised, border: `1px solid ${C.borderBright}`, borderRadius: 8, padding: "10px 14px", fontSize: 12 }}>
      <div style={{ color: C.steelDim, marginBottom: 6 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color, fontFamily: "JetBrains Mono", fontWeight: 600 }}>
          {p.name}: {fmtN(p.value, 1)}
        </div>
      ))}
    </div>
  );
};

// ─── EXERCISE PICKER ──────────────────────────────────────────────
function ExercisePicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef();

  useEffect(() => {
    const fn = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, []);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return ALL_EXERCISES.filter(e => e.name.toLowerCase().includes(q)).slice(0, 40);
  }, [query]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <div
        onClick={() => setOpen(o => !o)}
        style={{ background: C.bg, border: `1px solid ${open ? C.gold : C.border}`, borderRadius: 6, padding: "7px 10px", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}
      >
        <span style={{ color: value ? C.steel : C.steelFaint }}>{value || "Select exercise…"}</span>
        {open ? <ChevronUp size={14} color={C.steelDim} /> : <ChevronDown size={14} color={C.steelDim} />}
      </div>
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, background: C.raised, border: `1px solid ${C.borderBright}`, borderRadius: 8, zIndex: 100, maxHeight: 280, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "8px 8px 4px" }}>
            <input autoFocus className="po-input" placeholder="Search exercises…" value={query} onChange={e => setQuery(e.target.value)} />
          </div>
          <div className="po-scroll" style={{ overflowY: "auto", flex: 1 }}>
            {Object.entries(EXERCISES).map(([group, exs]) => {
              const hits = exs.filter(e => e.toLowerCase().includes(query.toLowerCase()));
              if (!hits.length) return null;
              return (
                <div key={group}>
                  <div style={{ padding: "5px 10px 2px", fontSize: 10, color: C.gold, letterSpacing: ".08em", textTransform: "uppercase", fontWeight: 700 }}>{group}</div>
                  {hits.map(ex => (
                    <div
                      key={ex}
                      onClick={() => { onChange(ex, group); setOpen(false); setQuery(""); }}
                      style={{ padding: "7px 12px", fontSize: 13, cursor: "pointer", background: ex === value ? C.goldDim : "transparent", color: ex === value ? C.gold : C.steel }}
                      onMouseEnter={e => e.currentTarget.style.background = ex === value ? C.goldDim : C.bg}
                      onMouseLeave={e => e.currentTarget.style.background = ex === value ? C.goldDim : "transparent"}
                    >{ex}</div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── SET ROW ──────────────────────────────────────────────────────
function SetRow({ set, idx, onChange, onRemove }) {
  const vol = (parseFloat(set.weight) || 0) * (parseFloat(set.reps) || 0);
  const rm  = set.weight && set.reps ? epley1RM(parseFloat(set.weight), parseInt(set.reps)) : null;

  const field = (key, placeholder, extra = {}) => (
    <input
      className="po-input"
      type="number" inputMode="decimal"
      placeholder={placeholder}
      value={set[key]}
      onChange={e => onChange(set.id, key, e.target.value)}
      onFocus={e => e.target.select()}
      style={{ textAlign: "center", ...extra }}
    />
  );

  return (
    <div className="po-set-row po-fade" style={{ padding: "4px 0" }}>
      <div className="po-mono" style={{ fontSize: 13, color: C.steelDim, textAlign: "center" }}>{idx + 1}</div>
      {field("weight", "lbs")}
      {field("reps", "reps")}
      <div style={{ textAlign: "center", fontFamily: "JetBrains Mono", fontSize: 13, color: vol > 0 ? C.steel : C.steelFaint }}>
        {vol > 0 ? fmtN(vol) : "—"}
      </div>
      <div style={{ textAlign: "center", fontFamily: "JetBrains Mono", fontSize: 13, color: rm ? C.gold : C.steelFaint }}>
        {rm ? fmtN(rm) : "—"}
      </div>
      <div style={{ display: "flex", gap: 4 }}>
        {field("rpe", "RPE", { fontSize: 12 })}
        {field("restSec", "rest(s)", { fontSize: 12 })}
      </div>
      <button className="po-btn po-btn-danger" onClick={() => onRemove(set.id)}>
        <X size={13} />
      </button>
    </div>
  );
}

// ─── EXERCISE BLOCK ───────────────────────────────────────────────
function ExerciseBlock({ block, onChange, onRemove, allSessions }) {
  const sets    = block.sets;
  const filled  = sets.filter(s => s.weight && s.reps);
  const vol     = sessionVolume(filled);
  const best1rm = sessionBest1RM(filled);
  const avg     = avgWeight(filled);
  const tutUrl  = EXERCISE_LINKS[block.exercise];

  // Double progression: look at previous sessions for this exercise
  const exerciseHistory = useMemo(() =>
    block.exercise ? allSessions.filter(s => s.exercise === block.exercise) : [],
  [allSessions, block.exercise]);
  const progression = useMemo(() =>
    exerciseHistory.length > 0 ? getProgressionSuggestion(exerciseHistory, block.group, block.exercise) : null,
  [exerciseHistory, block.group]);

  const updateSet = (id, key, val) => onChange({ ...block, sets: sets.map(s => s.id === id ? { ...s, [key]: val } : s) });
  const removeSet = (id)           => onChange({ ...block, sets: sets.filter(s => s.id !== id) });
  const addSet    = () => {
    const last = sets[sets.length - 1];
    const pre  = last ? { ...emptySet(), weight: last.weight, reps: last.reps, restSec: last.restSec } : emptySet();
    onChange({ ...block, sets: [...sets, pre] });
  };

  return (
    <div className="po-panel" style={{ padding: 16, marginBottom: 12 }}>
      {/* Exercise header: picker + optional tutorial link + remove */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 10, gap: 12 }}>
        <div style={{ flex: 1 }}>
          <ExercisePicker value={block.exercise} onChange={(ex, group) => onChange({ ...block, exercise: ex, group })} />
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 5 }}>
            {block.group && (
              <div style={{ fontSize: 11, color: C.gold, letterSpacing: ".05em" }}>{block.group}</div>
            )}
            {tutUrl && (
              <a
                href={tutUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="po-btn po-btn-tutorial"
                style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 4 }}
                title="Watch a form & technique tutorial on YouTube"
              >
                <ExternalLink size={11} /> Form &amp; Tutorial
              </a>
            )}
          </div>
        </div>
        <button className="po-btn po-btn-danger" onClick={onRemove} style={{ flexShrink: 0 }}>
          <Trash2 size={14} />
        </button>
      </div>

      {/* Double progression suggestion */}
      {progression && block.exercise && (
        <div style={{ background: progression.type === "increase" ? `${C.green}15` : `${C.gold}15`, border: `1px solid ${progression.type === "increase" ? C.green : C.gold}40`, borderRadius: 7, padding: "7px 10px", marginBottom: 10, fontSize: 11, color: progression.type === "increase" ? C.green : C.gold, lineHeight: 1.5 }}>
          📈 {progression.msg}
        </div>
      )}

      {/* Live stats row */}
      {vol > 0 && (
        <div style={{ display: "flex", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
          <MiniStat label="Volume"        val={`${fmtN(vol)} lbs`}    color={C.steel} />
          <MiniStat label="Best e1RM"     val={`${fmtN(best1rm)} lbs`} color={C.gold} />
          <MiniStat label="Avg wt / rep"  val={`${fmtN(avg, 1)} lbs`}  color={C.blue} />
        </div>
      )}

      {/* Column headers */}
      <div className="po-set-row header" style={{ marginBottom: 4 }}>
        <div className="po-label" style={{ textAlign: "center" }}>#</div>
        <div className="po-label" style={{ textAlign: "center" }}>Weight</div>
        <div className="po-label" style={{ textAlign: "center" }}>Reps</div>
        <div className="po-label" style={{ textAlign: "center" }}>Volume</div>
        <div className="po-label" style={{ textAlign: "center" }}>e1RM</div>
        <div className="po-label" style={{ textAlign: "center" }}>RPE / Rest</div>
        <div />
      </div>

      {sets.map((s, i) => (
        <SetRow key={s.id} set={s} idx={i} onChange={updateSet} onRemove={removeSet} />
      ))}

      <button className="po-btn po-btn-ghost" onClick={addSet} style={{ marginTop: 10, fontSize: 12 }}>
        <Plus size={13} /> Add set
      </button>
    </div>
  );
}

// ─── LOG TAB ──────────────────────────────────────────────────────
const emptySet = () => ({ id: uuid(), weight: "", reps: "", rpe: "", rir: "", restSec: "" });

function LogTab({ logDate, setLogDate, blocks, setBlocks, onSave, saving, allSessions }) {
  const addExercise  = () => setBlocks(b => [...b, { id: uuid(), exercise: "", group: "", sets: [emptySet()] }]);
  const updateBlock  = (id, next) => setBlocks(bs => bs.map(b => b.id === id ? next : b));
  const removeBlock  = (id) => setBlocks(bs => bs.filter(b => b.id !== id));

  const totalVol = blocks.reduce((s, b) => {
    return s + sessionVolume(b.sets.filter(x => x.weight && x.reps));
  }, 0);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <div>
          <span className="po-label">Workout date</span>
          <input type="date" className="po-input" value={logDate} onChange={e => setLogDate(e.target.value)} style={{ width: 160 }} />
        </div>
        {totalVol > 0 && (
          <div className="po-raised" style={{ padding: "8px 14px", borderRadius: 8 }}>
            <span className="po-label" style={{ marginBottom: 2 }}>Session volume</span>
            <div className="po-mono" style={{ fontSize: 18, fontWeight: 600, color: C.gold }}>{fmtN(totalVol)} lbs</div>
          </div>
        )}
      </div>

      {blocks.map(b => (
        <ExerciseBlock
          key={b.id}
          block={b}
          onChange={(next) => updateBlock(b.id, next)}
          onRemove={() => removeBlock(b.id)}
          allSessions={allSessions}
        />
      ))}

      <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
        <button className="po-btn po-btn-ghost" onClick={addExercise}>
          <Plus size={14} /> Add exercise
        </button>
        {blocks.length > 0 && (
          <button className="po-btn po-btn-gold" onClick={() => onSave(blocks)} disabled={saving}>
            <Zap size={14} /> {saving ? "Saving…" : "Save workout"}
          </button>
        )}
      </div>

      {blocks.length === 0 && (
        <div className="po-panel" style={{ padding: 40, textAlign: "center", marginTop: 8 }}>
          <BarChart2 size={28} color={C.steelDim} style={{ margin: "0 auto 10px" }} />
          <div className="po-display" style={{ fontSize: 18, marginBottom: 6 }}>START TRACKING</div>
          <div style={{ fontSize: 13, color: C.steelDim }}>Add an exercise to begin logging your sets. Each exercise has a "Form &amp; Tutorial" link to a YouTube guide.</div>
        </div>
      )}
    </div>
  );
}

// ─── PROGRESS TAB ─────────────────────────────────────────────────
function ProgressTab({ sessions, prFlags = {} }) {
  const exerciseNames = [...new Set(sessions.map(s => s.exercise))].sort();
  const [selected, setSelected] = useState(exerciseNames[0] || "");

  useEffect(() => {
    if (!selected && exerciseNames.length) setSelected(exerciseNames[0]);
  }, [exerciseNames.length]);

  const data = useMemo(() => sessions
    .filter(s => s.exercise === selected)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(s => ({
      id:         s.id,
      date:       fmtDate(s.date),
      fullDate:   s.date,
      best1RM:    sessionBest1RM(s.sets),
      volume:     sessionVolume(s.sets),
      avgWeight:  avgWeight(s.sets),
      topWeight:  Math.max(...s.sets.map(x => parseFloat(x.weight) || 0)),
      sets:       s.sets.length,
    })),
  [sessions, selected]);

  const latest    = data[data.length - 1];
  const prev      = data[data.length - 2];
  const delta1RM  = latest && prev ? latest.best1RM - prev.best1RM : null;
  const deltaVol  = latest && prev ? latest.volume - prev.volume : null;
  const tutUrl    = selected ? EXERCISE_LINKS[selected] : null;
  const latestPR  = latest ? prFlags[latest.id] : null;

  if (!exerciseNames.length) {
    return (
      <div className="po-panel" style={{ padding: 40, textAlign: "center" }}>
        <TrendingUp size={28} color={C.steelDim} style={{ margin: "0 auto 10px" }} />
        <div className="po-display" style={{ fontSize: 18, marginBottom: 6 }}>NO DATA YET</div>
        <div style={{ fontSize: 13, color: C.steelDim }}>Log some workouts to see your progress here.</div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 16, display: "flex", alignItems: "flex-end", gap: 12, flexWrap: "wrap" }}>
        <div>
          <span className="po-label">Exercise</span>
          <select className="po-select" value={selected} onChange={e => setSelected(e.target.value)} style={{ maxWidth: 340 }}>
            {exerciseNames.map(e => <option key={e} value={e}>{e}</option>)}
          </select>
        </div>
        {tutUrl && (
          <a
            href={tutUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="po-btn po-btn-tutorial"
            style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 5, marginBottom: 1 }}
          >
            <ExternalLink size={12} /> Form &amp; Tutorial
          </a>
        )}
      </div>

      {latest && (
        <>
          {latestPR?.isPR && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10, fontSize: 12, color: C.gold, fontWeight: 700 }}>
              <Trophy size={14} /> Your last session was a new PR — {latestPR.prTypes.map(t => PR_LABELS[t]).join(" & ")}
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px,1fr))", gap: 10, marginBottom: 16 }}>
            <StatCard label="Best e1RM"       val={`${fmtN(latest.best1RM)} lbs`}      delta={delta1RM} color={C.gold} />
            <StatCard label="Session volume"  val={`${fmtN(latest.volume)} lbs`}        delta={deltaVol} color={C.blue} />
            <StatCard label="Top weight"      val={`${fmtN(latest.topWeight)} lbs`}     color={C.green} />
            <StatCard label="Avg wt / rep"    val={`${fmtN(latest.avgWeight, 1)} lbs`}  color={C.steel} />
            <StatCard label="Sessions logged" val={data.length}                          color={C.steelDim} />
          </div>
        </>
      )}

      {data.length > 1 ? (
        <>
          <ChartPanel title="Estimated 1RM (Epley formula)" subtitle="Higher = stronger">
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={data}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis dataKey="date" stroke={C.steelDim} fontSize={11} />
                <YAxis stroke={C.steelDim} fontSize={11} domain={["auto","auto"]} />
                <Tooltip content={<TooltipBox />} />
                <Line type="monotone" dataKey="best1RM" stroke={C.gold} strokeWidth={2.5} dot={{ r: 3, fill: C.gold }} name="e1RM (lbs)" />
              </LineChart>
            </ResponsiveContainer>
          </ChartPanel>

          <ChartPanel title="Session volume (sets × reps × weight)" subtitle="Total mechanical work">
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={data}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis dataKey="date" stroke={C.steelDim} fontSize={11} />
                <YAxis stroke={C.steelDim} fontSize={11} />
                <Tooltip content={<TooltipBox />} />
                <Bar dataKey="volume" fill={C.blue} radius={[4,4,4,4]} name="Volume (lbs)" />
              </BarChart>
            </ResponsiveContainer>
          </ChartPanel>

          <ChartPanel title="Average weight per rep" subtitle="Tracks load progression">
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={data}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis dataKey="date" stroke={C.steelDim} fontSize={11} />
                <YAxis stroke={C.steelDim} fontSize={11} domain={["auto","auto"]} />
                <Tooltip content={<TooltipBox />} />
                <Line type="monotone" dataKey="avgWeight" stroke={C.green} strokeWidth={2} dot={{ r: 3 }} name="Avg weight (lbs)" />
                <Line type="monotone" dataKey="topWeight" stroke={C.red} strokeWidth={1.5} strokeDasharray="5 3" dot={false} name="Top weight (lbs)" />
              </LineChart>
            </ResponsiveContainer>
          </ChartPanel>
        </>
      ) : (
        <div className="po-panel" style={{ padding: 24, textAlign: "center" }}>
          <div style={{ fontSize: 13, color: C.steelDim }}>Log at least 2 sessions for this exercise to see trend charts.</div>
        </div>
      )}

      {data.length > 0 && (
        <div className="po-panel" style={{ marginTop: 12, overflow: "hidden" }}>
          <div style={{ padding: "12px 14px 8px", borderBottom: `1px solid ${C.border}` }}>
            <div className="po-display" style={{ fontSize: 15, fontWeight: 700 }}>SESSION LOG</div>
          </div>
          <div className="po-scroll" style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 420 }}>
              <thead>
                <tr style={{ background: C.raised }}>
                  {["Date","Sets","Best e1RM","Volume","Avg lbs/rep","Top Weight"].map(h => (
                    <th key={h} style={{ padding: "7px 12px", textAlign: "left", color: C.steelDim, fontFamily: "Barlow Condensed", letterSpacing: ".06em", textTransform: "uppercase", fontSize: 11 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.map((row, i) => (
                  <tr key={i} style={{ borderTop: `1px solid ${C.border}` }}>
                    <td style={{ padding: "6px 12px", color: C.steelDim, fontFamily: "JetBrains Mono", fontSize: 11 }}>{row.date}</td>
                    <td style={{ padding: "6px 12px", fontFamily: "JetBrains Mono" }}>{row.sets}</td>
                    <td style={{ padding: "6px 12px", fontFamily: "JetBrains Mono", color: C.gold }}>{fmtN(row.best1RM)} lbs</td>
                    <td style={{ padding: "6px 12px", fontFamily: "JetBrains Mono", color: C.blue }}>{fmtN(row.volume)} lbs</td>
                    <td style={{ padding: "6px 12px", fontFamily: "JetBrains Mono" }}>{fmtN(row.avgWeight, 1)} lbs</td>
                    <td style={{ padding: "6px 12px", fontFamily: "JetBrains Mono", color: C.green }}>{fmtN(row.topWeight)} lbs</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── HISTORY TAB ──────────────────────────────────────────────────
function HistoryTab({ sessions, onDelete, prFlags = {} }) {
  const byDate = useMemo(() => {
    const map = {};
    sessions.forEach(s => { if (!map[s.date]) map[s.date] = []; map[s.date].push(s); });
    return Object.entries(map).sort((a, b) => b[0].localeCompare(a[0]));
  }, [sessions]);

  const [expandedDate, setExpandedDate] = useState(null);

  if (!sessions.length) {
    return (
      <div className="po-panel" style={{ padding: 40, textAlign: "center" }}>
        <History size={28} color={C.steelDim} style={{ margin: "0 auto 10px" }} />
        <div className="po-display" style={{ fontSize: 18, marginBottom: 6 }}>NO SESSIONS YET</div>
        <div style={{ fontSize: 13, color: C.steelDim }}>Your saved workouts will appear here.</div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {byDate.map(([date, daySessions]) => {
        const totalVol = daySessions.reduce((s, x) => s + sessionVolume(x.sets), 0);
        const groups   = [...new Set(daySessions.map(s => s.group))].join(", ");
        const expanded = expandedDate === date;
        const dayHasPR = daySessions.some(s => prFlags[s.id]?.isPR);

        return (
          <div key={date} className="po-panel">
            <div
              onClick={() => setExpandedDate(expanded ? null : date)}
              style={{ padding: "12px 14px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                  <div className="po-display" style={{ fontSize: 16, fontWeight: 700 }}>
                    {new Date(date + "T00:00:00").toLocaleDateString(undefined, { weekday: "short", month: "long", day: "numeric" })}
                  </div>
                  <div className="po-badge" style={{ background: C.goldDim, color: C.gold }}>{daySessions.length} exercise{daySessions.length > 1 ? "s" : ""}</div>
                  {dayHasPR && <Trophy size={14} color={C.gold} title="PR set this day" />}
                </div>
                <div style={{ fontSize: 12, color: C.steelDim }}>{groups} · <span className="po-mono">{fmtN(totalVol)} lbs total</span></div>
              </div>
              {expanded ? <ChevronUp size={16} color={C.steelDim} /> : <ChevronDown size={16} color={C.steelDim} />}
            </div>

            {expanded && (
              <div style={{ borderTop: `1px solid ${C.border}`, padding: "10px 14px 14px" }}>
                {daySessions.map(s => {
                  const tutUrl = EXERCISE_LINKS[s.exercise];
                  const pr = prFlags[s.id];
                  return (
                    <div key={s.id} className="po-raised" style={{ marginBottom: 8, padding: 12, border: pr?.isPR ? `1px solid ${C.gold}` : "none" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 14, display: "flex", alignItems: "center", gap: 6 }}>
                            {s.exercise}
                            {pr?.isPR && <Trophy size={13} color={C.gold} />}
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 3, flexWrap: "wrap" }}>
                            <div style={{ fontSize: 11, color: C.gold }}>{s.group}</div>
                            {pr?.isPR && (
                              <div style={{ fontSize: 10, color: C.gold, fontWeight: 700 }}>
                                PR: {pr.prTypes.map(t => PR_LABELS[t]).join(" & ")}
                              </div>
                            )}
                            {tutUrl && (
                              <a
                                href={tutUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="po-btn po-btn-tutorial"
                                style={{ textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 3 }}
                              >
                                <ExternalLink size={10} /> Tutorial
                              </a>
                            )}
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                          <div className="po-mono" style={{ fontSize: 11, color: C.steelDim }}>
                            e1RM: <span style={{ color: C.gold }}>{fmtN(sessionBest1RM(s.sets))} lbs</span>
                            {" · "}vol: <span style={{ color: C.blue }}>{fmtN(sessionVolume(s.sets))} lbs</span>
                          </div>
                          <button className="po-btn po-btn-danger" onClick={() => onDelete(s.id)}><Trash2 size={13} /></button>
                        </div>
                      </div>

                      <div className="po-scroll" style={{ overflowX: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                          <thead>
                            <tr>
                              {["Set","Weight","Reps","Volume","e1RM","RPE","Rest"].map(h => (
                                <th key={h} style={{ padding: "4px 8px", textAlign: "center", color: C.steelDim, fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase" }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {s.sets.map((set, i) => {
                              const w = parseFloat(set.weight) || 0;
                              const r = parseInt(set.reps)    || 0;
                              return (
                                <tr key={set.id || i} style={{ borderTop: `1px solid ${C.border}` }}>
                                  <td style={{ padding: "5px 8px", textAlign: "center", color: C.steelDim, fontFamily: "JetBrains Mono" }}>{i + 1}</td>
                                  <td style={{ padding: "5px 8px", textAlign: "center", fontFamily: "JetBrains Mono" }}>{fmtN(w)} lbs</td>
                                  <td style={{ padding: "5px 8px", textAlign: "center", fontFamily: "JetBrains Mono" }}>{r}</td>
                                  <td style={{ padding: "5px 8px", textAlign: "center", fontFamily: "JetBrains Mono" }}>{fmtN(w * r)}</td>
                                  <td style={{ padding: "5px 8px", textAlign: "center", fontFamily: "JetBrains Mono", color: C.gold }}>{w && r ? fmtN(epley1RM(w, r)) : "—"}</td>
                                  <td style={{ padding: "5px 8px", textAlign: "center", fontFamily: "JetBrains Mono", color: C.steelDim }}>{set.rpe || "—"}</td>
                                  <td style={{ padding: "5px 8px", textAlign: "center", fontFamily: "JetBrains Mono", color: C.steelDim }}>{set.restSec ? `${set.restSec}s` : "—"}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── SMALL COMPONENTS ─────────────────────────────────────────────
function StatCard({ label, val, delta, color }) {
  return (
    <div className="po-panel po-stat">
      <span className="po-label">{label}</span>
      <div className="po-stat-val po-mono" style={{ color }}>{val}</div>
      {delta != null && (
        <div style={{ fontSize: 11, marginTop: 3, color: delta >= 0 ? C.green : C.red }}>
          {delta >= 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(1)} vs prev
        </div>
      )}
    </div>
  );
}

function MiniStat({ label, val, color }) {
  return (
    <div className="po-raised" style={{ padding: "5px 10px", display: "flex", flexDirection: "column", gap: 1 }}>
      <span style={{ fontSize: 9, color: C.steelDim, textTransform: "uppercase", letterSpacing: ".06em" }}>{label}</span>
      <span className="po-mono" style={{ fontSize: 14, fontWeight: 600, color }}>{val}</span>
    </div>
  );
}

function ChartPanel({ title, subtitle, children }) {
  return (
    <div className="po-panel" style={{ padding: 16, marginBottom: 12 }}>
      <div style={{ marginBottom: 12 }}>
        <div className="po-display" style={{ fontSize: 14, fontWeight: 700, letterSpacing: ".05em" }}>{title}</div>
        {subtitle && <div style={{ fontSize: 11, color: C.steelDim, marginTop: 1 }}>{subtitle}</div>}
      </div>
      {children}
    </div>
  );
}

// ─── MAIN OVERLOAD LOG ────────────────────────────────────────────
// Receives `userId` from the parent app, loads/saves to Supabase
// workout_sessions table — completely separate from the calorie log.
export default function OverloadLog({ userId }) {
  const [tab, setTab]             = useState("log");
  const [sessions, setSessions]   = useState([]);
  const [loaded, setLoaded]       = useState(false);
  const [saving, setSaving]       = useState(false);
  const [logDate, setLogDate]     = useState(todayStr());
  const [activeBlocks, setActiveBlocks] = useState([]);
  const [justSavedPRs, setJustSavedPRs] = useState([]); // [{exercise, prTypes}] — shown as a celebration banner right after saving

  useEffect(() => {
    (async () => {
      const data = await loadWorkoutSessions(userId);
      setSessions(data);
      setLoaded(true);
    })();
  }, [userId]);

  // Recomputed whenever sessions change — { [sessionId]: {isPR, prTypes} }
  const prFlags = useMemo(() => computePRFlags(sessions), [sessions]);

  const saveSession = async (blocks) => {
    const toAdd = blocks
      .filter(b => b.exercise && b.sets.some(s => s.weight > 0 && s.reps > 0))
      .map(b => ({
        date:     logDate,
        exercise: b.exercise,
        group:    b.group,
        sets:     b.sets.filter(s => s.weight > 0 && s.reps > 0),
      }));
    if (!toAdd.length) return;
    setSaving(true);
    const saved = await insertWorkoutSessions(userId, toAdd);
    const nextSessions = [...sessions, ...saved];
    setSessions(nextSessions);
    setActiveBlocks([]);
    setSaving(false);

    // Check which of the just-saved sessions are PRs against everything
    // that came before them (including each other, in date/id order).
    const flags = computePRFlags(nextSessions);
    const prs = saved
      .filter(s => flags[s.id]?.isPR)
      .map(s => ({ exercise: s.exercise, prTypes: flags[s.id].prTypes }));
    if (prs.length > 0) setJustSavedPRs(prs);
  };

  const handleDelete = async (id) => {
    await deleteWorkoutSession(userId, id);
    setSessions(prev => prev.filter(s => s.id !== id));
  };

  if (!loaded) {
    return (
      <div className="po-app" style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: 200 }}>
        <PoStyles />
        <div className="po-mono" style={{ color: C.steelDim }}>Loading workouts…</div>
      </div>
    );
  }

  return (
    <div className="po-app">
      <PoStyles />

      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 18 }}>
        <div style={{ width: 42, height: 42, background: C.gold, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Dumbbell size={22} color="#1a0e00" />
        </div>
        <div>
          <div className="po-display" style={{ fontSize: 26, fontWeight: 800, lineHeight: 1, letterSpacing: ".06em" }}>OVERLOAD LOG</div>
          <div className="po-mono" style={{ fontSize: 11, color: C.steelDim }}>progressive overload tracker · {sessions.length} sessions saved</div>
        </div>
      </div>

      {/* Tabs */}
      <div className="po-tab-bar">
        {[
          ["log",      "Log Workout", <Dumbbell size={13} key="i" />],
          ["progress", "Progress",    <TrendingUp size={13} key="i" />],
          ["history",  "History",     <History size={13} key="i" />],
        ].map(([k, label, icon]) => (
          <button key={k} className={`po-tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>
            {icon} {label}
          </button>
        ))}
      </div>

      {/* PR celebration — shown right after a save that beat a prior best */}
      {justSavedPRs.length > 0 && (
        <div
          className="po-fade"
          style={{
            display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 16,
            padding: "12px 14px", borderRadius: 10,
            background: "linear-gradient(135deg, rgba(240,192,64,.18), rgba(240,192,64,.06))",
            border: `1px solid ${C.gold}`,
          }}
        >
          <Trophy size={20} color={C.gold} style={{ flexShrink: 0, marginTop: 1 }} />
          <div style={{ flex: 1 }}>
            <div className="po-display" style={{ fontSize: 15, fontWeight: 800, color: C.gold, marginBottom: 3 }}>
              NEW PR{justSavedPRs.length > 1 ? "s" : ""}!
            </div>
            {justSavedPRs.map((pr, i) => (
              <div key={i} style={{ fontSize: 12, color: C.steel, marginBottom: 2 }}>
                <span style={{ fontWeight: 700 }}>{pr.exercise}</span> — new best {pr.prTypes.map(t => PR_LABELS[t]).join(" & ")}
              </div>
            ))}
          </div>
          <button onClick={() => setJustSavedPRs([])} style={{ background: "none", border: "none", color: C.steelDim, cursor: "pointer", padding: 4 }}>
            <X size={14} />
          </button>
        </div>
      )}

      {tab === "log"      && <LogTab logDate={logDate} setLogDate={setLogDate} blocks={activeBlocks} setBlocks={setActiveBlocks} onSave={saveSession} saving={saving} allSessions={sessions} />}
      {tab === "progress" && <ProgressTab sessions={sessions} prFlags={prFlags} />}
      {tab === "history"  && <HistoryTab sessions={sessions} onDelete={handleDelete} prFlags={prFlags} />}
    </div>
  );
}

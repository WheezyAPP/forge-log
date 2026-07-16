// src/lib/splits.js
// Shared split definitions, exercise database, and utility functions.
// Used by LiftingSchedule.jsx (UI) and App.jsx (attendance grade).

/* ── Seeded random ─────────────────────────────────────────────── */
export function seededShuffle(arr, seed) {
  const a = [...arr];
  let s = (seed % 2147483647) || 1;
  const rng = () => { s = s * 16807 % 2147483647; return (s - 1) / 2147483646; };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ── Exercise database ─────────────────────────────────────────── */
// Each group is split into three tiers so pickExercises() can build a
// session the way a trainer would: one anchor lift, a capped number of
// additional heavy compounds (never redundant stacks of 3-4 pressing or
// hip-hinge movements), then isolation/accessory work filling the rest.
export const EX = {
  "Chest": {
    primary:   ["Barbell Bench Press"],
    compound:  ["Dumbbell Bench Press","Incline Barbell Press","Incline Dumbbell Press","Floor Press","Smith Machine Bench Press","Decline Dumbbell Press","Dips","Weighted Push-Ups","Landmine Press","Guillotine Press","Close-Grip Push-Up","Decline Barbell Press","Decline Machine Chest Press","Decline Smith Machine Press","Deficit Pushup","Low Incline Barbell Press","Low Incline Chest Machine Press","Low Incline DB Press","Low Incline Machine Press","Low Incline Smith Machine Press","Machine Chest Press","Incline Machine Chest Press","Iso-Lateral Chest Press","Iso-Lateral Incline Press"],
    isolation: ["Dumbbell Flyes","Cable Crossovers","Pec Deck Flyes","Low to High Cable Flyes","Decline Cable Flyes","Svend Press","Single-Arm Cable Chest Press","Bent-Over Cable Pec Flye","Bent-Over Cable Pec Flye (w/ Integrated Partials)","DB Flye","DB Flye (w/ Integrated Partials)","Low-Incline Dumbbell Flye","Low-To-High Cable Crossover","Pec Deck","Pec Deck (w/ Integrated Partials)"],
  },
  "Lats": {
    primary:   ["Pull-Ups"],
    compound:  ["Lat Pulldowns","Barbell Rows","Yates Rows","Dumbbell Rows","Meadows Rows","Close-Grip Lat Pulldowns","Seated Cable Rows","Single-Arm Cable Rows","Wide-Grip Pull-Ups","Assisted Pull-Up","Half-Kneeling 1-Arm Lat Pulldown","Lat Pulldown","Lean-Back Lat Pulldown","Lean-Back Machine Pulldown","Machine Pulldown","Medium-Grip Pull-Up","Neutral-Grip Lat Pulldown","Neutral-Grip Pull-Up","Overhand Lat Pulldown","Pull-Up","Wide-Grip Band-Assisted Pull-Up","Wide-Grip Lat Pulldown","Dual-Handle Lat Pulldown (Mid-back + Lats)","Iso-Lateral High Row","Iso-Lateral Low Row"],
    isolation: ["Straight-Arm Lat Pulldowns","1-Arm Lat Pull-In","Cross-Body Lat Pull-Around","DB Lat Pullover","Machine Lat Pullover","Straight-Bar Lat Prayer"],
  },
  "Rhomboids & Upper Back": {
    primary:   ["T-Bar Rows"],
    compound:  ["Pendlay Rows","Rack Pulls","Chest-Supported Dumbbell Rows","Chest-Supported Machine Rows","Inverted Rows","Barbell Rows","Seal Rows","Renegade Rows","Arm-Out Single-Arm DB Row","Chest-Supported Machine Row","Chest-Supported T-Bar Row","Chest-Supported T-Bar Row + Kelso Shrug","Elbows-In 1-Arm DB Row","Helms Row","Incline Chest-Supported DB Row + Kelso Shrug","Lat-Focused Cable Row","Machine Chest-Supported Row + Kelso Shrug","Overhand Machine Row","Super-ROM Overhand Cable Row"],
    isolation: ["Cable Face Pulls (Rope)","Cable Paused Shrug-In","Machine Shrug","Rope Face Pull","Lying Paused Rope Face Pull"],
  },
  "Shoulders": {
    primary:   ["Barbell Overhead Press"],
    compound:  ["Dumbbell Shoulder Press","Arnold Press","Seated Dumbbell Press","Push Press","Dumbbell Upright Rows","Cable Upright Rows","Cable Shoulder Press","Machine Shoulder Press","Seated Barbell Shoulder Press","Seated DB Shoulder Press","Standing DB Arnold Press","Upright Row","Cable Upright Row","Viking Press","Smith Machine Overhead Press"],
    isolation: ["Lateral Raises","Front Raises","Cable Lateral Raises","Face Pulls","Reverse Pec Deck","Dumbbell Rear Delt Flyes","Cable Y-Raises","Bus Drivers","Cross-Body Cable Y-Raise","Cuffed Behind-The-Back Lateral Raise","DB Lateral Raise","DB Rear Delt Swing","DB Shrug","Machine Lateral Raise","Rear Delt 45° Cable Flye","Reverse Cable Flye","Reverse Cable Flye (w/ Integrated Partials)","Reverse Pec Deck (w/ Integrated Partials)","Super-ROM DB Lateral Raise","Bent-Over Reverse DB Flye","Bent-Over Reverse DB Flye (w/ Integrated Partials)","Cable Reverse Flye (Mechanical Dropset)"],
  },
  "Biceps": {
    // Virtually every biceps exercise is single-joint elbow flexion — there's
    // no real "compound" biceps lift once Chin-Ups (a lat/back movement) is
    // correctly excluded from this pool. Isolation variety is the point here.
    primary:   ["Barbell Bicep Curls"],
    compound:  [],
    isolation: ["Dumbbell Hammer Curls","Incline Dumbbell Curls","Preacher Curls","Concentration Curls","Cable Bayesian Curls","EZ Bar Curls","Spider Curls","Reverse Curls","Cross Body Hammer Curls","Zottman Curls","21s Bicep Curls","Bayesian Cable Curl","Bottom-2/3 Constant Tension Preacher Curl","Bottom-2/3 EZ-Bar Curl","Concentration Cable Curl","DB Concentration Curl","DB Incline Curl","DB Preacher Curl","DB Scott Curl","Fat-Grip DB Curl","Fat-Grip Preacher Curl","Hammer Preacher Curl","Incline DB Stretch-Curl","Inverse DB Zottman Curl","Kneeling Overhead Cable Curl","N1-Style Short-Head Curl","Overhead Cable Curl","Reverse-Grip Cable Curl","Reverse-Grip DB Curl","Reverse-Grip EZ-Bar Curl","Slow-Eccentric Bayesian Curl","Slow-Eccentric DB Curl","Slow-Eccentric DB Incline Curl","Slow-Eccentric DB Scott Curl","Spider Curl","Hammer Curl","Machine Preacher Curl"],
  },
  "Triceps": {
    primary:   ["Tricep Cable Pushdowns"],
    compound:  ["Close-Grip Bench Press","Diamond Push-Ups","Bench Dips","JM Press","Barbell JM Press","Bench Dip","Bodyweight Dip","Close-Grip Assisted Dip","Paused Assisted Dip","Smith Machine JM Press","Seated Dip Machine"],
    isolation: ["Skull Crushers","Overhead Tricep Extensions","Single-Arm Cable Tricep Kickbacks","Rope Overhead Tricep Extensions","Tate Press","Cable Skull Crusher","Cable Triceps Kickback","DB French Press","DB Skull Crusher","DB Triceps Kickback","Dual-Cable Triceps Press","EZ-Bar Skull Crusher","Floor Skull Crusher","Katana Triceps Extension","Overhead Cable Triceps Extension (Bar)","Overhead Cable Triceps Extension (Rope)","Seated DB French Press","Single-arm Overhead Cable Triceps Extension","Slow-Eccentric DB French Press","Slow-Eccentric DB Skull Crusher","Slow-Eccentric EZ-Bar Skull Crusher","Triceps Diverging Pressdown (Long Rope or 2 Ropes)","Triceps Pressdown (Bar)","Triceps Pressdown (Rope)","Machine Overhead Tricep Extension"],
  },
  "Quads": {
    primary:   ["Barbell Back Squats"],
    compound:  ["Leg Press","Hack Squats","Bulgarian Split Squats","Goblet Squats","Walking Lunges","Smith Machine Squats","Barbell Front Squats","Box Squats","Cyclist Squats","Pause Squats","Single-Leg Press","Belt Squats","Barbell Lunge","Belt Squat","DB Bulgarian Split Squat","DB Reverse Lunge","DB Step-Up","DB Walking Lunge","Front Squat","Goblet Squat","Hack Squat","High-Bar Back Squat","Machine Squat","Smith Machine Lunge","Smith Machine Reverse Lunge","Smith Machine Squat","Pendulum Squat","Vertical Leg Press"],
    isolation: ["Leg Extensions","Leg Extension","Sissy Squat"],
  },
  "Hamstrings/Glutes": {
    // The old pool could stack Romanian + Conventional + Trap Bar deadlifts
    // in one session — three near-identical heavy hip-hinge lifts. Now only
    // one hip-hinge compound leads, with isolation work covering the rest.
    primary:   ["Romanian Deadlifts"],
    compound:  ["Conventional Deadlifts","Trap Bar Deadlifts","Barbell Hip Thrusts","Barbell Glute Bridges","Jefferson Curls","DB RDL","Glute-Ham Raise","Good Morning (Light Weight)","Nordic Ham Curl","Paused Barbell RDL","Paused DB RDL","Reverse Nordic","Slow-Eccentric Barbell RDL","Slow-Eccentric DB RDL","Slow-Eccentric Glute-Ham Raise","Snatch-Grip RDL","Back Extensions","Glute Drive Machine","Smith Machine Hip Thrust"],
    isolation: ["Lying Leg Curls","Seated Leg Curls","Cable Pull-Throughs","GHD Raises","Seated Calf Raises","Standing Calf Raises","Nordic Hamstring Curls","Arms-Extended 45° Hyperextension","Cable Hip Abduction","Cable Hip Adduction","Copenhagen Hip Adduction","DB Calf Jumps","Donkey Calf Raise","Lateral Band Walk","Leg Press Calf Jumps","Leg Press Calf Press","Lying Leg Curl","Machine Hip Abduction","Machine Hip Adduction","Prisoner 45° Hyperextension","Seated Calf Raise","Seated Leg Curl","Standing Calf Raise","Standing Single-Leg Curl","Reverse Hyperextension","Machine Glute Kickback","Cable Glute Kickback","Machine Back Extension"],
  },
  "Abs & Core": {
    primary:   ["Hanging Leg Raises"],
    compound:  ["Ab Wheel Rollouts","Dragon Flys","Muscle-Ups","Pallof Press","Ab Wheel Rollout","Half-Kneeling Pallof Press","Hanging Leg Raise","Roman Chair Leg Raise","Swiss Ball Rollout"],
    isolation: ["Weighted Ab Crunches","Cable Crunches","Russian Twists","Dead Bug","Bicycle Crunch","Cable Crunch","LLPT Plank","Machine Crunch","Medicine Ball Russian Twists","Plate-Loaded Neck Curls","Plate-Weighted Crunch","Reverse Crunch","Stomach Vacuums","Machine Torso Rotation"],
  },
  // ── Bodyweight / calisthenics groups ───────────────────────────────
  "Bodyweight Push": {
    primary:   ["Push-Ups"],
    compound:  ["Dips","Chest Dips","Pike Push-Ups","Decline Push-Ups","Wide Push-Ups","Pseudo Planche Push-Ups","Archer Push-Ups","Ring Push-Ups","Handstand Push-Ups (wall)"],
    isolation: ["Diamond Push-Ups","Close Push-Ups"],
  },
  "Bodyweight Pull": {
    primary:   ["Pull-Ups"],
    compound:  ["Chin-Ups","Wide-Grip Pull-Ups","Commando Pull-Ups","Archer Pull-Ups","Negative Pull-Ups","Australian Pull-Ups","Inverted Rows"],
    isolation: ["Dead Hang","Hanging Scapular Retractions","L-Sit Pull-Ups"],
  },
  "Bodyweight Legs": {
    primary:   ["Bulgarian Split Squats"],
    compound:  ["Jump Squats","Walking Lunges","Step-Ups","Pistol Squat Progressions","Reverse Lunges","Lateral Lunges"],
    isolation: ["Glute Bridges","Single-Leg Glute Bridges","Nordic Curls","Calf Raises","Squat Holds"],
  },
  "Bodyweight Core": {
    primary:   ["Hollow Body Hold"],
    compound:  ["Dragon Flags","Front Lever Progressions","L-Sit Progressions","Planche Lean"],
    isolation: ["Hanging Leg Raises","Superman Holds","V-Ups","Tuck L-Sit"],
  },
};

// Anatomical groups used wherever a curated (not full EX-keys) list of
// muscle groups is needed — off-split logging, set-coverage tracking,
// etc. Excludes the "Bodyweight X" categories, which exist only to
// drive exercise rotation on calisthenics splits, not as a group someone
// would pick directly.
export const ANATOMICAL_GROUPS = [
  "Chest", "Lats", "Rhomboids & Upper Back", "Shoulders",
  "Biceps", "Triceps", "Quads", "Hamstrings/Glutes", "Abs & Core",
];

// Rolling 7-day set volume per muscle group — a different lens than the
// attendance grades, which measure whether you showed up. This measures
// whether each muscle group is actually getting enough direct work,
// regardless of which split day it came from (off-split additions,
// swaps, and Follow-My-Partner sessions all count toward the group they
// were logged under, same as anything else).
export function computeSetCoverage(workoutSessions, groups, asOfDate = null) {
  const today = asOfDate ? new Date(asOfDate + "T00:00:00") : (() => { const t = new Date(); t.setHours(0, 0, 0, 0); return t; })();
  const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() - 6); // 7 days inclusive
  const cutoffStr = localDateStr(cutoff);
  const todayStr2 = localDateStr(today);
  const inWindow = (workoutSessions || []).filter(s => s.date >= cutoffStr && s.date <= todayStr2);
  return groups.map(group => {
    const sets = inWindow.filter(s => s.group === group).reduce((sum, s) => sum + (s.sets?.length || 0), 0);
    return { group, sets };
  });
}

// Indirect ("fractional") set credit — a compound lift trains its prime
// mover directly but also loads a synergist through a smaller, submaximal
// range. Coaching frameworks (Helms/Israetel-style "fractional set
// counting") commonly credit that synergist about half a working set per
// direct set. This is a coaching heuristic, not measured dose-response
// data the way the 10–20 sets/week research range is — Target Hit never
// uses it, on purpose; it only feeds the separate Volume Sets view, so a
// starred priority muscle can't get credited toward its target just
// because a different muscle group had a good week.
//
// Scoped to primary+compound tier only — isolation work is single-joint
// by design and doesn't meaningfully load a second muscle group. A short
// per-pairing exclusion list catches specific exercises that live in the
// tier by group but don't match the movement pattern the credit assumes:
// wide-grip pulling trains lats/rear delt without much elbow flexion,
// upright rows are a pull that happens to be filed under Shoulders
// rather than a press, and Rack Pulls is a hip-hinge deadlift variant
// that landed in Rhomboids & Upper Back, not an actual row.
export const INDIRECT_CREDIT = [
  { from: "Lats", to: "Biceps", factor: 0.5,
    exclude: ["Wide-Grip Pull-Ups", "Wide-Grip Band-Assisted Pull-Up", "Wide-Grip Lat Pulldown"] },
  { from: "Rhomboids & Upper Back", to: "Biceps", factor: 0.5,
    exclude: ["Rack Pulls", "Arm-Out Single-Arm DB Row"] },
  { from: "Chest", to: "Triceps", factor: 0.5,
    exclude: [] },
  { from: "Shoulders", to: "Triceps", factor: 0.5,
    exclude: ["Dumbbell Upright Rows", "Cable Upright Rows", "Upright Row", "Cable Upright Row"] },
  { from: "Quads", to: "Hamstrings/Glutes", factor: 0.5,
    exclude: [] },
];

// Same rolling 7-day window as computeSetCoverage, but additionally
// returns indirect credit flowing in from other groups (per
// INDIRECT_CREDIT) plus a per-exercise sourcing breakdown, so the UI can
// show exactly which sessions contributed rather than a merged, opaque
// number. `direct` here always matches what computeSetCoverage reports
// for the same inputs — this is a superset, not a different calculation.
export function computeSetCoverageDetailed(workoutSessions, groups, asOfDate = null) {
  const today = asOfDate ? new Date(asOfDate + "T00:00:00") : (() => { const t = new Date(); t.setHours(0, 0, 0, 0); return t; })();
  const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() - 6);
  const cutoffStr = localDateStr(cutoff);
  const todayStr2 = localDateStr(today);
  const inWindow = (workoutSessions || []).filter(s => s.date >= cutoffStr && s.date <= todayStr2);

  return groups.map(group => {
    const direct = inWindow.filter(s => s.group === group).reduce((sum, s) => sum + (s.sets?.length || 0), 0);

    const indirectSources = [];
    let indirectRaw = 0;
    for (const rule of INDIRECT_CREDIT) {
      if (rule.to !== group) continue;
      for (const s of inWindow) {
        if (s.group !== rule.from || rule.exclude.includes(s.exercise)) continue;
        const setCount = s.sets?.length || 0;
        if (!setCount) continue;
        const credit = setCount * rule.factor;
        indirectRaw += credit;
        indirectSources.push({ exercise: s.exercise, group: rule.from, sets: setCount, factor: rule.factor, credit });
      }
    }
    const indirect = Math.round(indirectRaw * 10) / 10;
    const total = Math.round((direct + indirect) * 10) / 10;

    return { group, direct, indirect, total, indirectSources };
  });
}

// Returns the fixed session for the Nth occurrence of a day type in the
// week, or null if this day def uses the automatic rotation instead.
// Occurrences wrap: with 2 variants, a 3rd occurrence would get A again.
export function getFixedProgram(def, occurrence = 0) {
  if (!def?.programs?.length) return null;
  return def.programs[occurrence % def.programs.length];
}

export function pickExercises(group, weekNum, dayIdx, count) {
  const db = EX[group]; if (!db) return [];
  count = Math.max(1, count);
  const seed = weekNum * 997 + dayIdx * 31 + group.charCodeAt(0) * 7;

  const primary   = db.primary || [];
  const compounds = seededShuffle(db.compound || [], seed);
  const isolation = seededShuffle(db.isolation || [], seed + 13);

  // Trainer rule: one anchor lift always leads. On top of that, cap how many
  // ADDITIONAL heavy compound movements can appear — never stack 3-4
  // redundant presses/squats/hinges for one muscle in a single session.
  // Isolation work fills the remaining volume instead.
  const maxExtraCompounds = count >= 5 ? 2 : count >= 3 ? 1 : 0;

  let picked = primary.slice(0, Math.min(primary.length, count));
  const extraCompounds = compounds.slice(0, maxExtraCompounds);
  picked = [...picked, ...extraCompounds];

  const remaining = count - picked.length;
  if (remaining > 0) picked = [...picked, ...isolation.slice(0, remaining)];

  // Backfill from the compound pool if isolation options run out
  // (some groups, like biceps or lats, have very few true isolation moves).
  if (picked.length < count) {
    const used = new Set(picked);
    const more = compounds.filter(x => !used.has(x)).slice(0, count - picked.length);
    picked = [...picked, ...more];
  }

  return picked.slice(0, count);
}

/* ── Split definitions ─────────────────────────────────────────── */
//
// FIXED PROGRAMS (optional, per day type)
// ---------------------------------------
// A day def can include a `programs` array: each entry is one full
// session variant (A-day, B-day, ...) as an ordered list of
//   { ex: "Exercise Name", group: "Muscle Group", sets: 3, reps: "8-10" }
// When present, the Train tab uses these fixed sessions instead of the
// weekly exercise rotation — the 1st occurrence of that day type in the
// week gets programs[0], the 2nd gets programs[1], and so on (wrapping).
//
// TO CUSTOMIZE WITH YOUR OWN PROGRAM: just edit the entries below.
// Keep `ex` names matching the EX database above where possible so your
// logged history and progression suggestions carry across, and keep
// `group` set to one of the EX keys so the swap-exercise picker works.
// Splits without a `programs` field keep the automatic weekly rotation.
export const SPLITS = [
  {
    id: "full_body", name: "Full Body Split", difficulty: "Beginner",
    diffColor: "#7ec87e", accentColor: "#7ec87e", daysPerWeek: 3,
    tagline: "3 days / week — Mon · Wed · Fri", target: "Beginners & busy schedules",
    description: "Every session trains all major muscle groups three times a week with full rest days between. High frequency, shorter sessions, built-in 48-hour recovery.",
    strengths: ["Every muscle 3x/week","48hr recovery built in","Short sessions — easy to stick to","Best for learning compound movements"],
    weaknesses: ["Lower volume per muscle","Hard to add isolation work","Less room for specialization"],
    pattern: ["Workout","Rest","Workout","Rest","Workout","Rest","Rest"],
    defs: { Workout: { label:"Full Body", color:"#7ec87e", groups:[{n:"Chest",c:1},{n:"Lats",c:1},{n:"Shoulders",c:1},{n:"Quads",c:1},{n:"Hamstrings/Glutes",c:1},{n:"Biceps",c:1},{n:"Triceps",c:1}],
      programs: [
        [ // A — barbell-led, lower rep ranges
          { ex:"Barbell Back Squats",      group:"Quads",             sets:3, reps:"6-8"   },
          { ex:"Barbell Bench Press",      group:"Chest",             sets:3, reps:"6-8"   },
          { ex:"Barbell Rows",             group:"Lats",              sets:3, reps:"8-10"  },
          { ex:"Dumbbell Shoulder Press",  group:"Shoulders",         sets:2, reps:"10-12" },
          { ex:"Lying Leg Curls",          group:"Hamstrings/Glutes", sets:2, reps:"10-12" },
          { ex:"Barbell Bicep Curls",      group:"Biceps",            sets:2, reps:"10-12" },
          { ex:"Tricep Cable Pushdowns",   group:"Triceps",           sets:2, reps:"10-12" },
        ],
        [ // B — hinge-led, machine/dumbbell accessories
          { ex:"Romanian Deadlifts",          group:"Hamstrings/Glutes", sets:3, reps:"6-8"   },
          { ex:"Incline Dumbbell Press",      group:"Chest",             sets:3, reps:"8-10"  },
          { ex:"Lat Pulldowns",               group:"Lats",              sets:3, reps:"10-12" },
          { ex:"Leg Press",                   group:"Quads",             sets:3, reps:"10-12" },
          { ex:"Lateral Raises",              group:"Shoulders",         sets:2, reps:"12-15" },
          { ex:"Incline Dumbbell Curls",      group:"Biceps",            sets:2, reps:"10-12" },
          { ex:"Overhead Tricep Extensions",  group:"Triceps",           sets:2, reps:"10-12" },
        ],
      ],
    } }
  },
  {
    id: "upper_lower", name: "Upper / Lower", difficulty: "Lower Intermediate",
    diffColor: "#6ab0e8", accentColor: "#6ab0e8", daysPerWeek: 4,
    tagline: "4 days / week — Mon · Tue · Thu · Fri", target: "Intermediates wanting balance",
    description: "Upper and lower body sessions each trained twice a week. More volume per muscle group than full body with structured recovery and clear session focus.",
    strengths: ["Every muscle 2x/week","Clear structure","Good volume/recovery balance","Flexible scheduling"],
    weaknesses: ["Upper sessions can get long","Arms share time with everything","Lower sessions can be intense"],
    pattern: ["Upper","Lower","Rest","Upper","Lower","Rest","Rest"],
    defs: {
      Upper: { label:"Upper Body", color:"#6ab0e8", groups:[{n:"Chest",c:2},{n:"Lats",c:2},{n:"Shoulders",c:2},{n:"Biceps",c:1},{n:"Triceps",c:1}],
        programs: [
          [ // Upper A — horizontal press/row emphasis
            { ex:"Barbell Bench Press",     group:"Chest",     sets:3, reps:"6-8"   },
            { ex:"Barbell Rows",            group:"Lats",      sets:3, reps:"8-10"  },
            { ex:"Barbell Overhead Press",  group:"Shoulders", sets:3, reps:"8-10"  },
            { ex:"Lat Pulldowns",           group:"Lats",      sets:2, reps:"10-12" },
            { ex:"Barbell Bicep Curls",     group:"Biceps",    sets:2, reps:"10-12" },
            { ex:"Skull Crushers",          group:"Triceps",   sets:2, reps:"10-12" },
          ],
          [ // Upper B — vertical pull/incline emphasis
            { ex:"Incline Dumbbell Press",     group:"Chest",                  sets:3, reps:"8-10"  },
            { ex:"Pull-Ups",                   group:"Lats",                   sets:3, reps:"6-10"  },
            { ex:"Seated Cable Rows",          group:"Lats",                   sets:2, reps:"10-12" },
            { ex:"Lateral Raises",             group:"Shoulders",              sets:3, reps:"12-15" },
            { ex:"Cable Face Pulls (Rope)",    group:"Rhomboids & Upper Back", sets:2, reps:"15-20" },
            { ex:"Incline Dumbbell Curls",     group:"Biceps",                 sets:2, reps:"10-12" },
            { ex:"Overhead Tricep Extensions", group:"Triceps",                sets:2, reps:"10-12" },
          ],
        ],
      },
      Lower: { label:"Lower Body", color:"#f0a040", groups:[{n:"Quads",c:3},{n:"Hamstrings/Glutes",c:3}],
        programs: [
          [ // Lower A — squat-led
            { ex:"Barbell Back Squats",   group:"Quads",             sets:3, reps:"6-8"   },
            { ex:"Romanian Deadlifts",    group:"Hamstrings/Glutes", sets:3, reps:"8-10"  },
            { ex:"Leg Press",             group:"Quads",             sets:2, reps:"10-12" },
            { ex:"Lying Leg Curls",       group:"Hamstrings/Glutes", sets:2, reps:"10-12" },
            { ex:"Standing Calf Raises",  group:"Hamstrings/Glutes", sets:3, reps:"12-15" },
            { ex:"Weighted Ab Crunches",  group:"Abs & Core",        sets:2, reps:"10-15" },
          ],
          [ // Lower B — hinge-led
            { ex:"Conventional Deadlifts",   group:"Hamstrings/Glutes", sets:3, reps:"5-6"   },
            { ex:"Hack Squats",              group:"Quads",             sets:3, reps:"8-10"  },
            { ex:"Bulgarian Split Squats",   group:"Quads",             sets:2, reps:"10-12" },
            { ex:"Seated Leg Curls",         group:"Hamstrings/Glutes", sets:2, reps:"12-15" },
            { ex:"Seated Calf Raises",       group:"Hamstrings/Glutes", sets:3, reps:"15-20" },
            { ex:"Hanging Leg Raises",       group:"Abs & Core",        sets:2, reps:"10-15" },
          ],
        ],
      }
    }
  },
  {
    id: "ppl", name: "Push / Pull / Legs", difficulty: "Advanced Intermediate",
    diffColor: "#f0a040", accentColor: "#ff6b3d", daysPerWeek: 6,
    tagline: "6 days / week — each group hit twice", target: "Intermediate to advanced hypertrophy",
    description: "Muscles grouped by movement mechanics. Push, pull, and legs each trained twice per week on a 6-day schedule for maximum hypertrophy.",
    strengths: ["Synergistic groupings","Each group 2x/week on 6-day","High volume potential","Most popular hypertrophy split"],
    weaknesses: ["6 days is demanding","Shoulders taxed indirectly on pull day","Less arm isolation"],
    pattern: ["Push","Pull","Legs","Push","Pull","Legs","Rest"],
    defs: {
      Push: { label:"Push — Chest · Shoulders · Triceps", color:"#ff6b3d", groups:[{n:"Chest",c:3},{n:"Shoulders",c:3},{n:"Triceps",c:2}],
        programs: [
          [ // Push A — chest-led
            { ex:"Barbell Bench Press",     group:"Chest",     sets:3, reps:"6-8"   },
            { ex:"Seated Dumbbell Press",   group:"Shoulders", sets:3, reps:"8-10"  },
            { ex:"Incline Dumbbell Press",  group:"Chest",     sets:3, reps:"10-12" },
            { ex:"Lateral Raises",          group:"Shoulders", sets:3, reps:"12-15" },
            { ex:"Skull Crushers",          group:"Triceps",   sets:3, reps:"10-12" },
            { ex:"Tricep Cable Pushdowns",  group:"Triceps",   sets:2, reps:"12-15" },
          ],
          [ // Push B — shoulder-led
            { ex:"Barbell Overhead Press",     group:"Shoulders", sets:3, reps:"6-8"   },
            { ex:"Incline Barbell Press",      group:"Chest",     sets:3, reps:"8-10"  },
            { ex:"Dips",                       group:"Chest",     sets:3, reps:"8-12"  },
            { ex:"Cable Lateral Raises",       group:"Shoulders", sets:3, reps:"12-15" },
            { ex:"Overhead Tricep Extensions", group:"Triceps",   sets:3, reps:"10-12" },
            { ex:"Pec Deck Flyes",             group:"Chest",     sets:2, reps:"12-15" },
          ],
        ],
      },
      Pull: { label:"Pull — Back · Biceps", color:"#6ab0e8", groups:[{n:"Lats",c:3},{n:"Rhomboids & Upper Back",c:2},{n:"Biceps",c:2}],
        programs: [
          [ // Pull A — vertical-pull-led
            { ex:"Pull-Ups",                group:"Lats",                   sets:3, reps:"6-10"  },
            { ex:"Barbell Rows",            group:"Lats",                   sets:3, reps:"8-10"  },
            { ex:"Seated Cable Rows",       group:"Lats",                   sets:2, reps:"10-12" },
            { ex:"Cable Face Pulls (Rope)", group:"Rhomboids & Upper Back", sets:3, reps:"15-20" },
            { ex:"Barbell Bicep Curls",     group:"Biceps",                 sets:3, reps:"8-12"  },
            { ex:"Dumbbell Hammer Curls",   group:"Biceps",                 sets:2, reps:"10-12" },
          ],
          [ // Pull B — row-led
            { ex:"Lat Pulldowns",                  group:"Lats",                   sets:3, reps:"8-10"  },
            { ex:"T-Bar Rows",                     group:"Rhomboids & Upper Back", sets:3, reps:"8-10"  },
            { ex:"Chest-Supported Dumbbell Rows",  group:"Rhomboids & Upper Back", sets:2, reps:"10-12" },
            { ex:"Reverse Pec Deck",               group:"Shoulders",              sets:3, reps:"12-15" },
            { ex:"Incline Dumbbell Curls",         group:"Biceps",                 sets:3, reps:"10-12" },
            { ex:"Preacher Curls",                 group:"Biceps",                 sets:2, reps:"12-15" },
          ],
        ],
      },
      Legs: { label:"Legs", color:"#f0a040", groups:[{n:"Quads",c:3},{n:"Hamstrings/Glutes",c:3}],
        programs: [
          [ // Legs A — squat-led
            { ex:"Barbell Back Squats",  group:"Quads",             sets:3, reps:"6-8"   },
            { ex:"Romanian Deadlifts",   group:"Hamstrings/Glutes", sets:3, reps:"8-10"  },
            { ex:"Leg Press",            group:"Quads",             sets:3, reps:"10-12" },
            { ex:"Lying Leg Curls",      group:"Hamstrings/Glutes", sets:3, reps:"10-12" },
            { ex:"Standing Calf Raises", group:"Hamstrings/Glutes", sets:4, reps:"12-15" },
            { ex:"Leg Extensions",       group:"Quads",             sets:2, reps:"12-15" },
          ],
          [ // Legs B — hinge-led
            { ex:"Conventional Deadlifts", group:"Hamstrings/Glutes", sets:3, reps:"5-6"   },
            { ex:"Hack Squats",            group:"Quads",             sets:3, reps:"8-10"  },
            { ex:"Bulgarian Split Squats", group:"Quads",             sets:2, reps:"10-12" },
            { ex:"Seated Leg Curls",       group:"Hamstrings/Glutes", sets:3, reps:"12-15" },
            { ex:"Seated Calf Raises",     group:"Hamstrings/Glutes", sets:4, reps:"15-20" },
            { ex:"Hanging Leg Raises",     group:"Abs & Core",        sets:2, reps:"10-15" },
          ],
        ],
      }
    }
  },
  {
    id: "arnold", name: "Arnold Split", difficulty: "Advanced",
    diffColor: "#e87070", accentColor: "#f0c040", daysPerWeek: 6,
    tagline: "6 days / week — Arnold's 3-day cycle × 2", target: "Advanced bodybuilders focused on aesthetics",
    description: "Chest with back for antagonist pump, dedicated shoulder & arm day, brutal leg session. Repeat twice a week. Battle-tested by one of the greatest physiques ever.",
    strengths: ["Antagonist pump","Dedicated arm day","Each group 2x/week","Battle-tested"],
    weaknesses: ["Chest+back days are exhausting","Demands exceptional recovery","High volume for naturals"],
    pattern: ["Chest & Back","Shoulders & Arms","Legs","Chest & Back","Shoulders & Arms","Legs","Rest"],
    defs: {
      "Chest & Back":    { label:"Chest & Back",    color:"#f0c040", groups:[{n:"Chest",c:3},{n:"Lats",c:3},{n:"Rhomboids & Upper Back",c:2}] },
      "Shoulders & Arms":{ label:"Shoulders & Arms",color:"#f0a040", groups:[{n:"Shoulders",c:3},{n:"Biceps",c:3},{n:"Triceps",c:3}] },
      Legs:              { label:"Legs",             color:"#7ec87e", groups:[{n:"Quads",c:3},{n:"Hamstrings/Glutes",c:3}] }
    }
  },
  {
    id: "bro", name: "The Bro Split", difficulty: "Advanced",
    diffColor: "#e87070", accentColor: "#e87070", daysPerWeek: 5,
    tagline: "5 days / week — one muscle group, all out", target: "Advanced bodybuilders, max volume per muscle",
    description: "One major muscle group per day, trained to complete exhaustion. Max volume and isolation. Works best for advanced lifters who need extreme stimulus to grow.",
    strengths: ["Max volume per session","Total isolation","Simple structure","Great for advanced lifters"],
    weaknesses: ["Each muscle 1x/week only","Miss a day = full week gap","Science favors 2x/week","5 consecutive days"],
    pattern: ["Chest","Back","Shoulders","Legs","Arms","Rest","Rest"],
    defs: {
      Chest:    { label:"Chest Day",    color:"#e87070", groups:[{n:"Chest",c:5}] },
      Back:     { label:"Back Day",     color:"#6ab0e8", groups:[{n:"Lats",c:4},{n:"Rhomboids & Upper Back",c:3}] },
      Shoulders:{ label:"Shoulder Day", color:"#f0a040", groups:[{n:"Shoulders",c:5}] },
      Legs:     { label:"Leg Day",      color:"#7ec87e", groups:[{n:"Quads",c:4},{n:"Hamstrings/Glutes",c:3}] },
      Arms:     { label:"Arm Day",      color:"#9b7ff0", groups:[{n:"Biceps",c:4},{n:"Triceps",c:4}] }
    }
  },
  {
    id: "push_pull", name: "Push / Pull Split", difficulty: "Advanced Intermediate",
    diffColor: "#f0a040", accentColor: "#9b7ff0", daysPerWeek: 4,
    tagline: "4 days / week — legs folded in", target: "Intermediates who want 2x/week in 4 days",
    description: "Push and pull days that integrate leg work, eliminating a standalone leg day. Every muscle trained twice a week in only 4 sessions.",
    strengths: ["2x/week in just 4 days","No standalone leg day","Synergistic pairings","Results without 6-day commitment"],
    weaknesses: ["Long sessions","Less volume than 6-day","Leg fatigue bleeds into upper work"],
    pattern: ["Push","Pull","Rest","Push","Pull","Rest","Rest"],
    defs: {
      Push: { label:"Push — Chest · Shoulders · Triceps · Quads", color:"#9b7ff0", groups:[{n:"Chest",c:2},{n:"Shoulders",c:2},{n:"Triceps",c:2},{n:"Quads",c:2}] },
      Pull: { label:"Pull — Back · Biceps · Hamstrings · Glutes", color:"#40c8b0", groups:[{n:"Lats",c:2},{n:"Rhomboids & Upper Back",c:1},{n:"Biceps",c:2},{n:"Hamstrings/Glutes",c:2}] }
    }
  },
  {
    id: "antagonist", name: "Antagonistic Split", difficulty: "Advanced Intermediate",
    diffColor: "#f0a040", accentColor: "#40c8b0", daysPerWeek: 4,
    tagline: "4 on / 1 off cycle — superset friendly", target: "Lifters who want faster, superset-driven sessions",
    description: "Pair opposing muscle groups for natural supersets and an incredible pump. Runs on a rolling 4-on-1-off cycle.",
    strengths: ["Supersets cut session time","Incredible antagonist pump","Each muscle 2x in 8-day cycle","Time-efficient"],
    weaknesses: ["8-day cycle misaligns with weekly schedule","Requires antagonist knowledge","Less total volume"],
    pattern: ["Chest & Back","Legs & Abs","Arms & Shoulders","Rest","Chest & Back","Legs & Abs","Arms & Shoulders"],
    defs: {
      "Chest & Back":    { label:"Chest & Back (Antagonists)", color:"#40c8b0", groups:[{n:"Chest",c:3},{n:"Lats",c:3},{n:"Rhomboids & Upper Back",c:2}] },
      "Legs & Abs":      { label:"Legs & Abs",                color:"#7ec87e", groups:[{n:"Quads",c:2},{n:"Hamstrings/Glutes",c:2},{n:"Abs & Core",c:2}] },
      "Arms & Shoulders":{ label:"Arms & Shoulders",           color:"#f0a040", groups:[{n:"Biceps",c:3},{n:"Triceps",c:3},{n:"Shoulders",c:2}] }
    }
  },
  {
    id: "phraks", name: "Upper/Lower/Arms — Phraks", difficulty: "Advanced Intermediate",
    diffColor: "#f0a040", accentColor: "#f0a040", daysPerWeek: 5,
    tagline: "5-6 days / week — heavy · hypertrophy · arms", target: "Upper/Lower veterans whose arms are lagging",
    description: "Expands Upper/Lower with periodization (heavy and hypertrophy days) plus a dedicated arm day to bring up a weak point.",
    strengths: ["Built-in periodization","Dedicated arm day","Compound-first strength base","Arms specialization with frequency"],
    weaknesses: ["5-6 days commitment","Shoulder accumulation fatigue","More complex programming"],
    pattern: ["Upper (Heavy)","Lower (Heavy)","Rest","Upper (Hypertrophy)","Lower (Hypertrophy)","Arms & Shoulders","Rest"],
    defs: {
      "Upper (Heavy)":       { label:"Upper — Heavy",             color:"#f0a040", groups:[{n:"Chest",c:2},{n:"Lats",c:2},{n:"Rhomboids & Upper Back",c:1},{n:"Shoulders",c:1}] },
      "Lower (Heavy)":       { label:"Lower — Heavy",             color:"#e87070", groups:[{n:"Quads",c:3},{n:"Hamstrings/Glutes",c:3}] },
      "Upper (Hypertrophy)": { label:"Upper — Hypertrophy",       color:"#f0a040", groups:[{n:"Chest",c:2},{n:"Lats",c:2},{n:"Shoulders",c:2}] },
      "Lower (Hypertrophy)": { label:"Lower — Hypertrophy",       color:"#e87070", groups:[{n:"Quads",c:3},{n:"Hamstrings/Glutes",c:3}] },
      "Arms & Shoulders":    { label:"Arms & Shoulders Isolation", color:"#9b7ff0", groups:[{n:"Biceps",c:3},{n:"Triceps",c:3},{n:"Shoulders",c:2}] }
    }
  },
  {
    id: "womens_core_legs",
    name: "Core & Legs Focus",
    difficulty: "Lower Intermediate",
    diffColor: "#c084fc",
    accentColor: "#c084fc",
    daysPerWeek: 4,
    tagline: "4 days / week — legs twice, push & pull woven in",
    target: "Women focused on glutes, legs, and core with upper body balance",
    description: "Built around leg and glute development as the primary goal, with core work woven into every upper session. Trains legs twice a week for maximum lower body growth — one strength day and one hypertrophy day. Push and pull are kept separate and balanced to build upper body without overdoing it.",
    strengths: [
      "Legs & glutes hit twice per week — highest-return frequency for lower body growth",
      "Core trained every upper session rather than as an afterthought",
      "Push/pull separation protects shoulder joint health",
      "Heavy and hypertrophy leg days provide built-in periodization",
    ],
    weaknesses: [
      "Arms get less isolated work than a dedicated arm day",
      "Twice-weekly leg sessions demand good sleep and nutrition to recover",
      "Less total chest and shoulder volume than a full PPL",
    ],
    pattern: ["Legs (Heavy)", "Push + Core", "Rest", "Legs (Hypertrophy)", "Pull + Core", "Rest", "Rest"],
    defs: {
      "Legs (Heavy)":       { label: "Legs & Glutes — Strength", color: "#c084fc", groups: [{ n: "Quads", c: 3 }, { n: "Hamstrings/Glutes", c: 3 }] },
      "Push + Core":        { label: "Push + Core",               color: "#ff6b3d", groups: [{ n: "Chest", c: 2 }, { n: "Shoulders", c: 2 }, { n: "Triceps", c: 1 }, { n: "Abs & Core", c: 2 }] },
      "Legs (Hypertrophy)": { label: "Legs & Glutes — Volume",   color: "#c084fc", groups: [{ n: "Quads", c: 2 }, { n: "Hamstrings/Glutes", c: 4 }] },
      "Pull + Core":        { label: "Pull + Core",               color: "#6ab0e8", groups: [{ n: "Lats", c: 2 }, { n: "Rhomboids & Upper Back", c: 1 }, { n: "Biceps", c: 2 }, { n: "Abs & Core", c: 2 }] },
    }
  },
  {
    id: "calisthenics_3",
    name: "Calisthenics PPL — 3-Day",
    difficulty: "Lower Intermediate",
    diffColor: "#34d399",
    accentColor: "#34d399",
    daysPerWeek: 3,
    tagline: "3 days / week — push · pull · legs, no equipment needed",
    target: "Anyone training at home or building their first pull-up and dip",
    description: "Push, pull, and legs each trained once per week with full rest days in between. Every exercise is bodyweight — no barbell, no cables, no gym required. Sessions are built around a skill progression ladder so you're always working toward a harder variation, not just adding reps forever. Perfect for beginners or anyone returning to training.",
    strengths: [
      "Zero equipment needed — train anywhere",
      "Full rest between every session — low injury risk",
      "Skill progressions keep training challenging long-term",
      "Easy to build the habit with just 3 days",
    ],
    weaknesses: [
      "Each muscle group only once per week — slower than 6-day",
      "Lower body progress can plateau without added resistance",
      "Less total weekly volume than weighted splits",
    ],
    pattern: ["Bodyweight Push", "Rest", "Bodyweight Pull", "Rest", "Bodyweight Legs", "Rest", "Rest"],
    defs: {
      "Bodyweight Push": { label: "Push — chest, shoulders, triceps", color: "#34d399", groups: [{ n: "Bodyweight Push", c: 4 }, { n: "Bodyweight Core", c: 1 }] },
      "Bodyweight Pull": { label: "Pull — back, biceps",              color: "#60a5fa", groups: [{ n: "Bodyweight Pull", c: 4 }, { n: "Bodyweight Core", c: 1 }] },
      "Bodyweight Legs": { label: "Legs — quads, glutes, hamstrings", color: "#fbbf24", groups: [{ n: "Bodyweight Legs", c: 4 }, { n: "Bodyweight Core", c: 1 }] },
    }
  },
  {
    id: "calisthenics_6",
    name: "Calisthenics PPL — 6-Day",
    difficulty: "Advanced Intermediate",
    diffColor: "#f0a040",
    accentColor: "#34d399",
    daysPerWeek: 6,
    tagline: "6 days / week — each group twice, skill progressions built in",
    target: "Intermediate bodyweight athletes chasing muscle and skill milestones",
    description: "Push, pull, and legs each hit twice per week for maximum hypertrophy and faster skill development. The second rotation of each session draws from a wider exercise pool to vary the stimulus and prevent stagnation. As weeks progress the schedule automatically surfaces harder variations — by week 8-12 you should be working toward archer pull-ups, pseudo planche push-ups, and pistol squat progressions.",
    strengths: [
      "Every muscle group twice per week — optimal frequency",
      "Skills develop faster with higher practice frequency",
      "Second session per pattern adds volume and variety",
      "Still zero equipment — full gym results, no gym needed",
    ],
    weaknesses: [
      "6 days demands excellent sleep and recovery",
      "Not suitable for beginners still building base strength",
      "Can accumulate fatigue — deload weeks recommended every 4-6 weeks",
    ],
    pattern: ["Bodyweight Push", "Bodyweight Pull", "Bodyweight Legs", "Bodyweight Push", "Bodyweight Pull", "Bodyweight Legs", "Rest"],
    defs: {
      "Bodyweight Push": { label: "Push — chest, shoulders, triceps", color: "#34d399", groups: [{ n: "Bodyweight Push", c: 5 }, { n: "Bodyweight Core", c: 1 }] },
      "Bodyweight Pull": { label: "Pull — back, biceps",              color: "#60a5fa", groups: [{ n: "Bodyweight Pull", c: 5 }, { n: "Bodyweight Core", c: 1 }] },
      "Bodyweight Legs": { label: "Legs — quads, glutes, hamstrings", color: "#fbbf24", groups: [{ n: "Bodyweight Legs", c: 4 }, { n: "Bodyweight Core", c: 1 }] },
    }
  },
  {
    id: "ppl_weak_day",
    name: "PPL + Weak Point Day",
    difficulty: "Advanced Intermediate",
    diffColor: "#f0a040",
    accentColor: "#22d3ee",
    daysPerWeek: 4,
    tagline: "4 days on, 1 day off — repeating cycle, not locked to the week",
    target: "Intermediate/advanced lifters who want to specialize a lagging body part without going 6-day PPL",
    description: "A standard Push/Pull/Legs rotation with a fourth training day added before the rest day — a dedicated Weak Point session that revisits shoulders, arms, and abs with extra isolation volume. The whole thing runs on a rolling 5-day cycle (train 4, rest 1, repeat) rather than resetting every Monday, so rest always falls exactly one day after your 4th session no matter what day of the week you started.",
    strengths: [
      "Extra frequency on commonly lagging areas (delts, arms, abs) without a full 6-day commitment",
      "Rest always comes after exactly 4 sessions — predictable recovery spacing",
      "Standard Push/Pull/Legs volume stays intact; Weak Day is added on top, not instead of",
      "Easy to redirect — swap which muscles get emphasis on Weak Day as your weak points change",
    ],
    weaknesses: [
      "Because the cycle is 5 days long, training days drift across the calendar week over time (Push might land on a Monday one week, a Wednesday the next)",
      "Shoulders/biceps/triceps get hit on both their main day and Weak Day — good for growth, but recovery for those smaller muscles needs monitoring",
      "Only helps if your weak point is upper-body/abs; legs and back don't get a bonus day in this version",
    ],
    pattern: ["Push", "Pull", "Legs", "Weak Day", "Rest", "Push", "Pull"],
    defs: {
      Push:      { label: "Push — Chest · Shoulders · Triceps", color: "#22d3ee", groups: [{ n: "Chest", c: 3 }, { n: "Shoulders", c: 3 }, { n: "Triceps", c: 2 }] },
      Pull:      { label: "Pull — Back · Biceps",               color: "#6ab0e8", groups: [{ n: "Lats", c: 3 }, { n: "Rhomboids & Upper Back", c: 2 }, { n: "Biceps", c: 2 }] },
      Legs:      { label: "Legs",                                color: "#f0a040", groups: [{ n: "Quads", c: 3 }, { n: "Hamstrings/Glutes", c: 3 }] },
      "Weak Day":{ label: "Weak Point — Shoulders · Arms · Abs", color: "#fb7185", groups: [{ n: "Shoulders", c: 2 }, { n: "Biceps", c: 1 }, { n: "Triceps", c: 1 }, { n: "Abs & Core", c: 2 }] },
    }
  }
];

/* ── Weak Point Day customization ─────────────────────────────────
   Exclusive to the "ppl_weak_day" split — lets the user pick which
   muscle group(s) their 4th session specializes in, instead of the
   fixed Shoulders/Biceps/Triceps/Abs default. */

export const WEAK_POINT_OPTIONS = [
  { key: "Chest",             label: "Chest",              groups: ["Chest"] },
  { key: "Back",              label: "Back",               groups: ["Lats", "Rhomboids & Upper Back"] },
  { key: "Shoulders",         label: "Shoulders",          groups: ["Shoulders"] },
  { key: "Biceps",            label: "Biceps",             groups: ["Biceps"] },
  { key: "Triceps",           label: "Triceps",            groups: ["Triceps"] },
  { key: "Quads",             label: "Quads",              groups: ["Quads"] },
  { key: "Hamstrings/Glutes", label: "Hamstrings & Glutes",groups: ["Hamstrings/Glutes"] },
  { key: "Abs & Core",        label: "Abs & Core",         groups: ["Abs & Core"] },
];

export const WEAK_POINT_MAX_PICKS = 3;
const WEAK_DAY_TOTAL_SLOTS = 6;
const DEFAULT_WEAK_DAY = {
  groups: [{ n: "Shoulders", c: 2 }, { n: "Biceps", c: 1 }, { n: "Triceps", c: 1 }, { n: "Abs & Core", c: 2 }],
  label: "Weak Point — Shoulders · Arms · Abs",
};

// Turns a list of WEAK_POINT_OPTIONS keys into a real { groups, label }
// def for the Weak Day session, spreading a fixed exercise budget evenly
// across whichever real EX groups the choice(s) expand to. Falls back to
// the original Shoulders/Arms/Abs combo if nothing has been picked yet.
export function buildWeakDayGroups(selectedKeys) {
  if (!selectedKeys || selectedKeys.length === 0) return DEFAULT_WEAK_DAY;

  const realGroups = [];
  selectedKeys.forEach(key => {
    const opt = WEAK_POINT_OPTIONS.find(o => o.key === key);
    if (opt) realGroups.push(...opt.groups);
  });
  const uniqueGroups = [...new Set(realGroups)];
  if (uniqueGroups.length === 0) return DEFAULT_WEAK_DAY;

  const base  = Math.floor(WEAK_DAY_TOTAL_SLOTS / uniqueGroups.length);
  const extra = WEAK_DAY_TOTAL_SLOTS % uniqueGroups.length;
  const groups = uniqueGroups
    .map((n, i) => ({ n, c: base + (i < extra ? 1 : 0) }))
    .filter(g => g.c > 0);

  const labelNames = selectedKeys.map(k => WEAK_POINT_OPTIONS.find(o => o.key === k)?.label || k);
  return { groups, label: `Weak Point — ${labelNames.join(" + ")}` };
}


// Formats a Date as YYYY-MM-DD using LOCAL date components, not UTC —
// toISOString() converts to UTC first, which rolls the date over early
// for anyone west of UTC (e.g. at 10pm EST, UTC is already the next day).
function localDateStr(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Returns { pct, actual, expected, grade, emoji, color, msg } or null.
// Looks at the last 28 days of workout_sessions vs. what the split required.
export function calcAttendanceGrade(splitId, workoutSessions, splitStartedOn) {
  const split = SPLITS.find(s => s.id === splitId);
  if (!split || !workoutSessions || workoutSessions.length === 0) return null;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const trailingStart = new Date(today); trailingStart.setDate(trailingStart.getDate() - 27);
  // Grading only what's actually happened under THIS split — clip the
  // window to whichever is later: the usual 28-day lookback, or the day
  // this split was locked in. Without this, switching splits makes the
  // grade unfairly harsh for weeks: it'd expect ~20 workout days under
  // the new split when only a couple have actually happened yet.
  const splitStart = splitStartedOn ? new Date(splitStartedOn + "T00:00:00") : null;
  const start = splitStart && splitStart > trailingStart ? splitStart : trailingStart;
  const startStr = localDateStr(start);

  const sessionDates = new Set(
    workoutSessions.filter(s => s.date >= startStr && s.splitId === splitId).map(s => s.date)
  );

  let expected = 0, actual = 0;
  const d = new Date(start);
  while (d <= today) {
    const pi = (d.getDay() + 6) % 7; // Mon=0
    const ds = localDateStr(d);
    const scheduledTraining = split.pattern[pi] !== "Rest";
    const trained = sessionDates.has(ds);
    // A logged session always counts as a training day, even on a
    // calendar Rest day — that's exactly what the Optional Day (4th
    // schedule slot) is for: choosing to train on a day the rotation
    // didn't originally assign. Previously, actual++ only ran inside the
    // "scheduled training" branch, so an Optional Day workout logged on
    // a Rest day was invisible to both counts — it didn't help the grade
    // at all, which felt like the day just didn't register anywhere.
    // Counting it as both expected and actual together means it can't
    // artificially inflate the percentage past 100% for that day either
    // — it's treated as one more day you chose to train, and you hit it.
    if (scheduledTraining || trained) {
      expected++;
      if (trained) actual++;
    }
    d.setDate(d.getDate() + 1);
  }
  if (expected === 0) return null;


  const pct = Math.round((actual / expected) * 100);
  const tiers = [
    { min: 90, grade: "A+", emoji: "🔥", color: "#2BE6A8", msg: "On Track — Outstanding consistency!" },
    { min: 80, grade: "A",  emoji: "💪", color: "#2BE6A8", msg: "Great Work — Barely missing a beat." },
    { min: 70, grade: "B",  emoji: "👍", color: "#4FADFF", msg: "Solid Effort — Stay the course." },
    { min: 60, grade: "C",  emoji: "⚡", color: "#8B93C9", msg: "Room to Improve — Push for more." },
    { min: 0,  grade: "D",  emoji: "🎯", color: "#FF7A85", msg: "Let's Get Back On Track — You've got this." },
  ];
  const tier = tiers.find(t => pct >= t.min);
  return { pct, actual, expected, ...tier };
}

// Split-agnostic version — counts ANY day with a logged session,
// regardless of which split it was under. This exists specifically for
// the moment right after switching splits: calcAttendanceGrade (correctly)
// only counts sessions under the *current* split, so it can show "D, 0%"
// for someone who's actually been training consistently under a
// different split until yesterday. This is the other half of that
// picture — "have you actually been working out," independent of switches.
//
// Thresholds are day-counts over the window, not a percentage of every
// calendar day — nobody trains 7 days a week, so grading against "30/30"
// would make even excellent consistency look mediocre. ~4x/week over a
// 30-day window lands around 17 sessions, which is where "A" starts.
export function calcRawAttendanceGrade(workoutSessions, windowDays = 30) {
  if (!workoutSessions || workoutSessions.length === 0) return null;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(today); start.setDate(start.getDate() - (windowDays - 1));
  const startStr = localDateStr(start);

  const sessionDates = new Set(
    workoutSessions.filter(s => s.date >= startStr).map(s => s.date)
  );
  const actual = sessionDates.size;

  const tiers = [
    { min: 22, grade: "A+", emoji: "🔥", color: "#2BE6A8", msg: "Outstanding consistency!" },
    { min: 15, grade: "A",  emoji: "💪", color: "#2BE6A8", msg: "Great work — staying consistent." },
    { min: 10, grade: "B",  emoji: "👍", color: "#4FADFF", msg: "Solid effort — keep it up." },
    { min: 5,  grade: "C",  emoji: "⚡", color: "#8B93C9", msg: "Room to improve — push for more." },
    { min: 0,  grade: "D",  emoji: "🎯", color: "#FF7A85", msg: "Let's get back on track — you've got this." },
  ];
  const tier = tiers.find(t => actual >= t.min);
  return { actual, windowDays, ...tier };
}

/* ── Double progression + deload engine ──────────────────────────
   Given a lift's full session history, recommends what to do next:
   add a rep, add weight and reset reps, or — if stalled at the same
   weight for 3 sessions running without hitting the top of the rep
   range — deload ~10% and rebuild. Only triggers once at least 3
   sets are on record for the most recent session; an exercise with
   no history (or fewer than 3 logged sets) gets no suggestion. */

const REP_RANGES = {
  // Heavy compounds — lower, strength-biased ranges
  "Barbell Back Squats": [4, 6], "Barbell Front Squats": [4, 6],
  "Conventional Deadlifts": [3, 5], "Sumo Deadlifts": [3, 5], "Trap Bar Deadlifts": [3, 5],
  "Romanian Deadlifts": [5, 8], "Barbell Bench Press": [5, 8], "Barbell Overhead Press": [5, 8],
};

function getRepRange(exercise, group) {
  if (REP_RANGES[exercise]) return REP_RANGES[exercise];
  const isIsolation = ["Biceps", "Triceps", "Abs & Core"].includes(group) ||
    /Curl|Extension|Raise|Fly|Kickback|Crunch|Pushdown/i.test(exercise || "");
  if (isIsolation) return [10, 15];
  return [6, 10];
}

function relativeDay(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const now = new Date(); now.setHours(0, 0, 0, 0);
  const diff = Math.round((now - d) / 86400000);
  if (diff <= 0) return "today";
  if (diff === 1) return "yesterday";
  if (diff < 7) return `${diff} days ago`;
  if (diff < 14) return "1 week ago";
  if (diff < 30) return `${Math.floor(diff / 7)} weeks ago`;
  return `${Math.floor(diff / 30)} months ago`;
}

// exerciseSessions: all sessions for one exercise, [{date, sets:[{weight,reps}]}, ...]
// dismissedAtCount: if the user dismissed a deload suggestion, the session
// count at that time — the dismissal auto-expires once a new session is
// logged (session count grows past it), so it never nags forever.
export function getProgressionSuggestion(exerciseSessions, group, exerciseName, dismissedAtCount = null) {
  if (!exerciseSessions?.length) return null;
  // date alone can't distinguish two sessions of the same exercise
  // logged on the same calendar day — createdAt (when available) breaks
  // the tie in real chronological order instead of leaving it to
  // whatever order the sessions happened to arrive in.
  const sorted = [...exerciseSessions].sort((a, b) =>
    a.date.localeCompare(b.date) || (a.createdAt || "").localeCompare(b.createdAt || "")
  );
  const last = sorted[sorted.length - 1];
  const filled = (last.sets || []).filter(s => parseFloat(s.weight) > 0 && parseInt(s.reps) > 0);
  if (filled.length < 3) return null; // need at least 3 logged sets to suggest anything

  const range = getRepRange(exerciseName, group);
  const weight = parseFloat(filled[0].weight) || 0;
  if (!weight) return null;
  const minReps = Math.min(...filled.map(s => parseInt(s.reps) || 0));
  const allAtTop = filled.every(s => (parseInt(s.reps) || 0) >= range[1]);

  const isLower     = ["Quads", "Hamstrings/Glutes"].includes(group);
  const isIsolation = ["Biceps", "Triceps", "Abs & Core"].includes(group);
  const increment   = isLower ? 5 : isIsolation ? 1.25 : 2.5;
  const ago = relativeDay(last.date);

  const dismissActive = dismissedAtCount != null && sorted.length <= dismissedAtCount;
  if (!dismissActive && sorted.length >= 3) {
    const recent = sorted.slice(-3);
    const stalled = recent.every(sess => {
      const f = (sess.sets || []).filter(s => parseFloat(s.weight) > 0 && parseInt(s.reps) > 0);
      if (f.length < 3) return false;
      const w = parseFloat(f[0].weight) || 0;
      const hitTop = f.every(s => (parseInt(s.reps) || 0) >= range[1]);
      return w === weight && !hitTop;
    });
    if (stalled) {
      const deloadWeight = Math.round((weight * 0.9) / 2.5) * 2.5;
      return {
        type: "deload",
        suggestedWeight: deloadWeight,
        targetReps: range[0],
        ago, lastWeight: weight, lastReps: minReps,
        sessionCount: sorted.length,
        msg: `Stalled at ${weight} lbs for 3 sessions in a row — deload to ${deloadWeight} lbs and build back up.`,
      };
    }
  }

  if (allAtTop) {
    return {
      type: "increase",
      suggestedWeight: weight + increment,
      targetReps: range[0],
      ago, lastWeight: weight, lastReps: minReps,
      sessionCount: sorted.length,
      msg: `Hit ${range[1]} reps on all sets ${ago} — add ${increment} lbs, back to ${range[0]} reps.`,
    };
  }
  const nextReps = Math.min(range[1], minReps + 1);
  return {
    type: "hold",
    suggestedWeight: weight,
    targetReps: nextReps,
    ago, lastWeight: weight, lastReps: minReps,
    sessionCount: sorted.length,
    msg: `Same weight — aim for ${nextReps} reps per set (last: ${filled.map(s => s.reps).join("/")}, ${ago}).`,
  };
}

// Small, pure helpers shared between SplitDashboard's solo flow and the
// group-training board — kept here instead of importing from
// SplitDashboard.jsx (a default-exported component, not a utils
// module) or duplicating the logic a second time with its own drift
// risk. Mirrors SplitDashboard's own BODYWEIGHT_LOADED_EXERCISES /
// isAssistedBodyweight / defaultWeightFor exactly; if one changes, the
// other should too.

export const BODYWEIGHT_LOADED_EXERCISES = new Set([
  "Weighted Pull-Up", "Weighted Pull-Ups",
  "Chin-Ups", "Wide-Grip Pull-Ups", "Wide-Grip Pull-Up",
  "Neutral-Grip Pull-Up", "Neutral-Grip Pullup", "Medium-Grip Pull-Up",
  "Commando Pull-Ups", "Archer Pull-Ups", "Australian Pull-Ups", "L-Sit Pull-Ups",
  "Assisted Pull-Up", "Wide-Grip Band-Assisted Pull-Up",
  "Bench Dip", "Bench Dips", "Bodyweight Dip", "Chest Dips", "Dips",
  "Close-Grip Assisted Dip", "Paused Assisted Dip",
]);

export function isAssistedBodyweight(name) {
  return /assisted/i.test(name || "") && (/pull-?up/i.test(name || "") || /dip/i.test(name || ""));
}

// Same priority SplitDashboard's own defaultWeightFor uses: a real
// progression suggestion always wins; otherwise bodyweight-loaded
// lifts default to that PERSON's own latest logged weight; otherwise
// blank. Takes latestWeight explicitly (not from a closure) since this
// runs once per person, per exercise, in the group board.
export function defaultWeightForPerson(exerciseName, sugg, latestWeight) {
  if (sugg) return String(sugg.suggestedWeight);
  if (BODYWEIGHT_LOADED_EXERCISES.has(exerciseName) && !isAssistedBodyweight(exerciseName) && latestWeight) {
    return String(latestWeight);
  }
  return "";
}

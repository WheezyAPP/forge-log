import { useState, useEffect, useMemo, useRef } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  BarChart,
  ComposedChart,
  Bar,
  Cell,
  ReferenceLine,
} from "recharts";
import {
  Flame,
  Dumbbell,
  Settings as SettingsIcon,
  Plus,
  Trash2,
  TrendingDown,
  TrendingUp,
  Gauge,
  CalendarDays,
  Droplet,
  LogOut,
  Ruler,
  Pencil,
  Check,
  X,
  UtensilsCrossed,
  ExternalLink,
  CalendarCheck,
  Award,
  Scale,
  Clock,
  Home,
  ChevronRight,
  ChevronDown,
  Target,
  Star,
  BookmarkPlus,
  Users,
  Download,
  Upload,
  Trophy,
  Info,
  ClipboardCheck,
  Layers,
  Copy,
  AlertCircle,
} from "lucide-react";
import UserSelect from "./components/UserSelect";
import SplitDashboard from "./components/SplitDashboard";
import PartnerTraining from "./components/PartnerTraining";
import FoodSearch from "./components/FoodSearch";
import ToastStack from "./components/ToastStack";
import { calcAttendanceGrade, calcRawAttendanceGrade, getProgressionSuggestion, SPLITS, ANATOMICAL_GROUPS, computeSetCoverage, computeSetCoverageDetailed } from "./lib/splits";
import {
  loadProfile,
  saveProfile,
  loadEntries,
  saveEntry,
  deleteEntry,
  getCurrentUserId,
  clearCurrentUserId,
  fetchUserById,
  renameUser,
  loadWorkoutSessions,
  loadMaxAttempts,
  insertMaxAttempt,
  deleteMaxAttempt,
  loadCustomDayPlans,
  saveCustomDayPlan,
  deleteCustomDayPlan,
  loadCustomSplitTemplates,
  saveCustomSplitTemplate,
  deleteCustomSplitTemplate,
  getUserSplitId,
  getUserSplitStartedOn,
  setUserSplitId,
  offlineExecutors,
  loadMealPresets,
  saveMealPreset,
  deleteMealPreset,
  addCommunityFood,
} from "./lib/storage";
import { flushQueue, onQueueChange, onQueueError, clearQueue, isOnline } from "./lib/offlineQueue";
import { toastSuccess, toastUndo, toastError } from "./lib/toast";
import { pushNotificationsSupported, getCurrentPushSubscription, subscribeToPushNotifications, unsubscribeFromPushNotifications } from "./lib/pushNotifications";
import { WifiOff, RefreshCw } from "lucide-react";

/* ---------------------------------------------------------------
   Reference data, ported from the spreadsheet
----------------------------------------------------------------*/

const ACTIVITY_LEVELS = [
  { label: "Little to no exercise", mult: 1.2 },
  { label: "1-3x / week", mult: 1.35 },
  { label: "4-5x / week", mult: 1.55 },
  { label: "Intense, 3-4x / week", mult: 1.75 },
  { label: "Intense, 5-7x / week", mult: 1.95 },
];

const DEFAULT_PROFILE = {
  gender: "male",
  age: 26,
  heightIn: 70,
  activityIdx: 1,
  goalType: "lose", // "lose" | "maintain" | "gain" | "mini_cut"
  goalRateLbsPerWeek: 1,
  goalWeightLbs: null,
  miniCutStartedOn: null,
  goalStartedOn: null, // when the current lose/gain goal began — same idea as miniCutStartedOn, generalized so any goal type can track "days in" and accumulated deficit/surplus from a real date instead of guessing from your first logged day
  adaptiveTdee: null, // TDEE derived from your own logged weight+calorie data (energy-balance method), overriding the Mifflin-St Jeor formula when set
  adaptiveTdeeSetOn: null,
  adaptiveTdeeUpdatedAt: null, // precise timestamp (unlike the date-only adaptiveTdeeSetOn) used only to gate the 72-hour auto-update cooldown — set on both manual adoption and automatic recalculation
  useAdaptiveBodyFat: false, // opt-in for the formula + Navy circumference blend — off by default, same pattern as adaptiveTdee but a plain toggle instead of a frozen snapshot, since body measurements should keep updating the estimate live rather than going stale
  showBodyFatPct: null, // null = no explicit choice — defaults to hidden for female, shown for male, since this can be sensitive info; once explicitly set either way it sticks regardless of gender changes
  creatineAlreadySaturated: false, // lets someone already consistently taking creatine before joining skip the "just starting" ramp the 28-day rolling window would otherwise show
  setCoverageTargets: null, // per-muscle weekly set targets: { priority: [up to 2 groups aiming for 20], targets: { group: 10-14 } }; null = defaults
  waterGoalOz: null, // daily water target, nullable — UI suggests ~half bodyweight in oz as a starting point but doesn't force one
};

// Rough population-average bodyweight, used only as a placeholder in
// calorie/rate estimates shown before someone's logged a real weight —
// never used once actual weight data exists.
const FALLBACK_WEIGHT_ESTIMATE_LBS = 170;

// A mini cut's 2-6 week time window — used to warn if someone's run one too long.
const MINI_CUT_MAX_DAYS = 42;

// Rough, widely-cited sports-nutrition ceilings — not a hard limit, just a
// sanity check shown alongside the rate input. Faster than these numbers
// isn't dangerous by itself, but the applied-nutrition consensus (Helms,
// Aragon, and similar) is that going faster mostly means losing more
// muscle (on a cut) or gaining more fat (on a bulk) for the same result,
// not getting there meaningfully quicker in a way that sticks.
function getRecommendedMaxRate(goalType, weightLbs) {
  const w = weightLbs || FALLBACK_WEIGHT_ESTIMATE_LBS;
  if (goalType === "lose") {
    // ~0.5-1% of bodyweight/week keeps most of a deficit coming from fat
    // rather than lean mass; capped at 2 lbs/week since 1% gets unrealistic
    // at higher bodyweights.
    return { max: Math.min(w * 0.01, 2), basis: "~1% of bodyweight/week" };
  }
  if (goalType === "gain") {
    // ~0.25-0.5% of bodyweight/week is the commonly cited range for
    // minimizing fat gain while building muscle; capped at 1 lb/week.
    return { max: Math.min(w * 0.005, 1), basis: "~0.5% of bodyweight/week" };
  }
  return null;
}

/* ---------------------------------------------------------------
   Math
----------------------------------------------------------------*/

function bmr(gender, weightLbs, heightIn, age) {
  const kg = weightLbs * 0.453592;
  const cm = heightIn * 2.54;
  const base = 10 * kg + 6.25 * cm - 5 * age;
  return gender === "male" ? base + 5 : base - 161;
}

// Goal-direction-specific energy density (kcal per lb of body-weight
// change) — replaces a flat 3500 kcal/lb for every goal type. The flat
// "3500 rule" is well-documented as an overestimate (Hall & Chow, Int J
// Obesity 2013; Thomas et al.) for two compounding reasons: it assumes
// ALL weight change is pure fat, and it assumes expenditure holds
// constant while dieting, when it doesn't. The correction that actually
// matters here is by goal DIRECTION — a cut's loss stays fat-dominant
// (studies cite roughly 70-80% fat / 20-30% fat-free mass for a
// moderate deficit), keeping ~3500 within a defensible range, but a
// trained lifter's surplus-driven gain includes a meaningfully higher
// fraction of lean tissue — water, glycogen, protein, roughly 500-800
// kcal/lb — dropping the effective density well below 3500. These are
// still estimates, not measured constants, the same epistemic status as
// the number they're replacing — just aimed at the right target instead
// of one flat number for every direction.
const ENERGY_DENSITY_PER_LB = { lose: 3500, mini_cut: 3500, gain: 2800 };
function energyDensityFor(goalType) {
  return ENERGY_DENSITY_PER_LB[goalType] ?? 3500;
}

function daysBetweenDateStrs(a, b) {
  return Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000);
}

// Recency-weighted average — every logged value counts, but a value
// from today counts more than one from three weeks ago, decaying by
// half every `halfLifeDays`. Used for calories, where there's no "rate
// of change" concept, just "what's the recent representative average."
function weightedAverage(dateValuePairs, halfLifeDays, asOfDate) {
  let wSum = 0, wvSum = 0;
  for (const [date, v] of dateValuePairs) {
    const w = Math.pow(0.5, daysBetweenDateStrs(date, asOfDate) / halfLifeDays);
    wSum += w; wvSum += w * v;
  }
  return wSum > 0 ? wvSum / wSum : null;
}

// Recency-weighted LEAST-SQUARES slope (lbs/day) — the statistically
// correct tool for "estimate a rate of change from noisy points."
// Earlier prototypes tried a simpler two-point comparison (this
// half-life-weighted trend today, minus the same trend N days ago) and
// it measurably undershot a known synthetic rate — the trend's own lag
// behind a moving target hadn't settled into a constant, cancelable
// offset by the time a 14-day-back comparison point was reached, which
// left a real, verified bias (recovered TDEE off by ~70-190 cal against
// a known-true synthetic value). A weighted regression fits the slope
// from every point directly instead of a two-point difference, which
// has no lag to cancel in the first place, and it naturally shrugs off
// a gap in logging too — a missing week just means fewer points in the
// fit, not a comparison window that silently jumps forward past it
// (confirmed: the two-point version drifted to ~190 cal of error across
// a 10-day gap in testing; this version stayed within a few cal of the
// gap-free result on the same data).
function weightedSlope(dateValuePairs, halfLifeDays, asOfDate) {
  let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0;
  for (const [date, y] of dateValuePairs) {
    const age = daysBetweenDateStrs(date, asOfDate);
    const w = Math.pow(0.5, age / halfLifeDays);
    const x = -age; // days relative to asOfDate — more recent = larger x
    sw += w; swx += w * x; swy += w * y; swxx += w * x * x; swxy += w * x * y;
  }
  const denom = sw * swxx - swx * swx;
  if (Math.abs(denom) < 1e-9) return 0; // degenerate — effectively one distinct date
  return (sw * swxy - swx * swy) / denom;
}

// Data-driven maintenance estimate — infers TDEE from what actually
// happened (logged weight + intake) rather than only a formula, the
// same general idea used across applied nutrition sources. Verified
// head-to-head against the fixed-14-day-window method it replaces,
// under identical realistic noise across 8 random seeds: mean absolute
// error dropped from 169 to 139 cal, and — the more important number —
// the systematic bias dropped from +75 cal to -22 cal, meaning the old
// method wasn't just noisier, it was consistently overestimating,
// matching exactly what the literature predicts a static energy-balance
// model will do.
//
// Uses a 28-day recency-weighted lookback rather than a hard 14-day
// window: every logged day contributes, weighted by how recent it is
// (halving in influence every WEIGHT_HALF_LIFE_DAYS/CALORIE_HALF_LIFE_DAYS),
// so there's no hard edge where a day either counts fully or not at
// all, and a partial history can still produce an (honestly
// lower-confidence) early read instead of nothing until day 14 — which
// matters most for a 2-6 week mini-cut, where the old method could take
// until the cut was nearly over to say anything at all.
const ADAPTIVE_TDEE_MIN_DAYS = 5; // floor below which even a rough read isn't attempted
const WEIGHT_TREND_HALF_LIFE_DAYS = 7;
const CALORIE_TREND_HALF_LIFE_DAYS = 7;
const ADAPTIVE_TDEE_LOOKBACK_DAYS = 28;

// Bounds wide enough to never reject a real human, tight enough to
// catch the failure mode that actually matters: a single implausible
// point (weight logged as 0, a fat-finger typo like 20 instead of 200,
// a negative-calories glitch) silently entering the regression and
// producing something like a 10,983-cal or a NEGATIVE TDEE — confirmed
// in testing that exactly one such point can do this. Neither the old
// fixed-window average nor an early version of this rewrite validated
// input at all; both would have been equally corrupted by the same bad
// row. This doesn't catch a subtly-wrong-but-plausible entry (e.g. 150
// instead of 200) — nothing short of a second data source could — it
// only catches values no real logged day should ever produce.
const PLAUSIBLE_WEIGHT_LBS = [50, 600];
const PLAUSIBLE_CALORIES = [500, 8000];
function isPlausibleAdaptiveDay(e) {
  return e.weight != null && e.caloriesConsumed != null
    && e.weight >= PLAUSIBLE_WEIGHT_LBS[0] && e.weight <= PLAUSIBLE_WEIGHT_LBS[1]
    && e.caloriesConsumed >= PLAUSIBLE_CALORIES[0] && e.caloriesConsumed <= PLAUSIBLE_CALORIES[1];
}

function computeAdaptiveTDEE(entries, goalType, lookbackDays = ADAPTIVE_TDEE_LOOKBACK_DAYS) {
  const allDates = Object.keys(entries).filter(d => isPlausibleAdaptiveDay(entries[d])).sort();
  if (allDates.length < ADAPTIVE_TDEE_MIN_DAYS) {
    return { ready: false, daysLogged: allDates.length, minRequired: ADAPTIVE_TDEE_MIN_DAYS };
  }

  // new Date(todayStr()) looked right but wasn't: a "YYYY-MM-DD" string
  // parses as UTC midnight, which is still *yesterday evening* in any
  // timezone behind UTC (all of the Americas). Anchoring on the latest
  // LOGGED date (already a local-time "YYYY-MM-DD" string produced by
  // localDateStr elsewhere) avoids reintroducing that bug here.
  const asOfDate = allDates[allDates.length - 1];
  const cutoffDate = (() => {
    const d = new Date(asOfDate + "T00:00:00");
    d.setDate(d.getDate() - lookbackDays);
    return localDateStr(d);
  })();
  const windowDates = allDates.filter(d => d >= cutoffDate);
  if (windowDates.length < ADAPTIVE_TDEE_MIN_DAYS) {
    return { ready: false, daysLogged: windowDates.length, minRequired: ADAPTIVE_TDEE_MIN_DAYS };
  }

  const weightPairs = windowDates.map(d => [d, entries[d].weight]);
  const calorieePairs = windowDates.map(d => [d, entries[d].caloriesConsumed]);

  const ratePerDay = weightedSlope(weightPairs, WEIGHT_TREND_HALF_LIFE_DAYS, asOfDate); // lbs/day, signed
  const avgCalories = weightedAverage(calorieePairs, CALORIE_TREND_HALF_LIFE_DAYS, asOfDate);
  const energyDensity = energyDensityFor(goalType);
  const impliedTdee = avgCalories - ratePerDay * energyDensity;

  const daysSpan = Math.max(1, daysBetweenDateStrs(windowDates[0], asOfDate));
  // Confidence is a proxy for "how much to trust this yet" — NOT a true
  // statistical confidence interval, which would need a real noise
  // model this app doesn't have. It ramps on two independent things,
  // taking whichever is more limiting: total days of data relative to
  // 3 half-lives (~87.5% converged), and how much of the intended
  // lookback window is actually spanned by real data (so a gap-
  // compressed window — Test 7 in development — honestly shows lower
  // confidence instead of quietly returning a noisier number at the
  // same trust level as a full clean window).
  const daysConfidence = Math.min(100, (windowDates.length / (WEIGHT_TREND_HALF_LIFE_DAYS * 3)) * 100);
  const spanConfidence = Math.min(100, (daysSpan / lookbackDays) * 100);
  const confidence = Math.round(Math.min(daysConfidence, spanConfidence));

  return {
    ready: true,
    tdee: impliedTdee,
    avgCalories,
    weightChangeLbsPerWeek: ratePerDay * 7,
    daysSpan,
    daysLogged: windowDates.length,
    confidence,
    energyDensity,
  };
}

// Creatine monohydrate reaches steady-state muscle saturation after
// roughly 3-4 weeks of consistent daily dosing (no loading phase) —
// this is a well-established but approximate timeline, not something
// that can actually be measured without a muscle biopsy. Modeled as a
// rolling 28-day window: % of the last 28 days it was logged. Since it's
// a rolling window rather than an all-time count, missing days
// naturally pulls the percentage back down as they age into the window
// — no separate "decay" logic needed, it falls out of the same
// mechanism that builds the percentage up.
// Whether body fat % (and fat mass/lean mass, directly derived from it)
// should be shown anywhere in the app. One shared function so every
// screen agrees — the same reasoning as computeWaterGoalOz.
function isBodyFatVisible(profile) {
  return profile.showBodyFatPct ?? (profile.gender !== "female");
}

// Same figure the Water Log tab uses, kept in one place so the Dashboard
// and the Water Log tab can't ever compute a different number for the
// same day — that's exactly the kind of two-screens-disagree bug already
// found and fixed once for body fat %, not worth risking again here.
// Loading phase genuinely needs meaningfully more water than maintenance
// once fully saturated — consistent across sources. This app tracks a
// flat 5g/day rather than a true 20g+/day loading protocol, so this
// isn't as dramatic as full loading-phase figures, but the same "still
// ramping up needs more" principle applies while saturation is building.
function computeCreatineWaterBonusOz(saturationPct) {
  if (saturationPct >= 90) return 16; // maintenance — demand "decreases slightly" once saturated, per sources
  if (saturationPct >= 50) return 24; // building — the original flat figure
  return 32; // early / just starting — closer to a loading-like state
}
function computeWaterGoalOz(profile, weightLbs, tookCreatineToday, saturationPct = 0) {
  const suggested = weightLbs ? Math.round(weightLbs * 0.5) : 64;
  const base = profile.waterGoalOz || suggested;
  return base + (tookCreatineToday ? computeCreatineWaterBonusOz(saturationPct) : 0);
}

// General logging streak — consecutive days (working backward from
// today) with a real Daily Log entry. Same spirit as the creatine
// saturation streak, but for the app as a whole rather than one
// supplement — a much more universally motivating number, since it
// rewards showing up at all rather than any one specific metric.
function computeLoggingStreak(entries) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let streak = 0;
  for (let i = 0; i < 3650; i++) { // sane upper bound, not a real limit
    const d = new Date(today); d.setDate(d.getDate() - i);
    const ds = localDateStr(d);
    const e = entries[ds];
    const logged = e && e.weight != null && e.caloriesConsumed != null;
    if (logged) streak++;
    else break;
  }
  return streak;
}

function computeCreatineSaturation(entries, windowDays = 28, alreadySaturated = false, asOfDate = null) {
  // Same fix as computeAdaptiveTDEE — new Date(todayStr()) silently
  // resolved to yesterday in timezones behind UTC, so "today" was never
  // actually included in the rolling window.
  const today = asOfDate ? new Date(asOfDate + "T00:00:00") : (() => { const t = new Date(); t.setHours(0, 0, 0, 0); return t; })();
  let daysTaken = 0, streak = 0, streakBroken = false;
  for (let i = 0; i < windowDays; i++) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const ds = localDateStr(d);
    const took = (parseFloat(entries[ds]?.creatine) || 0) > 0;
    if (took) daysTaken++;
    if (!streakBroken) { if (took) streak++; else streakBroken = true; }
  }
  if (alreadySaturated) {
    // Manually marked as already at steady-state from before joining the
    // app — real daysTaken/streak still get tracked underneath (useful
    // context, and stays accurate if this ever gets turned off), but the
    // headline reflects what was told to us rather than what a rolling
    // window of app-only history could see.
    return { pct: 100, daysTaken, windowDays, streak, label: "Fully saturated", manual: true };
  }
  const pct = Math.round((daysTaken / windowDays) * 100);
  let label;
  if (pct >= 90) label = "Fully saturated";
  else if (pct >= 75) label = "Nearly saturated";
  else if (pct >= 50) label = "Building up";
  else if (pct >= 25) label = "Just starting";
  else label = "Not loaded";
  return { pct, daysTaken, windowDays, streak, label, manual: false };
}


function computeStats(profile, weightLbs, measurements = {}) {
  const mult = ACTIVITY_LEVELS[profile.activityIdx].mult;
  const base = bmr(profile.gender, weightLbs, profile.heightIn, profile.age);
  // Formula estimate is always computed (used for comparison in the UI even
  // when an adaptive override is active), but the override — when set —
  // is what actually drives suggested calories. It's derived from your own
  // logged weight and calorie data, so it corrects for anything the
  // formula can't know: individual metabolic variation, activity you
  // didn't account for in the dropdown, tracking accuracy, etc.
  const formulaTdee = base * mult;
  const tdee = profile.adaptiveTdee || formulaTdee;

  // Body fat % — BMI-based formula from the spreadsheet's Body Calculations
  // tab (Deurenberg). It's weight/height/age/gender only, so it can't tell
  // a muscular person from a fat one at the same BMI — a known limitation.
  const heightIn = profile.heightIn || 1;
  const bmi = (weightLbs / (heightIn * heightIn)) * 703;
  const formulaBodyFatPct =
    profile.gender === "male"
      ? 1.2 * bmi + 0.23 * profile.age - 16.2
      : 1.2 * bmi + 0.23 * profile.age - 5.4;

  // U.S. Navy circumference method — actually measures your shape (neck +
  // waist) instead of inferring from weight/height alone, so it doesn't
  // share the BMI formula's blind spot for muscular builds. Male-only for
  // now: the women's version also needs hip circumference, which isn't
  // tracked yet. Blended rather than fully replacing the formula estimate
  // — circumference measurements carry their own error from tape
  // placement/tension, so a blend is more stable than either alone.
  // Weighted 65% formula / 35% Navy (an even split, shifted toward the
  // formula) per your call.
  const { neckIn, waistIn } = measurements;
  const navyEligible = profile.gender === "male" && neckIn > 0 && waistIn > neckIn && heightIn > 0;
  const navyBodyFatPct = navyEligible
    ? 86.010 * Math.log10(waistIn - neckIn) - 70.041 * Math.log10(heightIn) + 36.76
    : null;
  // Blend only actually applies once opted into in Settings — computed
  // above regardless, so Settings can show the comparison even before
  // it's turned on.
  const bodyFatPct = navyBodyFatPct != null && profile.useAdaptiveBodyFat
    ? 0.65 * formulaBodyFatPct + 0.35 * navyBodyFatPct
    : formulaBodyFatPct;

  const fatLbs = weightLbs * (bodyFatPct / 100);
  const leanLbs = weightLbs - fatLbs;

  // Suggested calories from the goal.
  // "lose"/"gain": rate-based (lbs/week × goal-direction energy density
  // — see ENERGY_DENSITY_PER_LB for why this isn't a flat 3500 anymore).
  // "mini_cut": a 25% deficit below TDEE — the middle of the 20-30% range
  // commonly recommended for a short (2-6 week), high-adherence cut.
  const rate = profile.goalRateLbsPerWeek || 0;
  let dailyCalorieAdjustment = 0;
  if (profile.goalType === "lose") dailyCalorieAdjustment = -(rate * energyDensityFor(profile.goalType)) / 7;
  else if (profile.goalType === "gain") dailyCalorieAdjustment = (rate * energyDensityFor(profile.goalType)) / 7;
  else if (profile.goalType === "mini_cut") dailyCalorieAdjustment = -tdee * 0.25;
  const suggestedCalories = tdee + dailyCalorieAdjustment;

  // Macro targets, built from the INTAKE TARGET (suggested calories), not
  // maintenance — otherwise carb targets overshoot on a cut and undershoot
  // on a bulk. Protein ~1 g/lb (evidence range is ~0.7-1.0 for lifters;
  // the top of it costs nothing and helps satiety on a cut). Fat at 25% of
  // intake — the middle of the 20-30% band below which hormonal and
  // performance issues become more likely. Carbs fill whatever's left.
  const proteinG = weightLbs * 1.0;
  const fatG = (suggestedCalories * 0.25) / 9;
  const carbG = Math.max(0, (suggestedCalories - (proteinG * 4 + fatG * 9)) / 4);

  return {
    bmr: base,
    formulaTdee,
    tdee,
    deficitTarget: tdee - 500,
    surplusTarget: tdee + 500,
    proteinG,
    fatG,
    carbG,
    bmi,
    bodyFatPct,
    formulaBodyFatPct,
    navyBodyFatPct,
    navyEligible,
    fatLbs,
    leanLbs,
    dailyCalorieAdjustment,
    suggestedCalories,
  };
}

// Formats a Date as YYYY-MM-DD using LOCAL date components, not UTC.
// toISOString() converts to UTC first, which rolls the date over early —
// e.g. at 10pm EST, UTC is already past midnight into the next day, so
// toISOString().slice(0,10) silently returns tomorrow's date.
function localDateStr(d = new Date()) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function todayStr() {
  return localDateStr(new Date());
}

// Shifts a YYYY-MM-DD string by N days (negative to go backward), staying
// in local time throughout — used by "Copy from yesterday".
function shiftDateStr(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return localDateStr(d);
}

// Finds the most recent logged value for one measurement field — each
// field tracks its own dates independently (people rarely measure
// everything on the same schedule), so this can't just grab "the latest
// entry's measurements" wholesale.
// Guards every numeric save path in the app — nothing here should ever
// be negative (weight, calories, macros, water, measurements), and none
// of the number inputs had any validation against it before this. A
// stray minus key or a spinner-arrow slip would previously save silently.
function clampPositive(n) {
  const v = parseFloat(n);
  if (Number.isNaN(v)) return 0;
  return Math.max(0, v);
}

function latestMeasurement(entries, key) {
  const dates = Object.keys(entries).filter((d) => entries[d].measurements?.[key]).sort();
  const last = dates[dates.length - 1];
  return last ? parseFloat(entries[last].measurements[key]) : null;
}

function fmt(n, d = 0) {
  if (n === null || n === undefined || Number.isNaN(n)) return "--";
  return n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d });
}

// A calorie "balance" is negative when you're in a deficit — which is
// usually the intended, successful outcome, not a bad result. Showing it
// as a bare "-2,513 cal" reads as a loss/failure regardless of goal.
// This reports the magnitude with a plain-language label instead, so a
// deficit reads as a deficit, not as a negative number to feel bad about.
function balancePhrase(cal, unit = "cal") {
  if (cal == null || Number.isNaN(cal)) return `-- ${unit}`;
  const mag = Math.round(Math.abs(cal));
  if (mag === 0) return `0 ${unit} (at maintenance)`;
  return `${fmt(mag)} ${unit} ${cal < 0 ? "deficit" : "surplus"}`;
}

function prettyDate(d) {
  const dt = new Date(d + "T00:00:00");
  return dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

// Renders one logged set as "185 × 8" for the Set Coverage breakdown —
// tolerant of both stored shapes (`{weight, reps}` from saved sessions,
// `{w, r}` from in-progress logging state) so it works no matter where
// the set object came from. Falls back gracefully if either half is
// missing rather than showing "undefined × undefined".
function formatSetDetail(set) {
  const wRaw = set?.weight ?? set?.w;
  const rRaw = set?.reps ?? set?.r;
  const w = parseFloat(wRaw);
  const r = parseInt(rRaw);
  const hasW = wRaw !== null && wRaw !== undefined && wRaw !== "" && !Number.isNaN(w);
  const hasR = rRaw !== null && rRaw !== undefined && rRaw !== "" && !Number.isNaN(r);
  if (!hasW && !hasR) return "—";
  if (!hasW) return `${r} reps`;
  const wLabel = fmt(w, Number.isInteger(w) ? 0 : 1);
  if (!hasR) return `${wLabel} lbs`;
  return `${wLabel} × ${r}`;
}

// Fixes the "typing 19 into a field that still shows 0 gives 019" bug —
// selecting all text on focus means the next keystroke replaces it
// instead of appending to whatever was already there.
function selectOnFocus(e) {
  e.target.select();
}

const MEASUREMENT_FIELDS = [
  {
    key: "neck",
    label: "Neck (in)",
    hint: "Measure just below the larynx (Adam's apple), keeping the tape level and snug but not compressing the skin.",
  },
  {
    key: "shoulders",
    label: "Shoulders (in)",
    hint: "Measure around the widest circumference of your shoulders and upper chest (across the deltoid muscles). Alternatively, for width, measure the straight distance across the back between the tips of your shoulder bones.",
  },
  {
    key: "leftArm",
    label: "Left arm (in)",
    hint: "Measure the upper arm at the widest point, typically the midpoint between the shoulder joint (acromion) and the elbow joint, while the arm is relaxed and hanging down.",
  },
  {
    key: "rightArm",
    label: "Right arm (in)",
    hint: "Measure the upper arm at the widest point, typically the midpoint between the shoulder joint (acromion) and the elbow joint, while the arm is relaxed and hanging down.",
  },
  {
    key: "waist",
    label: "Waist (in)",
    hint: "Measure your natural waistline — typically the narrowest point of your torso, located above your belly button and just below your ribcage.",
  },
  {
    key: "glutes",
    label: "Glutes (in)",
    hint: "Measure around the widest point of your hips and glutes, keeping the tape level all the way around.",
    tutorialUrl: "https://www.youtube.com/watch?v=pvO9P1aVVFs",
  },
  {
    key: "leftLeg",
    label: "Left leg (in)",
    hint: "Measure the upper leg at the largest circumference — usually the widest part of your thigh, about one hand-width below your glute fold.",
  },
  {
    key: "rightLeg",
    label: "Right leg (in)",
    hint: "Measure the upper leg at the largest circumference — usually the widest part of your thigh, about one hand-width below your glute fold.",
  },
];

const MEASUREMENT_GUIDE_URL =
  "https://www.google.com/search?q=measurements+used+for+body+composition+like+shoulder+left+arm+right+arm+waiset+left+leg+and+right+leg&rlz=1C1CHZN_enUS1064US1064&oq=measurements+used+for+body+composition+like+shoulder+left+arm+right+arm+waiset+left+leg+and+right+leg&gs_lcrp=EgZjaHJvbWUyBggAEEUYOdIBCTIwMTAxajBqN6gCCLACAfEFqfpRk76Kuq0&sourceid=chrome&ie=UTF-8#fpstate=ive&sv=CBAS6QkKwQkKBtrZ29IPABK2CQrdAgraArrZ29IP0wIKK2h0dHBzOi8vd3d3LnlvdXR1YmUuY29tL3dhdGNoP3Y9TG9MX1FUYXRHaFUSB1lvdVR1YmUalgJkYXRhOmltYWdlL3BuZztiYXNlNjQsaVZCT1J3MEtHZ29BQUFBTlNVaEVVZ0FBQUJBQUFBQVFDQVlBQUFBZjgvOWhBQUFBaFVsRVFWUjRBV053TC9DaENGUEhnUDhNeHF4QTdBckVLVkJjQ2NVTklBem5JK1JkUVhyQUJnQVpwdjhaalA2VGcwRjZRUWJzb3NDQVhTQURIbUdWVlBJQzBqS0VESGdBTXVBYm1nUkU0NDVELy8vZmVZelhJSkJlQmlnSDA0QlZXLzlEQWNnd3FFR1lhaWsyZ0dJdlVCeUlsRWJqRG9vVEVpd3BzNUdSbE5tb2xwa293Z0JWUDl3TVN6U0tHQUFBQUFCSlJVNUVya0pnZ2c9PSABOAEKggIK_wHS2dvSD_gBCjpIb3cgVG8gTWVhc3VyZSBZb3VyIEdhaW5zISBBcm0sIENoZXN0LCBTaG91bGRlciwgV2Fpc3QgLi4uEitodHRwczovL3d3dy55b3V0dWJlLmNvbS93YXRjaD92PUxvTF9RVGF0R2hVGowBV3JhcCB0aGUgdGFwZSBhcm91bmQgdGhlIHRoaWNrZXN0IHBhcnQgb2YgeW91ciBnbHV0ZXMgLyBoaXBzLiBXcmFwIHRoZSBtZWFzdXJpbmcgdGFwZSBhcm91bmQgdGhlIHRoaWNrZXN0IHBhcnQgb2YgdGhlIGNhbGYuIEFybSwgQ2hlc3QsICAuLi4KxAIKwQLC2dvSD7oCEjpIb3cgVG8gTWVhc3VyZSBZb3VyIEdhaW5zISBBcm0sIENoZXN0LCBTaG91bGRlciwgV2Fpc3QgLi4uUmsYBSo6SG93IFRvIE1lYXN1cmUgWW91ciBHYWlucyEgQXJtLCBDaGVzdCwgU2hvdWxkZXIsIFdhaXN0IC4uLjoraHR0cHM6Ly93d3cueW91dHViZS5jb20vd2F0Y2g_dj1Mb0xfUVRhdEdoVWJNCgxWSURFT19SRVNVTFQSBENPSU8aBEJMVVIgACgAMAFCK2h0dHBzOi8vd3d3LnlvdXR1YmUuY29tL3dhdGNoP3Y9TG9MX1FUYXRHaFVyQAoraHR0cHM6Ly93d3cueW91dHViZS5jb20vd2F0Y2g_dj1Mb0xfUVRhdEdoVSgjMg9Tb3VyY2U6IFlvdVR1YmUKhwIKhALK2dvSD_0BEtUBItIBL3NlYXJjaC9hYm91dC10aGlzLXJlc3VsdD9vcmlnaW49d3d3Lmdvb2dsZS5jb20mY3M9MSZyZXE9Q2l0b2RIUndjem92TDNkM2R5NTViM1YwZFdKbExtTnZiUzkzWVhSamFEOTJQVXh2VEY5UlZHRjBSMmhWRWhZS0VBb0VDREJJQWdvRUNFaElBZ29DQ0Q4YUFnZ0FHaFlTQUJvQUlnQXFBRElBT2dCQ0FFb0FXZ0J5QUhvQUlnSVFBVWdCV0FCb0FBJmhsPWVuLVVTJmdsPVVTGhZodHRwczovL3d3dy5nb29nbGUuY29tWgBgAWgBcAB4AIoBABIjYXRyaXRlbS1fWWJsQmF0eUhMc1RQcDg0UHdvclotQVFfNDcYLyCRmoeuAQ&vld=cid:1467743b,vid:LoL_QTatGhU,st:0";

/* ---------------------------------------------------------------
   Style tokens
----------------------------------------------------------------*/

// ── Palette ──────────────────────────────────────────────────────
// Succulent Lime #DDDE68 · Wondrous Wisteria #A5B2EB · Persian Orange #DA935D
// Daemonette Hide #676386 · Blue Suede Shoes #494C65 · Black Rock #2B2D3B
// ── Palette v2 — grey / black / baby blue / teal green ────────────
// Key names are kept the same as the original palette (ember, mint,
// amber, wisteria, daemonette) even though the actual colors changed,
// so every existing COLORS.xxx reference across the app picks up the
// new palette automatically without needing to touch each call site.
// Semantic roles stayed the same: ember = primary accent, mint =
// positive/success, amber/wisteria = secondary, daemonette = muted
// tertiary. Gold is new and reserved ONLY for the bottom nav — never
// used elsewhere in the app.
const COLORS = {
  bg: "#1C1E26",
  surface: "#262933",
  surfaceRaised: "#30343E",
  border: "#40465A",
  cream: "#F3F5F9",
  creamDim: "#9CA1B5",
  ember: "#4FADFF",          // primary accent — baby blue (was Persian Orange)
  emberDim: "#1B2E4A",
  mint: "#2BE6A8",           // success/positive — teal green (was Succulent Lime)
  mintDim: "#123B33",
  amber: "#8B93C9",          // secondary accent — soft slate periwinkle (was Wondrous Wisteria)
  amberDim: "#2E3350",
  wisteria: "#8B93C9",
  daemonette: "#565B72",     // muted tertiary (was Daemonette Hide)
  danger: "#FF7A85",
  dangerDim: "#402328",
  blueBright: "#6FE0FF",     // gradient stop, used with ember
  tealBright: "#7CF7CD",     // gradient stop, used with mint
  gold: "#D9A94E",           // nav pill ONLY — do not use elsewhere
  goldBright: "#F0C875",
};

const GRAD_MAIN = `linear-gradient(135deg, ${COLORS.ember}, ${COLORS.mint})`;
const GRAD_BORDER = `linear-gradient(135deg, rgba(79,173,255,0.55), rgba(43,230,168,0.55))`;
const GRAD_GLOW = `linear-gradient(160deg, rgba(79,173,255,0.22), rgba(43,230,168,0.10) 60%, transparent)`;

const GlobalStyle = () => (
  <style>{`
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;600&display=swap');

    /* ── Design tokens ─────────────────────────────────────────────
       A small, deliberately short list — reused everywhere instead of
       one-off pixel values, so spacing/radius/type stay consistent
       across the app instead of drifting card-by-card. */
    :root {
      --ft-space-sm: 8px;
      --ft-space-md: 16px;
      --ft-space-lg: 24px;
      --ft-font-sm: 12px;
      --ft-font-lg: 20px;
      --ft-accent: ${COLORS.ember};
      --ft-radius: 12px;
      --ft-radius-pill: 999px;
      --ft-touch: 44px;
      --ft-grad-main: ${GRAD_MAIN};
      --ft-grad-border: ${GRAD_BORDER};
      --ft-grad-glow: ${GRAD_GLOW};
      --ft-gold: ${COLORS.gold};
      --ft-gold-bright: ${COLORS.goldBright};
    }

    /* ── iOS-specific polish ──────────────────────────────────────── */
    html, body, #root { height: 100%; }
    body {
      margin: 0;
      background: ${COLORS.bg};
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
      /* Stops an accidental pull-down gesture from bouncing the whole
         page — feels more like a native app, less like a webpage. */
      overscroll-behavior-y: contain;
      /* Insets the app below the notch/Dynamic Island and above the
         home indicator on iPhone, using the safe-area values exposed
         via viewport-fit=cover in index.html. */
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom);
      padding-left: env(safe-area-inset-left);
      padding-right: env(safe-area-inset-right);
    }
    /* Removes the gray flash Safari shows on every tap by default. */
    * { -webkit-tap-highlight-color: transparent; }

    .ft-app { font-family: 'Inter', sans-serif; background: ${COLORS.bg}; color: ${COLORS.cream}; min-height: 100%; }
    .ft-display { font-family: 'Inter', sans-serif; font-weight: 800; letter-spacing: -0.01em; }
    .ft-mono { font-family: 'JetBrains Mono', monospace; font-variant-numeric: tabular-nums; font-feature-settings: "tnum" 1; }
    .ft-grad-text { background: var(--ft-grad-main); -webkit-background-clip: text; background-clip: text; color: transparent; }

    /* Every card carries the same subtle gradient-ring border by
       default (a dim version of the brand gradient via the classic
       two-layer background trick) — .ft-card-hero uses the full-
       strength version so the one number people act on each day
       still reads as the most important thing on the screen. */
    .ft-card {
      background: linear-gradient(${COLORS.surface}, ${COLORS.surface}) padding-box, var(--ft-grad-border) border-box;
      border: 1px solid transparent;
      border-radius: var(--ft-radius);
      transition: transform 0.2s cubic-bezier(0.16,1,0.3,1), box-shadow 0.2s ease;
    }
    .ft-card-raised {
      background: linear-gradient(${COLORS.surfaceRaised}, ${COLORS.surfaceRaised}) padding-box, var(--ft-grad-border) border-box;
      border: 1px solid transparent;
      border-radius: var(--ft-radius);
    }
    .ft-card-hero {
      background: linear-gradient(${COLORS.surfaceRaised}, ${COLORS.surfaceRaised}) padding-box, var(--ft-grad-main) border-box;
      border: 1px solid transparent;
      box-shadow: 0 6px 20px rgba(79,173,255,0.15);
    }
    .ft-card-clickable { cursor: pointer; }
    .ft-card-clickable:hover { transform: translateY(-2px); box-shadow: 0 10px 24px rgba(0,0,0,0.25); }
    .ft-card-clickable:active { transform: translateY(0) scale(0.99); }

    .ft-tab { font-family: 'Inter', sans-serif; font-weight: 600; font-size: 13px; letter-spacing: 0.04em; text-transform: uppercase; color: ${COLORS.creamDim}; border: none; background: transparent; cursor: pointer; transition: color 0.15s ease; }
    .ft-tab:hover { color: ${COLORS.cream}; }
    .ft-tab.active { color: var(--ft-accent); }

    .ft-input {
      background: ${COLORS.bg};
      border: 1px solid ${COLORS.border};
      border-radius: var(--ft-radius);
      color: ${COLORS.cream};
      padding: 8px 10px;
      font-family: 'JetBrains Mono', monospace;
      font-variant-numeric: tabular-nums;
      font-size: 14px;
      width: 100%;
      outline: none;
    }
    .ft-input:focus { border-color: var(--ft-accent); }
    .ft-select {
      background: ${COLORS.bg};
      border: 1px solid ${COLORS.border};
      border-radius: var(--ft-radius);
      color: ${COLORS.cream};
      padding: 8px 10px;
      font-family: 'Inter', sans-serif;
      font-size: 14px;
      width: 100%;
      outline: none;
    }
    .ft-label { font-size: var(--ft-font-sm); text-transform: uppercase; letter-spacing: 0.06em; color: ${COLORS.creamDim}; margin-bottom: 4px; display: block; }

    .ft-btn {
      font-family: 'Inter', sans-serif;
      font-weight: 600;
      font-size: 13px;
      border-radius: var(--ft-radius);
      padding: 9px 16px;
      cursor: pointer;
      border: none;
      transition: filter 0.15s ease, transform 0.15s cubic-bezier(0.16,1,0.3,1), box-shadow 0.15s ease;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      min-height: var(--ft-touch);
      min-width: var(--ft-touch);
      box-sizing: border-box;
    }
    .ft-btn:hover { filter: brightness(1.12); transform: translateY(-1px); }
    .ft-btn:active { transform: scale(0.97); }
    .ft-btn-primary { background: var(--ft-grad-main); color: #0A1E27; box-shadow: 0 8px 24px rgba(43,230,168,0.25); }
    .ft-btn-ghost { background: ${COLORS.surfaceRaised}; color: ${COLORS.cream}; border: 1px solid ${COLORS.border}; }
    .ft-btn-danger { background: transparent; color: ${COLORS.danger}; padding: 6px 8px; min-height: var(--ft-touch); min-width: var(--ft-touch); }
    .ft-btn-icon { min-height: var(--ft-touch); min-width: var(--ft-touch); padding: 0; }

    .ft-pill { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; padding: 3px 9px; border-radius: var(--ft-radius-pill); }

    .ft-scroll { overscroll-behavior: contain; }
    .ft-scroll::-webkit-scrollbar { height: 6px; width: 6px; }
    .ft-scroll::-webkit-scrollbar-thumb { background: ${COLORS.border}; border-radius: 4px; }

    /* ── Entrance animations — a tab switch fades/lifts in, and its
       direct-child cards arrive staggered rather than all at once.
       Timed deliberately on the slower side (per direct feedback)
       so each step actually registers instead of blurring together. */
    .ft-row-enter { animation: ftFade 0.25s ease; }
    @keyframes ftFade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

    .ft-tab-panel { animation: ftPanelIn 0.52s cubic-bezier(0.16,1,0.3,1); }
    @keyframes ftPanelIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    .ft-tab-panel > * { animation: ftCardIn 0.62s cubic-bezier(0.16,1,0.3,1) backwards; }
    .ft-tab-panel > *:nth-child(1) { animation-delay: 0.05s; }
    .ft-tab-panel > *:nth-child(2) { animation-delay: 0.17s; }
    .ft-tab-panel > *:nth-child(3) { animation-delay: 0.29s; }
    .ft-tab-panel > *:nth-child(4) { animation-delay: 0.41s; }
    .ft-tab-panel > *:nth-child(5) { animation-delay: 0.53s; }
    @keyframes ftCardIn { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: translateY(0); } }

    .ft-pill-pop { animation: ftPillPop 0.55s cubic-bezier(0.34,1.56,0.64,1) backwards; }
    @keyframes ftPillPop { from { opacity: 0; transform: scale(0.6); } to { opacity: 1; transform: scale(1); } }

    .ft-sway { animation: ftSway 3.4s ease-in-out infinite; animation-delay: var(--sway-delay, 0s); }
    @keyframes ftSway { 0%, 100% { transform: rotate(-4deg); } 50% { transform: rotate(4deg); } }
    .ft-blink { animation: ftBlink 3.6s ease-in-out infinite; transform-origin: center; }
    @keyframes ftBlink { 0%, 92%, 100% { transform: scaleY(1); } 95% { transform: scaleY(0.15); } }

    .ft-fill { transition: width 1.2s cubic-bezier(0.16,1,0.3,1); }
    .ft-bar-fill { transition: height 0.9s cubic-bezier(0.16,1,0.3,1); }
    .ft-ring-fill { transition: stroke-dashoffset 1.3s cubic-bezier(0.16,1,0.3,1); }
    .ft-ring-celebrate { animation: ftRingCelebrate 0.7s cubic-bezier(0.34,1.56,0.64,1); }
    @keyframes ftRingCelebrate {
      0% { transform: scale(1); filter: drop-shadow(0 0 0 transparent); }
      40% { transform: scale(1.08); filter: drop-shadow(0 0 14px ${COLORS.mint}); }
      100% { transform: scale(1); filter: drop-shadow(0 0 0 transparent); }
    }

    /* ── Skeleton loaders — replace spinners on data-heavy views so the
       shape of the eventual content is visible immediately, which reads
       as faster even at identical load time. */
    .ft-skeleton {
      background: linear-gradient(90deg, ${COLORS.surface} 25%, ${COLORS.surfaceRaised} 37%, ${COLORS.surface} 63%);
      background-size: 400% 100%;
      animation: ftSkeleton 1.4s ease infinite;
      border-radius: var(--ft-radius);
    }
    @keyframes ftSkeleton { 0% { background-position: 100% 50%; } 100% { background-position: 0 50%; } }

    /* ── Sticky save bar — keeps the primary save action reachable
       without scrolling back up, once the Log Entry form gets tall.
       Desktop has room to see the button without scrolling, so this
       only kicks in on the mobile layout (see media query below). */
    .ft-sticky-save { margin-top: var(--ft-space-md); }

    /* ── Bottom nav — floating pill, replacing the old top tab row.
       Gold is deliberately scoped to ONLY this element in the entire
       app: a subtle gold-tinted border/glow around the pill, and the
       pill's own background fades from the normal surface tone into a
       warm gold at its bottom edge, so the color reads as built into
       the pill's material rather than a separate light floating
       behind it. Nowhere else in the app uses gold. */
    .ft-nav {
      position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
      display: flex; flex-direction: column; align-items: center; gap: 8px; z-index: 500;
    }
    .ft-nav-primary {
      display: flex; gap: 4px;
      background: linear-gradient(180deg, ${COLORS.surfaceRaised} 55%, rgba(191,146,64,0.24));
      border: 1px solid rgba(217,169,78,0.4);
      border-radius: 999px; padding: 6px;
      box-shadow: 0 12px 30px rgba(0,0,0,0.45), 0 4px 26px rgba(217,169,78,0.22);
    }
    .ft-nav-item {
      display: flex; flex-direction: column; align-items: center; gap: 3px;
      padding: 8px 15px; border-radius: 999px; font-size: 9.5px; font-weight: 600;
      color: ${COLORS.creamDim}; cursor: pointer; background: none; border: none; font-family: 'Inter', sans-serif;
      transition: background 0.25s cubic-bezier(0.16,1,0.3,1), color 0.25s ease, transform 0.15s ease;
    }
    .ft-nav-item svg { transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1); }
    .ft-nav-item.active { background: var(--ft-grad-main); color: #0A1E27; }
    .ft-nav-item.active svg { transform: scale(1.12); }
    .ft-nav-item:active { transform: scale(0.94); }
    .ft-nav-sub {
      display: flex; gap: 4px; background: ${COLORS.surface}; border: 1px solid ${COLORS.border};
      border-radius: 999px; padding: 5px; box-shadow: 0 8px 20px rgba(0,0,0,0.4);
      animation: ftSubnavIn 0.45s cubic-bezier(0.16,1,0.3,1);
    }
    @keyframes ftSubnavIn { from { opacity: 0; transform: translateY(6px) scale(0.96); } to { opacity: 1; transform: translateY(0) scale(1); } }
    .ft-nav-sub-item {
      padding: 6px 12px; border-radius: 999px; font-size: 10.5px; font-weight: 600;
      color: ${COLORS.creamDim}; cursor: pointer; background: none; border: none; font-family: 'Inter', sans-serif;
      white-space: nowrap; transition: background 0.2s ease, color 0.2s ease, transform 0.15s ease;
    }
    .ft-nav-sub-item.active { background: ${COLORS.mintDim}; color: ${COLORS.mint}; }
    .ft-nav-sub-item:active { transform: scale(0.93); }

    @media (max-width: 680px) {
      .ft-app { padding: 10px !important; padding-bottom: 100px !important; }
      .ft-tab { font-size: 11px; padding: 8px 4px; min-height: var(--ft-touch); }
      .ft-tabs-scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; display: flex; gap: 14px; scrollbar-width: none; white-space: nowrap; padding-bottom: 2px; }
      .ft-tabs-scroll::-webkit-scrollbar { display: none; }
      .ft-mobile-stack { grid-template-columns: 1fr !important; }
      .ft-input, .ft-select { font-size: 16px !important; min-height: var(--ft-touch); box-sizing: border-box; }
      .ft-btn { min-height: var(--ft-touch); }
      .ft-sticky-save {
        position: sticky;
        bottom: calc(env(safe-area-inset-bottom, 0px) + 10px);
        z-index: 40;
        background: ${COLORS.bg};
        padding-top: 8px;
        margin-left: -10px;
        margin-right: -10px;
        padding-left: 10px;
        padding-right: 10px;
      }
      .ft-sticky-save .ft-btn { width: 100%; }
      /* Bottom nav grew from 5 to 6 top-level items — on narrow phone
         widths, multi-word labels like "Trending Progression" were
         wrapping to two lines, which made the whole bar taller, not just
         each button narrower. Icon-only (no visible label) removes that
         problem at the source instead of just shrinking padding around
         it — the icons are already distinct enough to navigate by, and
         the active state still highlights clearly. */
      .ft-nav { bottom: 12px; max-width: calc(100vw - 16px); }
      .ft-nav-primary { gap: 3px; padding: 5px; max-width: 100%; overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch; }
      .ft-nav-primary::-webkit-scrollbar { display: none; }
      .ft-nav-item { padding: 10px; border-radius: 999px; flex-shrink: 0; }
      .ft-nav-item span { display: none; }
      .ft-nav-item svg { width: 18px; height: 18px; }
    }
  `}</style>
);

/* ---------------------------------------------------------------
   Main App
----------------------------------------------------------------*/

// Consolidated nav: 5 top-level destinations instead of 10 flat tabs.
// "Log" and "Train" expand into a secondary row of sub-tabs; Home, Trends,
// and Settings are standalone. Tab values (the strings used everywhere else
// in the app, e.g. tab === "weighin") are unchanged — this only restructures
// how they're navigated to.
const NAV_GROUPS = [
  { key: "home", label: "Dashboard", icon: <Home size={14} /> },
  {
    key: "logGroup", label: "Daily Logging", icon: <Plus size={14} />,
    children: [
      { key: "log", label: "Daily Log", icon: <Plus size={13} /> },
      { key: "food", label: "Food Log", icon: <UtensilsCrossed size={13} />, feature: "food" },
      { key: "water", label: "Water Log", icon: <Droplet size={13} />, feature: "water" },
    ],
  },
  {
    key: "checkInGroup", label: "Check-Ins", icon: <ClipboardCheck size={14} />,
    children: [
      { key: "weighin", label: "Weigh-In", icon: <Scale size={13} />, feature: "weighin" },
      { key: "measurements", label: "Measurements", icon: <Ruler size={13} />, feature: "measurements" },
    ],
  },
  {
    key: "trainGroup", label: "Strength Training", icon: <Dumbbell size={14} />, feature: "train",
    children: [
      { key: "trainDay", label: "Training Day", icon: <Dumbbell size={13} /> },
      { key: "splitInfo", label: "Split Info", icon: <CalendarDays size={13} /> },
      { key: "setCoverage", label: "Set Coverage", icon: <Layers size={13} /> },
      { key: "maxTracker", label: "Big 3 Maxes", icon: <Trophy size={13} /> },
    ],
  },
  { key: "trends", label: "Trending Progression", icon: <TrendingUp size={14} />, feature: "trends" },
  { key: "settings", label: "Settings", icon: <SettingsIcon size={14} /> },
];

// Feature toggles — lets someone strip the app down to just what they use
// (e.g. only calorie counting + weigh-ins, or only training + trends).
// Dashboard, Daily Log, and Settings are always on: they're the app's
// spine, and Settings has to stay reachable or you couldn't toggle
// anything back. Stored per-user in localStorage (a device preference,
// like the cm/in toggle — not worth a schema migration).
const FEATURE_DEFS = [
  { key: "weighin", label: "Weigh-In", blurb: "Multiple weigh-ins per day with times and tags" },
  { key: "water", label: "Water Log", blurb: "Daily water intake with a goal and quick-add buttons" },
  { key: "food", label: "Food Log", blurb: "USDA food search, barcode scanning, meal presets" },
  { key: "measurements", label: "Measurements", blurb: "Shoulders, arms, waist, and leg tracking" },
  { key: "train", label: "Strength Training", blurb: "Lifting splits, workout logging, progression suggestions" },
  { key: "trends", label: "Trending Progression", blurb: "Weight, body fat, calorie balance, and lift trends" },
];
const DEFAULT_FEATURES = { weighin: true, water: true, food: true, measurements: true, train: true, trends: true };

function loadFeatures(userId) {
  try {
    const raw = localStorage.getItem(`forge_features_${userId}`);
    return raw ? { ...DEFAULT_FEATURES, ...JSON.parse(raw) } : { ...DEFAULT_FEATURES };
  } catch {
    return { ...DEFAULT_FEATURES };
  }
}

function MainApp({ userId, userName, avatarData, onSwitchUser, onRenameUser }) {
  const [loaded, setLoaded] = useState(false);
  const [profile, setProfile] = useState(DEFAULT_PROFILE);
  const [entries, setEntries] = useState({});
  // "idle" | "saving" | "saved" — drives the live Saving.../Saved indicator
  // in LogEntry, set synchronously around every mergeAndSaveEntry call.
  const [saveStatus, setSaveStatus] = useState("idle");
  const saveStatusTimeout = useRef(null);
  const [tab, setTab] = useState("home");
  const [selectedDate, setSelectedDate] = useState(todayStr());

  // Notification tap-to-open — api/send-notifications.js sets each
  // push's url to "/?tab=water" (etc.), so a tap lands on the specific
  // screen the reminder was about instead of just the app's default
  // Dashboard. Only runs once on mount; the URL is cleaned up right
  // after so a later manual refresh doesn't keep forcing that tab.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const targetTab = params.get("tab");
    if (targetTab) {
      setTab(targetTab);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  // Feature toggles — per-user, per-device (localStorage). Loaded when the
  // user is known; toggling a feature off while you're inside it bounces
  // you back to the Dashboard rather than stranding you on a hidden tab.
  const [features, setFeatures] = useState(DEFAULT_FEATURES);
  useEffect(() => {
    if (userId) setFeatures(loadFeatures(userId));
  }, [userId]);

  function handleToggleFeature(key) {
    setFeatures((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try { localStorage.setItem(`forge_features_${userId}`, JSON.stringify(next)); } catch {}
      if (!next[key]) {
        const group = NAV_GROUPS.find((g) => g.feature === key);
        const childKeys = NAV_GROUPS.flatMap((g) => g.children || []).filter((c) => c.feature === key).map((c) => c.key);
        if ((group && group.key === tab) || childKeys.includes(tab)) setTab("home");
      }
      return next;
    });
  }

  // form state
  const [weightInput, setWeightInput] = useState("");
  const [caloriesInput, setCaloriesInput] = useState("");
  const [proteinInput, setProteinInput] = useState("");
  const [carbInput, setCarbInput] = useState("");
  const [fatInput, setFatInput] = useState("");
  const [creatineInput, setCreatineInput] = useState("");
  const [workoutSessions, setWorkoutSessions] = useState([]);
  const [maxAttempts, setMaxAttempts] = useState([]);
  const [customDayPlans, setCustomDayPlans] = useState({});
  const [customSplitTemplates, setCustomSplitTemplates] = useState([]);
  const [weighIns, setWeighIns] = useState({});  // { "2026-07-01": [{id,time,weight,tag},...] }
  const [userSplitId, setUserSplitIdState] = useState(null);
  const [partnerMode, setPartnerMode] = useState(false);
  const [splitStartedOn, setSplitStartedOn] = useState(null);
  const [measurementsInput, setMeasurementsInput] = useState({});
  const [editingName, setEditingName] = useState(false);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState(userName || "");

  useEffect(() => {
    setNameDraft(userName || "");
  }, [userName]);

  useEffect(() => {
    (async () => {
      const [p, e, ws, splitId, splitStart, ma, cdp, cst] = await Promise.all([
        loadProfile(userId), loadEntries(userId),
        loadWorkoutSessions(userId), getUserSplitId(userId), getUserSplitStartedOn(userId),
        loadMaxAttempts(userId), loadCustomDayPlans(userId), loadCustomSplitTemplates(userId),
      ]);
      setProfile(p);
      setEntries(e);
      setWorkoutSessions(ws);
      setUserSplitIdState(splitId);
      setSplitStartedOn(splitStart);
      setMaxAttempts(ma);
      setCustomDayPlans(cdp);
      setCustomSplitTemplates(cst);
      setLoaded(true);
    })();
  }, [userId]);

  // populate form when selected date or entries change
  const justLoadedEntryRef = useRef(false);
  useEffect(() => {
    justLoadedEntryRef.current = true;
    const e = entries[selectedDate];
    if (e) {
      setWeightInput(String(e.weight ?? ""));
      setCaloriesInput(String(e.caloriesConsumed ?? ""));
      setProteinInput(String(e.protein ?? ""));
      setCarbInput(String(e.carbs ?? ""));
      setFatInput(String(e.fat ?? ""));
      setCreatineInput(String(e.creatine ?? ""));
      setMeasurementsInput(e.measurements ?? {});
    } else {
      setWeightInput("");
      setCaloriesInput("");
      setProteinInput("");
      setCarbInput("");
      setFatInput("");
      setCreatineInput("");
      setMeasurementsInput({});
    }
  }, [selectedDate, entries]);

  // Auto-calculate calories from macros — but only when you're actually
  // typing into the macro fields by hand. Without this guard, loading a
  // saved day (or a Food Log sync landing carbs/fat a tick after
  // calories) would re-trigger this and silently overwrite the correct,
  // already-synced calorie total with a recomputed one — exactly the bug
  // that showed 600 cal on screen instead of a real 1,582 cal Food Log
  // total.
  useEffect(() => {
    if (justLoadedEntryRef.current) {
      justLoadedEntryRef.current = false;
      return;
    }
    const p = parseFloat(proteinInput) || 0;
    const c = parseFloat(carbInput) || 0;
    const f = parseFloat(fatInput) || 0;
    if (p > 0 || c > 0 || f > 0) {
      const computed = Math.round(p * 4 + c * 4 + f * 9);
      setCaloriesInput(String(computed));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proteinInput, carbInput, fatInput]);

  const sortedDates = useMemo(() => Object.keys(entries).sort(), [entries]);
  const latestDate = sortedDates[sortedDates.length - 1];
  const latestEntry = latestDate ? entries[latestDate] : null;

  const liveWeight = parseFloat(weightInput) || latestEntry?.weight || FALLBACK_WEIGHT_ESTIMATE_LBS;
  const liveStats = useMemo(
    () => computeStats(profile, liveWeight, { neckIn: latestMeasurement(entries, "neck"), waistIn: latestMeasurement(entries, "waist") }),
    [profile, liveWeight, entries]
  );
  const liveConsumed = parseFloat(caloriesInput) || 0;
  const liveBalance = liveConsumed - liveStats.tdee;


  const mealsForSelectedDate = entries[selectedDate]?.meals ?? [];
  const weighInsForDate = (date) => entries[date]?.weigh_ins ?? [];
  const waterLogsForDate = (date) => entries[date]?.water_logs ?? [];

  // Merges a partial update into whatever's already saved for a date
  // (so saving meals doesn't clobber weight/macros and vice versa),
  // updates local state optimistically, then persists the merged row.
  // saveStatus drives the Saving.../Saved indicator in LogEntry — it's
  // set synchronously (before the await) so the UI reacts immediately,
  // not after the network round-trip.
  async function mergeAndSaveEntry(date, partial) {
    const existing = entries[date] || {};
    const merged = { ...existing, ...partial };
    const next = { ...entries, [date]: merged };
    setEntries(next);
    setSaveStatus("saving");
    try {
      await saveEntry(userId, date, merged);
      setSaveStatus("saved");
    } finally {
      clearTimeout(saveStatusTimeout.current);
      saveStatusTimeout.current = setTimeout(() => setSaveStatus("idle"), 2000);
    }
    return merged;
  }

  // Counterpart to Export your data (CSV) in Settings. The export is
  // intentionally lossy for two columns — "Weigh-ins" and "Meals logged"
  // are counts, not the underlying records — so import only restores the
  // day-level fields that actually round-trip: weight, calories, macros,
  // creatine, body fat %, and a single water total. It merges into
  // whatever's already saved for each date rather than replacing it, so
  // existing measurements/weigh-ins/meals for that day are untouched —
  // only the fields present in the CSV change. Optimistic update first
  // (immediate feedback for a bulk operation), persisted in parallel.
  async function handleImportCsv(rows) {
    const next = { ...entries };
    for (const row of rows) {
      const existing = next[row.date] || {};
      const partial = {};
      if (row.weight != null) partial.weight = row.weight;
      if (row.caloriesConsumed != null) partial.caloriesConsumed = row.caloriesConsumed;
      if (row.protein != null) partial.protein = row.protein;
      if (row.carbs != null) partial.carbs = row.carbs;
      if (row.fat != null) partial.fat = row.fat;
      if (row.creatine != null) partial.creatine = row.creatine;
      if (row.bodyFatPct != null) partial.bodyFatPct = row.bodyFatPct;
      if (row.waterOz != null) {
        partial.water_logs = [{
          id: (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          time: null, amountOz: row.waterOz, imported: true,
        }];
      }
      next[row.date] = { ...existing, ...partial };
    }
    setEntries(next);
    await Promise.all(rows.map(row => saveEntry(userId, row.date, next[row.date])));
  }

  async function handleSaveCustomDayPlan(plan) {
    const saved = await saveCustomDayPlan(userId, plan);
    if (saved) setCustomDayPlans(prev => ({ ...prev, [plan.date]: saved }));
  }
  async function handleDeleteCustomDayPlan(date) {
    setCustomDayPlans(prev => { const next = { ...prev }; delete next[date]; return next; });
    await deleteCustomDayPlan(userId, date);
  }
  async function handleSaveCustomSplitTemplate(template) {
    const saved = await saveCustomSplitTemplate(userId, template);
    if (saved) setCustomSplitTemplates(prev => [...prev, saved]);
  }
  async function handleDeleteCustomSplitTemplate(id) {
    setCustomSplitTemplates(prev => prev.filter(t => t.id !== id));
    await deleteCustomSplitTemplate(userId, id);
  }

  async function handleSave() {
    if (!weightInput || !caloriesInput) return;
    const weight = clampPositive(weightInput);
    const stats = computeStats(profile, weight, { neckIn: latestMeasurement(entries, "neck"), waistIn: latestMeasurement(entries, "waist") });
    const merged = await mergeAndSaveEntry(selectedDate, {
      weight,
      caloriesConsumed: clampPositive(caloriesInput),
      protein: clampPositive(proteinInput),
      carbs: clampPositive(carbInput),
      fat: clampPositive(fatInput),
      creatine: clampPositive(creatineInput),
      bodyFatPct: stats.bodyFatPct,
      fatLbs: stats.fatLbs,
      suggestedCalories: stats.suggestedCalories,
    });
    maybeAutoUpdateAdaptiveTdee({ ...entries, [selectedDate]: merged });
  }

  async function handleDelete(date) {
    const next = { ...entries };
    delete next[date];
    setEntries(next);
    await deleteEntry(userId, date);
  }

  // Accepts either (field, value) for a single change, or a single object
  // of { field: value, ... } for multiple fields that need to land in the
  // same update — e.g. changing goalType while also clearing stale start
  // dates. Calling this three times in a row for three fields wouldn't
  // work correctly: each call closes over the same pre-update `profile`,
  // so only the last call's change would actually stick.
  // Called after any save that touches today's weight. Recalculating on
  // every single save was the bug: a rolling 14-day window shifts by one
  // day each time you log, and normal day-to-day weight noise (water,
  // sodium, glycogen) is enough to nudge the computed number — so an
  // active daily logger saw their "adopted" TDEE silently rewritten
  // almost every day, which defeats the whole point of a frozen,
  // deliberately-adopted number. A 72-hour cooldown (gated on
  // adaptiveTdeeUpdatedAt, a precise timestamp — adaptiveTdeeSetOn is
  // date-only and only for display) still lets the number track a real
  // trend without chasing daily wobble. Manual "Update to latest" always
  // bypasses this, since that's a deliberate action, not an automatic one.
  const AUTO_TDEE_COOLDOWN_MS = 72 * 60 * 60 * 1000;
  // 40% is the same threshold the UI itself calls "Building confidence"
  // rather than "Still calibrating" — below that, the estimate is
  // usually just a handful of days, easily distorted by returning from
  // a gap in logging (a few post-break days can swing wildly on their
  // own). Confirmed in testing: a 21-day logging gap followed by 5
  // realistic post-break days produced a 5,364-cal estimate at 14%
  // confidence, which — before this check — would have silently
  // overwritten a 100%-confidence, 60-day-established adopted value of
  // 2,498 with no warning beyond a toast claiming success. Manual
  // "Update to latest" still bypasses this entirely, since tapping that
  // button IS the informed choice to accept whatever's showing right
  // now, confidence included — this only guards the automatic path.
  const AUTO_TDEE_MIN_CONFIDENCE = 40;
  function maybeAutoUpdateAdaptiveTdee(nextEntries) {
    if (profile.adaptiveTdee == null) return; // feature not active
    const lastUpdateMs = profile.adaptiveTdeeUpdatedAt ? new Date(profile.adaptiveTdeeUpdatedAt).getTime() : 0;
    if (Date.now() - lastUpdateMs < AUTO_TDEE_COOLDOWN_MS) return; // too soon — wait out the cooldown
    const result = computeAdaptiveTDEE(nextEntries, profile.goalType);
    if (!result.ready || result.confidence < AUTO_TDEE_MIN_CONFIDENCE) return;
    const newTdee = Math.round(result.tdee);
    if (newTdee === Math.round(profile.adaptiveTdee)) return; // no real change
    handleProfileChange({ adaptiveTdee: newTdee, adaptiveTdeeSetOn: todayStr(), adaptiveTdeeUpdatedAt: new Date().toISOString() });
    toastSuccess(`Adaptive TDEE updated to ${fmt(newTdee)} cal based on your logged data`);
  }

  async function handleProfileChange(fieldOrPatch, value) {
    const patch = typeof fieldOrPatch === "object" && fieldOrPatch !== null ? fieldOrPatch : { [fieldOrPatch]: value };
    const next = { ...profile, ...patch };
    setProfile(next);
    await saveProfile(userId, next);
  }

  // ---- Daily Food Log — auto-syncs totals to calories/protein ----
  function mealTotals(list) {
    return {
      cal: list.reduce((s, m) => s + (parseFloat(m.calories) || 0), 0),
      prot: list.reduce((s, m) => s + (parseFloat(m.protein) || 0), 0),
      carb: list.reduce((s, m) => s + (parseFloat(m.carbs) || 0), 0),
      fatG: list.reduce((s, m) => s + (parseFloat(m.fat) || 0), 0),
    };
  }
  function syncMealInputs(list) {
    const { cal, prot, carb, fatG } = mealTotals(list);
    setCaloriesInput(String(Math.round(cal)));
    setProteinInput(String(Math.round(prot)));
    setCarbInput(String(Math.round(carb)));
    setFatInput(String(Math.round(fatG)));
  }
  async function addMeal(meal) {
    const list = [...mealsForSelectedDate, { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, ...meal }];
    const { cal, prot, carb, fatG } = mealTotals(list);
    const updates = { meals: list, caloriesConsumed: cal, protein: prot, carbs: carb, fat: fatG };
    await mergeAndSaveEntry(selectedDate, updates);
    syncMealInputs(list);
  }
  async function updateMeal(id, changes) {
    const list = mealsForSelectedDate.map((m) => (m.id === id ? { ...m, ...changes } : m));
    const { cal, prot, carb, fatG } = mealTotals(list);
    // Always write the real computed totals — including zero. Skipping
    // zero here was the bug: editing a meal down to genuinely 0 of
    // something left the entry's old, now-stale value in place instead
    // of reflecting the edit.
    const updates = { meals: list, caloriesConsumed: cal, protein: prot, carbs: carb, fat: fatG };
    await mergeAndSaveEntry(selectedDate, updates);
    syncMealInputs(list);
  }
  async function deleteMeal(id) {
    const removed = mealsForSelectedDate.find((m) => m.id === id);
    const list = mealsForSelectedDate.filter((m) => m.id !== id);
    const { cal, prot, carb, fatG } = mealTotals(list);
    // Always write the real computed totals, including zero — same fix
    // as addMeal/updateMeal. The list.length===0 special case is now
    // redundant (mealTotals of an empty list is already 0/0/0/0) but
    // left explicit for clarity.
    const updates = list.length === 0
      ? { meals: list, caloriesConsumed: 0, protein: 0, carbs: 0, fat: 0 }
      : { meals: list, caloriesConsumed: cal, protein: prot, carbs: carb, fat: fatG };
    await mergeAndSaveEntry(selectedDate, updates);
    syncMealInputs(list);
    if (removed) {
      toastUndo(`Deleted "${removed.label}"`, { label: "Undo", onClick: () => addMeal(removed) });
    }
  }
  function applyMealTotals() {
    syncMealInputs(mealsForSelectedDate);
  }

  // ---- Split selection ----
  async function handleSplitChange(splitId) {
    setUserSplitIdState(splitId);
    setSplitStartedOn(todayStr());
    // setUserSplitId is already called inside LiftingSchedule on selection
  }

  // ---- Measurements ----
  async function saveMeasurements(values) {
    await mergeAndSaveEntry(selectedDate, { measurements: values });
  }
  async function deleteMeasurements(date) {
    await mergeAndSaveEntry(date, { measurements: {} });
  }

  // ---- Rename current user ----
  // ── Weigh-In ────────────────────────────────────────────────────────
  async function addWeighIn(date, entry) {
    // entry = { id, time, weight, tag }
    const list = [...(entries[date]?.weigh_ins ?? []), entry];
    // The official weight should be whichever reading is chronologically
    // latest, not necessarily the one just added — backfilling an
    // earlier-in-the-day reading after a later one is normal, and
    // shouldn't overwrite the more recent official weight.
    const sorted = [...list].sort((a, b) => a.time.localeCompare(b.time));
    const officialWeight = parseFloat(sorted[sorted.length - 1].weight);
    const merged = await mergeAndSaveEntry(date, { weigh_ins: list, weight: officialWeight });
    maybeAutoUpdateAdaptiveTdee({ ...entries, [date]: merged });
  }

  async function deleteWeighIn(date, id) {
    const removed = (entries[date]?.weigh_ins ?? []).find(w => w.id === id);
    const list = (entries[date]?.weigh_ins ?? []).filter(w => w.id !== id);
    // Sort by actual time before picking "latest" — weigh-ins aren't
    // always logged in chronological order (backfilling an earlier
    // reading after a later one is normal), so the last item in the
    // array isn't reliably the most recent by clock time.
    const sorted = [...list].sort((a, b) => a.time.localeCompare(b.time));
    const newWeight = sorted.length > 0 ? parseFloat(sorted[sorted.length - 1].weight) : null;
    const patch = { weigh_ins: list };
    if (newWeight) patch.weight = newWeight;
    const merged = await mergeAndSaveEntry(date, patch);
    maybeAutoUpdateAdaptiveTdee({ ...entries, [date]: merged });
    if (removed) {
      toastUndo(`Deleted ${fmt(removed.weight, 1)} lbs weigh-in`, { label: "Undo", onClick: () => addWeighIn(date, removed) });
    }
  }

  // ── Water log ─────────────────────────────────────────────────────
  async function addWaterLog(date, entry) {
    // entry = { id, time, amountOz }
    const list = [...(entries[date]?.water_logs ?? []), entry];
    await mergeAndSaveEntry(date, { water_logs: list });
  }
  async function deleteWaterLog(date, id) {
    const removed = (entries[date]?.water_logs ?? []).find(w => w.id === id);
    const list = (entries[date]?.water_logs ?? []).filter(w => w.id !== id);
    await mergeAndSaveEntry(date, { water_logs: list });
    if (removed) {
      toastUndo(`Deleted ${fmt(removed.amountOz)} oz water log`, { label: "Undo", onClick: () => addWaterLog(date, removed) });
    }
  }

  async function handleRenameUser(newName) {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === userName) return;
    await renameUser(userId, trimmed);
    onRenameUser(trimmed);
  }

  const chartData = useMemo(() => {
    return sortedDates.map((d) => {
      const e = entries[d];
      const stats = computeStats(profile, e.weight);
      return {
        date: d,
        label: prettyDate(d).split(",")[0] + " " + d.slice(8),
        weight: e.weight,
        balance: Math.round(e.caloriesConsumed - stats.tdee),
        caloriesConsumed: e.caloriesConsumed,
        tdee: Math.round(stats.tdee),
        bodyFatPct: Math.round((e.bodyFatPct ?? stats.bodyFatPct) * 100) / 100,
        fatLbs: Math.round((e.fatLbs ?? stats.fatLbs) * 100) / 100,
        suggestedCalories: Math.round(e.suggestedCalories ?? stats.suggestedCalories),
        waterOz: Math.round((e.water_logs || []).reduce((s, w) => s + (parseFloat(w.amountOz) || 0), 0)),
        waterGoalOz: Math.round(computeWaterGoalOz(profile, e.weight, (e.creatine || 0) > 0, computeCreatineSaturation(entries, 28, profile.creatineAlreadySaturated, d).pct)),
      };
    });
  }, [entries, profile, sortedDates]);

  // Which top-level nav group the current tab belongs to (drives both the
  // primary row's highlight and whether a secondary sub-tab row shows).
  // Groups and sub-tabs whose feature is toggled off in Settings are
  // filtered out of the nav entirely.
  const visibleNavGroups = NAV_GROUPS
    .filter((g) => !g.feature || features[g.feature])
    .map((g) => g.children ? { ...g, children: g.children.filter((c) => !c.feature || features[c.feature]) } : g);
  const activeGroup = visibleNavGroups.find((g) =>
    g.children ? g.children.some((c) => c.key === tab) : g.key === tab
  ) || visibleNavGroups[0];

  if (!loaded) {
    return (
      <div className="ft-app" style={{ padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <SkeletonBlock width={38} height={38} style={{ borderRadius: 10 }} />
          <SkeletonBlock width={140} height={22} />
        </div>
        <div style={{ display: "flex", gap: 18, marginBottom: 20 }}>
          {Array.from({ length: 4 }).map((_, i) => <SkeletonBlock key={i} width={70} height={14} />)}
        </div>
        <DashboardSkeleton />
      </div>
    );
  }

  return (
    <div className="ft-app" style={{ padding: 20, paddingBottom: 100, borderRadius: 18 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14, flexWrap: "wrap", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 38, height: 38, borderRadius: 10, background: GRAD_MAIN, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 4px 14px rgba(43,230,168,0.3)" }}>
            <Flame size={20} color="#0A1E27" />
          </div>
          <div className="ft-display" style={{ fontSize: 26, lineHeight: 1 }}>FORGE LOG</div>
        </div>

        {/* Compact profile menu — avatar + name, tap to reveal rename / switch user */}
        <div style={{ position: "relative" }}>
          <button
            onClick={() => setProfileMenuOpen((o) => !o)}
            style={{
              display: "flex", alignItems: "center", gap: 7, background: COLORS.surfaceRaised,
              border: `1px solid ${COLORS.border}`, borderRadius: 999, padding: "5px 12px 5px 5px", cursor: "pointer",
            }}
          >
            {avatarData ? (
              <img src={avatarData} alt="" style={{ width: 24, height: 24, borderRadius: "50%", objectFit: "cover" }} />
            ) : (
              <div style={{ width: 24, height: 24, borderRadius: "50%", background: COLORS.ember, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "#1a0e08" }}>
                {(userName || "?").charAt(0).toUpperCase()}
              </div>
            )}
            <span style={{ fontSize: 12, fontWeight: 600, color: COLORS.cream }}>{userName || "…"}</span>
            <ChevronDown size={13} color={COLORS.creamDim} />
          </button>

          {profileMenuOpen && (
            <>
              <div style={{ position: "fixed", inset: 0, zIndex: 99 }} onClick={() => setProfileMenuOpen(false)} />
              <div
                className="ft-card"
                style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, minWidth: 200, padding: 8, zIndex: 100 }}
              >
                {editingName ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 4, padding: 4 }}>
                    <input
                      className="ft-input"
                      style={{ flex: 1, padding: "5px 8px", fontSize: 12 }}
                      value={nameDraft}
                      autoFocus
                      onChange={(e) => setNameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { handleRenameUser(nameDraft); setEditingName(false); setProfileMenuOpen(false); }
                        else if (e.key === "Escape") setEditingName(false);
                      }}
                    />
                    <button className="ft-btn ft-btn-ghost" style={{ padding: "5px 7px" }} onClick={() => { handleRenameUser(nameDraft); setEditingName(false); setProfileMenuOpen(false); }} title="Save name">
                      <Check size={12} />
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setEditingName(true)}
                    style={{ width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: "none", border: "none", borderRadius: 8, color: COLORS.cream, fontSize: 13, cursor: "pointer" }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = COLORS.surfaceRaised)}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
                  >
                    <Pencil size={13} color={COLORS.creamDim} /> Rename
                  </button>
                )}
                <button
                  onClick={() => { setProfileMenuOpen(false); onSwitchUser(); }}
                  style={{ width: "100%", textAlign: "left", display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: "none", border: "none", borderRadius: 8, color: COLORS.cream, fontSize: 13, cursor: "pointer" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = COLORS.surfaceRaised)}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
                >
                  <LogOut size={13} color={COLORS.creamDim} /> Switch user
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Bottom nav — floating pill, replacing the old top tab row.
          Gold is scoped to only this element (see .ft-nav-primary in
          GlobalStyle) — nowhere else in the app uses it. */}
      <div className="ft-nav">
        {activeGroup.children && (
          <div className="ft-nav-sub">
            {activeGroup.children.map((child) => (
              <button
                key={child.key}
                className={`ft-nav-sub-item ${tab === child.key ? "active" : ""}`}
                onClick={() => setTab(child.key)}
              >
                {child.label}
              </button>
            ))}
          </div>
        )}
        <div className="ft-nav-primary">
          {visibleNavGroups.map((group) => (
            <button
              key={group.key}
              className={`ft-nav-item ${activeGroup.key === group.key ? "active" : ""}`}
              aria-label={group.label}
              onClick={() => {
                if (group.children) {
                  const alreadyActive = group.children.some((c) => c.key === tab);
                  if (!alreadyActive) setTab(group.children[0].key);
                } else {
                  setTab(group.key);
                }
              }}
            >
              {group.icon}
              <span>{group.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div key={tab} className="ft-tab-panel" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Home now IS the detailed dashboard (previously "Log > Today" was
          a separate destination from a plain Home launcher — merged per
          design review so weight/calories/coach note are the first thing
          you see, not a tile grid pointing elsewhere). */}
      {tab === "home" && (
        <Dashboard
          entries={entries}
          sortedDates={sortedDates}
          latestDate={latestDate}
          profile={profile}
          chartData={chartData}
          workoutSessions={features.train ? workoutSessions : []}
          userSplitId={userSplitId}
          splitStartedOn={splitStartedOn}
          features={features}
          setTab={setTab}
          userId={userId}
        />
      )}

      {tab === "log" && (
        <LogEntry
          selectedDate={selectedDate}
          setSelectedDate={setSelectedDate}
          weightInput={weightInput}
          setWeightInput={setWeightInput}
          caloriesInput={caloriesInput}
          setCaloriesInput={setCaloriesInput}
          proteinInput={proteinInput}
          setProteinInput={setProteinInput}
          carbInput={carbInput}
          setCarbInput={setCarbInput}
          fatInput={fatInput}
          setFatInput={setFatInput}
          creatineInput={creatineInput}
          setCreatineInput={setCreatineInput}
          liveStats={liveStats}
          liveBalance={liveBalance}
          handleSave={handleSave}
          entries={entries}
          handleDelete={handleDelete}
          gender={profile.gender}
          profile={profile}
          onProfileChange={handleProfileChange}
          mealsToday={mealsForSelectedDate}
          setTab={setTab}
          saveStatus={saveStatus}
        />
      )}

      {tab === "food" && (
        <FoodLogTab
          userId={userId}
          selectedDate={selectedDate}
          setSelectedDate={setSelectedDate}
          meals={mealsForSelectedDate}
          addMeal={addMeal}
          updateMeal={updateMeal}
          deleteMeal={deleteMeal}
          applyMealTotals={applyMealTotals}
          entries={entries}
        />
      )}

      {tab === "weighin" && (
        <WeighInTab
          entries={entries}
          weighInsForDate={weighInsForDate}
          onAdd={addWeighIn}
          onDelete={deleteWeighIn}
        />
      )}

      {tab === "water" && (
        <WaterLogTab
          entries={entries}
          waterLogsForDate={waterLogsForDate}
          onAdd={addWaterLog}
          onDelete={deleteWaterLog}
          profile={profile}
          latestWeight={latestEntry?.weight ?? null}
          onProfileChange={handleProfileChange}
        />
      )}

      {tab === "measurements" && (
        <MeasurementsTab
          selectedDate={selectedDate}
          setSelectedDate={setSelectedDate}
          measurementsInput={measurementsInput}
          setMeasurementsInput={setMeasurementsInput}
          onSave={saveMeasurements}
          onDelete={deleteMeasurements}
          entries={entries}
        />
      )}

      {(tab === "trainDay" || tab === "splitInfo") && !partnerMode && (
        <>
          {tab === "trainDay" && (
            <button
              className="ft-btn ft-btn-ghost"
              style={{ marginBottom: 12, fontSize: 12 }}
              onClick={() => setPartnerMode(true)}
            >
              <Users size={13} /> Train with a partner
            </button>
          )}
          <SplitDashboard
            userId={userId}
            userSplitId={userSplitId}
            splitStartedOn={splitStartedOn}
            onSplitChange={handleSplitChange}
            workoutSessions={workoutSessions}
            setWorkoutSessions={setWorkoutSessions}
            latestWeight={latestEntry?.weight ?? null}
            gender={profile.gender}
            subTab={tab}
            setTab={setTab}
            dedicatedProgressiveOverload={profile.dedicatedProgressiveOverload}
            customDayPlans={customDayPlans}
            onSaveCustomDayPlan={handleSaveCustomDayPlan}
            onDeleteCustomDayPlan={handleDeleteCustomDayPlan}
            customSplitTemplates={customSplitTemplates}
            onSaveCustomSplitTemplate={handleSaveCustomSplitTemplate}
            onDeleteCustomSplitTemplate={handleDeleteCustomSplitTemplate}
          />
        </>
      )}

      {tab === "trainDay" && partnerMode && (
        <PartnerTraining
          userId={userId}
          userName={userName}
          userSplitId={userSplitId}
          splitStartedOn={splitStartedOn}
          workoutSessions={workoutSessions}
          setWorkoutSessions={setWorkoutSessions}
          latestWeight={latestEntry?.weight ?? null}
          gender={profile.gender}
          dedicatedProgressiveOverload={profile.dedicatedProgressiveOverload}
          onSplitChange={handleSplitChange}
          onExit={() => setPartnerMode(false)}
        />
      )}

      {tab === "setCoverage" && <SetCoverageTab workoutSessions={workoutSessions} profile={profile} onProfileChange={handleProfileChange} />}

      {tab === "maxTracker" && <MaxTrackerTab userId={userId} maxAttempts={maxAttempts} setMaxAttempts={setMaxAttempts} latestWeight={latestEntry?.weight ?? null} gender={profile.gender} profile={profile} onProfileChange={handleProfileChange} />}

      {tab === "trends" && <Trends chartData={chartData} workoutSessions={workoutSessions} showLifts={features.train} showWater={features.water} profile={profile} />}

      {tab === "settings" && <SettingsPanel profile={profile} onChange={handleProfileChange} latestWeight={latestEntry?.weight ?? null} features={features} onToggleFeature={handleToggleFeature} entries={entries} onImportCsv={handleImportCsv} userId={userId} />}
      </div>
    </div>

  );
}

/* ---------------------------------------------------------------
   Top-level App — gates on user selection before showing MainApp.
   No passwords: the chosen user_id is just remembered in localStorage
   on this device. Anyone with the URL can pick any user.
----------------------------------------------------------------*/

/* ---------------------------------------------------------------
   Offline banner — shows when the browser has no connection, or
   when there are queued writes waiting to sync once it's back.
   Sits fixed at the top so it's visible regardless of which tab
   you're on.
----------------------------------------------------------------*/

function OfflineBanner() {
  const [online, setOnline] = useState(isOnline());
  const [queueSize, setQueueSize] = useState(0);
  const [syncError, setSyncError] = useState(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const prevQueueSize = useRef(0);

  useEffect(() => {
    const updateOnline = () => setOnline(isOnline());
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    const unsub = onQueueChange((size) => {
      // Went from "had queued changes" to "fully synced" — confirm it
      // landed rather than just silently making the banner disappear.
      if (prevQueueSize.current > 0 && size === 0) {
        toastSuccess("All changes synced");
      }
      prevQueueSize.current = size;
      setQueueSize(size);
    });
    const unsubErr = onQueueError(setSyncError);
    return () => {
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
      unsub();
      unsubErr();
    };
  }, []);

  if (online && queueSize === 0) return null;

  const offline = !online;
  // Online, changes queued, but the last retry actually failed (not just
  // "haven't tried yet") — this is the "stuck" case: spinning forever
  // with no explanation is worse than telling the person what's wrong
  // and giving them a way out.
  const stuck = online && queueSize > 0 && !!syncError;

  function handleDiscard() {
    if (!window.confirm(
      `Discard ${queueSize} unsynced change${queueSize !== 1 ? "s" : ""}? ` +
      `They'll stay visible on this device but won't be saved to the ` +
      `database, so other devices won't see them.`
    )) return;
    clearQueue();
    setDetailsOpen(false);
  }

  return (
    <div
      style={{
        position: "sticky", top: 0, zIndex: 500,
        display: "flex", flexDirection: "column", alignItems: "stretch",
        fontSize: 12, fontWeight: 600,
        background: offline ? "#5A2E2E" : stuck ? "#5A2E2E" : "#2A3552",
        color: offline ? COLORS.danger : stuck ? COLORS.danger : COLORS.amber,
      }}
    >
      <div
        onClick={stuck ? () => setDetailsOpen((o) => !o) : undefined}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
          padding: "7px 12px", cursor: stuck ? "pointer" : "default",
        }}
      >
        {offline ? (
          <>
            <WifiOff size={13} /> You're offline — changes will save and sync automatically once you're back
          </>
        ) : stuck ? (
          <>
            <AlertCircle size={13} />
            Sync stuck on {queueSize} change{queueSize !== 1 ? "s" : ""} — tap for details
            <ChevronDown size={13} style={{ transform: detailsOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
          </>
        ) : (
          <>
            <RefreshCw size={13} style={{ animation: "spin 1.2s linear infinite" }} />
            Syncing {queueSize} pending change{queueSize !== 1 ? "s" : ""}…
          </>
        )}
      </div>
      {stuck && detailsOpen && (
        <div style={{ padding: "0 12px 10px", textAlign: "center", fontWeight: 400 }}>
          <div style={{ fontSize: 11, opacity: 0.85, marginBottom: 8 }}>
            Last error ({syncError.type}): {syncError.message}
          </div>
          <div style={{ fontSize: 11, opacity: 0.85, marginBottom: 8 }}>
            This usually means either your Supabase project needs attention
            (e.g. a free-tier project that's paused from inactivity) or one
            queued change has bad data it can't save. It'll keep retrying
            automatically — but if it's genuinely stuck, you can discard the
            queue below. Nothing on this device is lost either way.
          </div>
          <button className="ft-btn ft-btn-danger" style={{ display: "inline-flex" }} onClick={handleDiscard}>
            Discard queued changes
          </button>
        </div>
      )}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

export default function App() {
  const [userId, setUserId] = useState(() => getCurrentUserId());
  const [userName, setUserName] = useState(null);
  const [avatarData, setAvatarData] = useState(null);

  // Offline reliability: flush any queued writes as soon as the browser
  // reports it's back online, and also on a timer as a fallback since the
  // 'online' event doesn't fire reliably on every mobile browser. A flush
  // is also attempted once on load, in case writes queued up on a previous
  // visit while offline.
  useEffect(() => {
    const flush = () => flushQueue(offlineExecutors);
    flush();
    window.addEventListener("online", flush);
    const interval = setInterval(flush, 30000);
    return () => {
      window.removeEventListener("online", flush);
      clearInterval(interval);
    };
  }, []);

  // If we already have a userId (returning visit via localStorage), fetch
  // their current name/photo on load — handles the case where they were
  // renamed or re-photographed from another device.
  useEffect(() => {
    if (!userId) {
      setUserName(null);
      setAvatarData(null);
      return;
    }
    (async () => {
      const u = await fetchUserById(userId);
      setUserName(u?.name ?? null);
      setAvatarData(u?.avatar_data ?? null);
    })();
  }, [userId]);

  function handleUserSelected(user) {
    setUserId(user.id);
    setUserName(user.name);
    setAvatarData(user.avatar_data ?? null);
  }

  function handleSwitchUser() {
    clearCurrentUserId();
    setUserId(null);
    setUserName(null);
    setAvatarData(null);
  }

  function handleRenameUser(newName) {
    setUserName(newName);
  }

  return (
    <div className="ft-app">
      <GlobalStyle />
      <OfflineBanner />
      <ToastStack />
      {!userId ? (
        <UserSelect onSelect={handleUserSelected} />
      ) : (
        <MainApp
          key={userId}
          userId={userId}
          userName={userName}
          avatarData={avatarData}
          onSwitchUser={handleSwitchUser}
          onRenameUser={handleRenameUser}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------
   Dashboard
----------------------------------------------------------------*/


// ── Coach's note — rotating, data-grounded tips ────────────────────
// Builds a list of real observations from data already computed for
// the Dashboard (progression suggestions, attendance grade, calorie
// balance, weight trend, protein pace) instead of one static message.
function buildCoachNotes({ e, stats, balance, avgBalance, weightDelta, proteinPct, workoutSessions, userSplitId, splitStartedOn, entries, profile, features, latestWeight }) {
  const notes = [];

  // Most recently trained exercise's real progression suggestion.
  if (workoutSessions && workoutSessions.length) {
    const byExercise = {};
    workoutSessions.forEach((s) => { (byExercise[s.exercise] ||= []).push(s); });
    const entries2 = Object.entries(byExercise).sort((a, b) => {
      const aLast = a[1][a[1].length - 1]?.date || "";
      const bLast = b[1][b[1].length - 1]?.date || "";
      return bLast.localeCompare(aLast);
    });
    if (entries2.length) {
      const [exName, sessions] = entries2[0];
      const sorted = [...sessions].sort((a, b) => a.date.localeCompare(b.date));
      const sugg = getProgressionSuggestion(sorted, sorted[sorted.length - 1].group, exName, null, profile.dedicatedProgressiveOverload);
      if (sugg) {
        notes.push({ body: <><b>{exName}</b> — {sugg.msg}</>, target: "trainDay", cta: "View training" });
      }
    }
  }

  const grade = calcAttendanceGrade(userSplitId, workoutSessions || [], splitStartedOn);
  const rawGrade = calcRawAttendanceGrade(workoutSessions || []);
  const tierRank = { "A+": 4, A: 3, B: 2, C: 1, D: 0 };
  if (grade && rawGrade && tierRank[rawGrade.grade] > tierRank[grade.grade]) {
    // Split grade looks worse than overall consistency — most likely a
    // recent split switch. Leading with "D" here would flatly contradict
    // what the Dashboard's own consistency card says right below it.
    notes.push({
      body: <>You've logged <b>{rawGrade.actual} of the last {rawGrade.windowDays}</b> days training — solid overall consistency, even though your grade for this specific split is still catching up.</>,
      target: "trainDay", cta: "View training",
    });
  } else if (grade) {
    notes.push({
      body: <>Training grade this month is <b>{grade.grade}</b> — {grade.actual} of {grade.expected} sessions logged in the last 28 days.</>,
      target: "trainDay", cta: "View training",
    });
  }

  if (balance != null && !Number.isNaN(balance)) {
    notes.push({
      body: <>Today's balance is <b>{balancePhrase(balance)}</b>{avgBalance ? <> — averaging <b>{balancePhrase(avgBalance, "cal/day")}</b> this week.</> : "."}</>,
      target: "trends", cta: "View trends",
    });
  }

  if (weightDelta) {
    notes.push({
      body: <>Weight has moved <b>{weightDelta > 0 ? "+" : ""}{fmt(weightDelta, 1)} lbs</b> over the last 7 days.</>,
      target: "trends", cta: "View trends",
    });
  }

  if (e && stats && stats.proteinG) {
    notes.push({
      body: proteinPct >= 90
        ? <>Protein is at <b>{fmt(proteinPct, 0)}%</b> of target today — right on pace.</>
        : <>Protein is at <b>{fmt(proteinPct, 0)}%</b> of target today. A bit more at your next meal closes the gap.</>,
      target: "log", cta: "Log today",
    });
  }

  // Set Coverage — only once there's some real training history, so a
  // brand-new profile doesn't immediately get told every muscle group is
  // neglected. 4 sets/week is the low end of what research generally
  // considers a minimum threshold for hypertrophy, not a hard line.
  if (features?.train && workoutSessions?.length >= 5) {
    const coverage = computeSetCoverage(workoutSessions, ANATOMICAL_GROUPS);
    const lowest = coverage.reduce((min, c) => (c.sets < min.sets ? c : min), coverage[0]);
    if (lowest && lowest.sets < 4) {
      notes.push({
        body: <><b>{lowest.group}</b> has only had {lowest.sets} set{lowest.sets !== 1 ? "s" : ""} in the last 7 days — worth adding some direct work if that's not intentional.</>,
        target: "setCoverage", cta: "View coverage",
      });
    }
  }

  // Water — only once a goal actually exists to compare against.
  if (features?.water && entries) {
    const tookCreatineToday = (e?.creatine || 0) > 0;
    const satPct = computeCreatineSaturation(entries, 28, profile?.creatineAlreadySaturated).pct;
    const goalOz = computeWaterGoalOz(profile, latestWeight, tookCreatineToday, satPct);
    const todayWaterOz = (e?.water_logs || []).reduce((s, w) => s + (parseFloat(w.amountOz) || 0), 0);
    const hour = new Date().getHours();
    // Only flag it as behind pace later in the day — mentioning this at
    // 9am when nobody's had a chance to drink anything yet isn't useful.
    if (hour >= 15 && goalOz > 0 && todayWaterOz < goalOz * 0.5) {
      notes.push({
        body: <>Water is at <b>{fmt(todayWaterOz)} of {fmt(goalOz)} oz</b> today — a good time to catch up if you haven't been sipping much.</>,
        target: "water", cta: "Log water",
      });
    }
  }

  // Creatine — only for someone actually using it, encouraging the
  // consistency that gets them to full saturation.
  if (entries) {
    const usesCreatine = Object.values(entries).some(x => (x.creatine || 0) > 0);
    if (usesCreatine && !profile?.creatineAlreadySaturated) {
      const sat = computeCreatineSaturation(entries, 28, false);
      if (sat.pct < 90 && sat.pct > 0) {
        notes.push({
          body: <>Creatine saturation is at <b>{sat.pct}%</b> ({sat.label.toLowerCase()}) — staying consistent day to day gets you to full effect faster.</>,
          target: "log", cta: "Log today",
        });
      }
    }
  }

  // Adaptive Body Fat — a one-time nudge once someone's actually logged
  // enough to use it, rather than something they'd have to stumble onto
  // in Settings on their own.
  if (profile?.gender === "male" && !profile?.useAdaptiveBodyFat && entries) {
    const neckIn = latestMeasurement(entries, "neck");
    const waistIn = latestMeasurement(entries, "waist");
    if (neckIn && waistIn) {
      notes.push({
        body: <>You've logged enough measurements for a more accurate body fat % estimate — the formula-only default can't tell a muscular build from a fat one at the same BMI.</>,
        target: "settings", cta: "View settings",
      });
    }
  }

  return notes.length ? notes : [{ body: <>Log a few more days and patterns worth calling out will start showing up here.</>, target: "log", cta: "Log today" }];
}

function CoachBot({ size = 30 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 30 30" className="ft-sway" style={{ transformOrigin: "15px 28px" }}>
      <defs>
        <linearGradient id="botGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={COLORS.ember} />
          <stop offset="100%" stopColor={COLORS.mint} />
        </linearGradient>
      </defs>
      <circle cx="15" cy="16" r="12" fill="url(#botGrad)" />
      <circle cx="15" cy="4" r="1.6" fill={COLORS.blueBright} />
      <line x1="15" y1="5.4" x2="15" y2="8.5" stroke={COLORS.blueBright} strokeWidth="1.4" />
      <circle className="ft-blink" cx="10.5" cy="15" r="2.1" fill="#0A1419" />
      <circle className="ft-blink" cx="19.5" cy="15" r="2.1" fill="#0A1419" />
      <path d="M 10.5 20 Q 15 22.5 19.5 20" stroke="#0A1419" strokeWidth="1.6" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function CoachNote({ notes, setTab }) {
  const [idx, setIdx] = useState(() => Math.floor(Date.now() / (6 * 60 * 60 * 1000)) % notes.length);
  const [spinning, setSpinning] = useState(false);
  const [visible, setVisible] = useState(true);
  const note = notes[idx] || notes[0];

  function next() {
    setSpinning(true);
    setVisible(false);
    setTimeout(() => {
      setIdx((i) => (i + 1) % notes.length);
      setVisible(true);
    }, 180);
    setTimeout(() => setSpinning(false), 500);
  }

  return (
    <div className="ft-card ft-card-hero" style={{ padding: 20, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 12 }}>
        <CoachBot />
        <span style={{ flex: 1, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: COLORS.ember }}>Coach's note</span>
        <button
          onClick={next}
          title="Preview next tip"
          aria-label="Preview next tip"
          style={{
            background: "none", border: "none", color: COLORS.creamDim, fontSize: 15, cursor: "pointer",
            width: 26, height: 26, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
            transform: spinning ? "rotate(360deg)" : "none", transition: "transform 0.5s cubic-bezier(0.16,1,0.3,1)",
          }}
        >
          <RefreshCw size={14} />
        </button>
      </div>
      <div style={{ fontSize: 14, lineHeight: 1.5, color: COLORS.cream, flex: 1, opacity: visible ? 1 : 0, transition: "opacity 0.2s ease" }}>
        {note.body}
      </div>
      <button className="ft-btn ft-btn-primary" style={{ marginTop: 14, alignSelf: "flex-start", borderRadius: 999, padding: "9px 18px" }} onClick={() => setTab(note.target)}>
        {note.cta}
      </button>
      <div style={{ fontSize: 10, color: COLORS.creamDim, marginTop: 10, opacity: 0.75 }}>New tip every 6 hours, based on your logs</div>
    </div>
  );
}

// Heuristic, not a stored flag — checking several DEFAULT_PROFILE values
// at once rather than just one, since it's very unlikely someone's real
// age, height, and goal rate would all coincidentally match every
// default simultaneously. Avoids needing a migration for something this
// low-stakes; worst case for a false negative is just a redundant nudge
// for someone who happens to match, not a data problem either way.
function needsOnboarding(profile) {
  return profile.age === 26 && profile.heightIn === 70 && profile.goalType === "lose" && profile.goalRateLbsPerWeek === 1;
}

function OnboardingBanner({ userId, setTab }) {
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(`forge_onboarding_dismissed_${userId}`) === "1"; } catch { return false; }
  });
  if (dismissed) return null;
  function dismiss() {
    setDismissed(true);
    try { localStorage.setItem(`forge_onboarding_dismissed_${userId}`, "1"); } catch {}
  }
  return (
    <div className="ft-card" style={{ padding: 16, marginBottom: 14, border: `1px solid ${COLORS.ember}50`, background: `${COLORS.ember}0C`, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
      <Flame size={22} color={COLORS.ember} style={{ flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 200 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: COLORS.cream }}>Set up your basics first</div>
        <div style={{ fontSize: 12, color: COLORS.creamDim, marginTop: 2 }}>
          Age, height, gender, and activity level all feed into your calorie and macro targets — worth getting right before the numbers below mean much.
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
        <button className="ft-btn ft-btn-primary" style={{ fontSize: 12.5 }} onClick={() => setTab("settings")}>Set up now</button>
        <button className="ft-btn ft-btn-ghost" style={{ fontSize: 12.5 }} onClick={dismiss}>Skip for now</button>
      </div>
    </div>
  );
}

function Dashboard({ entries, sortedDates, latestDate, profile, chartData, workoutSessions, userSplitId, splitStartedOn, features, setTab, userId }) {
  if (!latestDate) {
    return (
      <div>
        {needsOnboarding(profile) && <OnboardingBanner userId={userId} setTab={setTab} />}
        <div className="ft-card" style={{ padding: 40, textAlign: "center" }}>
          <Flame size={28} color={COLORS.creamDim} style={{ marginBottom: 10 }} />
          <div className="ft-display" style={{ fontSize: 20, marginBottom: 6 }}>NO ENTRIES YET</div>
          <div style={{ color: COLORS.creamDim, fontSize: 13 }}>Head to "Log Entry" to record today's weight and food.</div>
        </div>
      </div>
    );
  }
  const e = entries[latestDate];
  const stats = computeStats(profile, e.weight, { neckIn: latestMeasurement(entries, "neck"), waistIn: latestMeasurement(entries, "waist") });
  const balance = e.caloriesConsumed - stats.tdee;
  const proteinPct = Math.min(100, (e.protein / stats.proteinG) * 100 || 0);
  const loggingStreak = computeLoggingStreak(entries);

  const last7 = chartData.slice(-7);
  const avgBalance = last7.length ? last7.reduce((s, d) => s + d.balance, 0) / last7.length : 0;
  const weightDelta = last7.length > 1 ? last7[last7.length - 1].weight - last7[0].weight : 0;

  const coachNotes = buildCoachNotes({ e, stats, balance, avgBalance, weightDelta, proteinPct, workoutSessions, userSplitId, splitStartedOn, entries, profile, features, latestWeight: e.weight });

  const goal = stats.suggestedCalories || 0;
  const consumed = e.caloriesConsumed || 0;
  const remaining = goal - consumed;
  const ringPct = goal > 0 ? Math.max(0, Math.min(1, consumed / goal)) : 0;
  const ringCirc = 2 * Math.PI * 62;
  const ringOffset = ringCirc * (1 - ringPct);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {needsOnboarding(profile) && <OnboardingBanner userId={userId} setTab={setTab} />}
      <div className="ft-mobile-stack" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div className="ft-card" style={{ padding: 22, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
          <div style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <div className="ft-label" style={{ marginBottom: 0 }}>{prettyDate(latestDate)} · calories today</div>
            {loggingStreak > 1 && (
              <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 700, color: COLORS.amber }}>
                <Flame size={13} /> {loggingStreak} day streak
              </div>
            )}
          </div>
          <div style={{ position: "relative", width: 150, height: 150 }}>
            <svg width="150" height="150" viewBox="0 0 150 150">
              <defs>
                <linearGradient id="dashRingGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor={COLORS.ember} />
                  <stop offset="100%" stopColor={COLORS.mint} />
                </linearGradient>
              </defs>
              <circle cx="75" cy="75" r="62" stroke={COLORS.surfaceRaised} strokeWidth="14" fill="none" />
              <circle
                className="ft-ring-fill"
                cx="75" cy="75" r="62" stroke="url(#dashRingGrad)" strokeWidth="14" fill="none"
                strokeLinecap="round" strokeDasharray={ringCirc} strokeDashoffset={ringOffset}
                transform="rotate(-90 75 75)"
              />
            </svg>
            <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
              <div className="ft-mono ft-grad-text" style={{ fontWeight: 700, fontSize: 30, letterSpacing: "-0.02em" }}>{fmt(consumed)}</div>
              <div style={{ fontSize: 11, color: COLORS.creamDim, marginTop: 1 }}>of {fmt(goal)}</div>
            </div>
          </div>
          <div style={{ fontSize: 11.5, color: COLORS.creamDim, marginTop: 10 }}>
            {remaining >= 0 ? `${fmt(remaining)} cal remaining today` : `${fmt(Math.abs(remaining))} cal over today's goal`}
          </div>

          <div style={{ width: "100%", height: 1, background: COLORS.border, margin: "16px 0 12px" }} />
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, width: "100%" }}>
            <span style={{ fontSize: 11, color: COLORS.creamDim, textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 600 }}>Weight</span>
            <span className="ft-mono" style={{ fontSize: 16, fontWeight: 700, color: COLORS.cream }}>{fmt(e.weight, 1)} lbs</span>
            {weightDelta !== 0 && (
              <span style={{ fontSize: 11, color: weightDelta < 0 ? COLORS.mint : COLORS.amber, marginLeft: "auto" }}>
                {weightDelta < 0 ? "▼" : "▲"} {fmt(Math.abs(weightDelta), 1)} this week
              </span>
            )}
          </div>
        </div>
        <CoachNote notes={coachNotes} setTab={setTab} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, alignContent: "start" }}>
        <Stat icon={<Flame size={16} color={COLORS.ember} />} label="Maintenance (TDEE)" value={`${fmt(stats.tdee)} cal`} swayDelay={-0.0} />
        <Stat
          icon={<Gauge size={16} color={COLORS.ember} />}
          label="Suggested calories"
          value={`${fmt(stats.suggestedCalories)} cal`}
          sub={stats.dailyCalorieAdjustment !== 0 ? `${stats.dailyCalorieAdjustment > 0 ? "+" : ""}${fmt(stats.dailyCalorieAdjustment)} cal/day goal` : "goal: maintain"}
          emphasized
        />
        <Stat
          icon={<Gauge size={16} color={COLORS.mint} />}
          label={avgBalance < 0 ? "Avg deficit / 7d" : avgBalance > 0 ? "Avg surplus / 7d" : "Avg balance / 7d"}
          value={`${fmt(Math.abs(avgBalance))} cal`}
          swayDelay={-0.6}
        />
        {features?.water && (() => {
          const todayWaterOz = (e.water_logs || []).reduce((s, w) => s + (parseFloat(w.amountOz) || 0), 0);
          const satPct = computeCreatineSaturation(entries, 28, profile.creatineAlreadySaturated).pct;
          const waterGoalOz = computeWaterGoalOz(profile, e.weight, (e.creatine || 0) > 0, satPct);
          const waterRemainingOz = waterGoalOz - todayWaterOz;
          return (
            <div className="ft-card" style={{ padding: 14, display: "flex", alignItems: "center", gap: 12 }}>
              <WaterRing size={52} strokeWidth={6} consumed={todayWaterOz} goal={waterGoalOz} gradId="dashWaterRingGrad" celebrate={todayWaterOz >= waterGoalOz && waterGoalOz > 0} />
              <div>
                <div className="ft-label" style={{ marginBottom: 2 }}>Water today</div>
                <div className="ft-mono" style={{ fontSize: 16, fontWeight: 700 }}>{fmt(todayWaterOz)} <span style={{ fontSize: 11, color: COLORS.creamDim, fontWeight: 400 }}>/ {fmt(waterGoalOz)} oz</span></div>
                <div style={{ fontSize: 10.5, color: COLORS.creamDim, marginTop: 1 }}>
                  {waterRemainingOz > 0 ? `${fmt(waterRemainingOz)} oz remaining` : "Goal hit ✓"}
                </div>
              </div>
            </div>
          );
        })()}
        {isBodyFatVisible(profile) && (
          <Stat
            icon={<TrendingDown size={16} color={COLORS.amber} />}
            label="Estimated body fat %"
            value={`${fmt(stats.bodyFatPct, 1)}%`}
            sub={
              stats.navyEligible && profile.useAdaptiveBodyFat ? "formula + waist/neck blend"
              : stats.navyEligible ? "blend available — turn on in Settings"
              : profile.gender === "male" ? "log neck & waist for a better estimate"
              : "formula-based"
            }
            swayDelay={-1.2}
          />
        )}
        <Stat icon={<Droplet size={16} color={COLORS.ember} />} label="Estimated fat mass" value={`${fmt(stats.fatLbs, 1)} lbs`} sub={`lean: ${fmt(stats.leanLbs, 1)} lbs`} swayDelay={-1.8} />
        <Stat icon={<TrendingDown size={16} color={COLORS.mint} />} label="Deficit target (fixed)" value={`${fmt(stats.deficitTarget)} cal`} swayDelay={-2.4} />
        <Stat icon={<TrendingUp size={16} color={COLORS.amber} />} label="Surplus target (fixed)" value={`${fmt(stats.surplusTarget)} cal`} swayDelay={-3.0} />

        {(() => {
          const grade = calcAttendanceGrade(userSplitId, workoutSessions || [], splitStartedOn);
          const rawGrade = calcRawAttendanceGrade(workoutSessions || []);
          const split = SPLITS.find(s => s.id === userSplitId);
          if (!grade && !rawGrade) return null;

          return (
            <div className="ft-mobile-stack" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, gridColumn: "1 / -1" }}>
              {grade && (
                <GradeCard
                  g={grade}
                  title="Split adherence"
                  sub={`${split?.name} · ${grade.actual}/${grade.expected} split days`}
                  windowLabel={`${grade.pct}%`}
                  explain="Only counts sessions logged under your current split, and only from the day you locked it in — not the full 28 days if you switched recently. Strict on purpose: this is specifically about how you're doing on the split you picked."
                />
              )}
              {rawGrade && (
                <GradeCard
                  g={rawGrade}
                  title="Overall consistency"
                  sub={`Any logged session, any split · last ${rawGrade.windowDays} days`}
                  windowLabel={`${rawGrade.actual}/${rawGrade.windowDays}d`}
                  explain="Counts any logged workout day over the last 30 days, regardless of which split it was under. Graded by day-count, not percentage of every calendar day — nobody trains 7 days a week, so ~4x/week (about 17 sessions) is already where 'A' starts."
                />
              )}
            </div>
          );
        })()}

        <div className="ft-card" style={{ padding: 16, gridColumn: "1 / -1" }}>
          <div className="ft-label">Protein — {fmt(e.protein)}g of {fmt(stats.proteinG)}g target</div>
          <div style={{ background: COLORS.bg, borderRadius: 8, height: 10, overflow: "hidden", marginTop: 6 }}>
            <div style={{ width: `${proteinPct}%`, height: "100%", background: COLORS.ember, transition: "width 0.3s ease" }} />
          </div>
          <div style={{ display: "flex", gap: 18, marginTop: 12, flexWrap: "wrap" }}>
            <MacroChip label="Protein" value={`${fmt(e.protein)}g`} target={`${fmt(stats.proteinG)}g`} color={COLORS.ember} />
            <MacroChip label="Carbs" value={`${fmt(e.carbs)}g`} target={`${fmt(stats.carbG)}g`} color={COLORS.amber} />
            <MacroChip label="Fat" value={`${fmt(e.fat)}g`} target={`${fmt(stats.fatG)}g`} color={COLORS.mint} />
            {e.creatine ? <MacroChip label="Creatine" value={`${fmt(e.creatine)}g`} color={COLORS.creamDim} /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}


// Skeleton building blocks — a plain pulsing block, plus a couple of
// pre-shaped layouts (card grid, list rows) so call sites don't have to
// hand-roll the same skeleton markup per view.
function SkeletonBlock({ width = "100%", height = 14, style = {} }) {
  return <div className="ft-skeleton" style={{ width, height, ...style }} />;
}

function SkeletonCard({ lines = 2 }) {
  return (
    <div className="ft-card" style={{ padding: 14 }}>
      <SkeletonBlock width="60%" height={11} style={{ marginBottom: 10 }} />
      <SkeletonBlock width="45%" height={20} style={{ marginBottom: lines > 1 ? 8 : 0 }} />
      {lines > 1 && <SkeletonBlock width="30%" height={11} />}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="ft-mobile-stack" style={{ display: "grid", gridTemplateColumns: "minmax(260px, 320px) 1fr", gap: 16 }}>
      <div className="ft-card" style={{ padding: 22, display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
        <SkeletonBlock width="70%" height={11} style={{ alignSelf: "flex-start" }} />
        <SkeletonBlock width={180} height={90} style={{ borderRadius: 90 }} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, alignContent: "start" }}>
        {Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)}
      </div>
    </div>
  );
}

function GradeCard({ g, title, sub, windowLabel, explain }) {
  const [showExplain, setShowExplain] = useState(false);
  return (
    <div className="ft-card" style={{ padding: 14, border: `1px solid ${g.color}40`, background: `${g.color}08` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <Award size={20} color={g.color} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <div style={{ fontSize: 10.5, color: COLORS.creamDim, textTransform: "uppercase", letterSpacing: "0.04em" }}>{title}</div>
            <button onClick={() => setShowExplain(s => !s)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", display: "flex", color: COLORS.creamDim }}>
              <Info size={11} />
            </button>
          </div>
          <div style={{ fontWeight: 700, fontSize: 13.5, color: g.color, marginTop: 1 }}>
            {g.emoji} {g.msg}
          </div>
          <div style={{ fontSize: 11, color: COLORS.creamDim, marginTop: 2 }}>{sub}</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
          <div className="ft-mono" style={{ fontSize: 24, fontWeight: 700, color: g.color, lineHeight: 1 }}>{g.grade}</div>
          <div style={{ fontSize: 11, color: COLORS.creamDim }}>{windowLabel}</div>
        </div>
      </div>
      {showExplain && (
        <div style={{ fontSize: 10.5, color: COLORS.creamDim, marginTop: 10, paddingTop: 10, borderTop: `1px solid ${g.color}30`, lineHeight: 1.5 }}>
          {explain}
        </div>
      )}
    </div>
  );
}

function Stat({ icon, label, value, sub, emphasized, swayDelay = 0 }) {
  return (
    <div className={`ft-card ${emphasized ? "ft-card-hero" : ""}`} style={{ padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <div className="ft-sway" style={{ "--sway-delay": `${swayDelay}s`, width: 24, height: 24, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", background: emphasized ? COLORS.emberDim : COLORS.surfaceRaised }}>
          {icon}
        </div>
        <div className="ft-label" style={{ marginBottom: 0 }}>{label}</div>
      </div>
      <div className={`ft-mono ${emphasized ? "ft-grad-text" : ""}`} style={{ fontSize: emphasized ? 25 : 20, fontWeight: 700 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: COLORS.creamDim, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

// Same ring technique as the Dashboard's calorie ring — reused here so
// water gets the same "fills up as you go" treatment instead of a plain
// bar. gradId must be unique per mounted instance (Dashboard's small one
// and the Water Log tab's big one can both be on screen at once via
// nothing more than a page transition mid-animation, so a shared id risks
// one ring silently reusing the other's gradient definition).
function WaterRing({ size = 96, strokeWidth = 10, consumed, goal, gradId, celebrate }) {
  const r = (size - strokeWidth) / 2;
  const cx = size / 2, cy = size / 2;
  const circ = 2 * Math.PI * r;
  const pct = goal > 0 ? Math.max(0, Math.min(1, consumed / goal)) : 0;
  const offset = circ * (1 - pct);
  return (
    <div className={celebrate ? "ft-ring-celebrate" : undefined} style={{ position: "relative", width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <defs>
          <linearGradient id={gradId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={COLORS.ember} />
            <stop offset="100%" stopColor={COLORS.mint} />
          </linearGradient>
        </defs>
        <circle cx={cx} cy={cy} r={r} stroke={COLORS.surfaceRaised} strokeWidth={strokeWidth} fill="none" />
        <circle
          className="ft-ring-fill"
          cx={cx} cy={cy} r={r} stroke={`url(#${gradId})`} strokeWidth={strokeWidth} fill="none"
          strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={offset}
          transform={`rotate(-90 ${cx} ${cy})`}
        />
      </svg>
    </div>
  );
}

function MacroChip({ label, value, target, color }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ width: 8, height: 8, borderRadius: 4, background: color }} />
      <div>
        <div style={{ fontSize: 11, color: COLORS.creamDim }}>{label}</div>
        <div className="ft-mono" style={{ fontSize: 14 }}>{value}{target ? <span style={{ color: COLORS.creamDim }}> / {target}</span> : null}</div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   Log entry
----------------------------------------------------------------*/

function LogEntry(props) {
  const {
    selectedDate, setSelectedDate,
    weightInput, setWeightInput,
    caloriesInput, setCaloriesInput,
    proteinInput, setProteinInput,
    carbInput, setCarbInput,
    fatInput, setFatInput,
    creatineInput, setCreatineInput,
    liveStats, liveBalance,
    handleSave, entries, handleDelete, gender, profile, onProfileChange,
    mealsToday, setTab, saveStatus,
  } = props;

  const sortedDates = useMemo(() => Object.keys(entries).sort().reverse(), [entries]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const todaysWeighIns = entries[selectedDate]?.weigh_ins || [];
  const hasWeighIn = todaysWeighIns.length > 0 || !!entries[selectedDate]?.weight;

  const yesterdayDate = shiftDateStr(selectedDate, -1);
  const yesterdayEntry = entries[yesterdayDate];
  const canCopyYesterday = !!(yesterdayEntry && (yesterdayEntry.caloriesConsumed || yesterdayEntry.protein || yesterdayEntry.carbs || yesterdayEntry.fat));

  // Accumulated deficit/surplus since the goal actually started. Mini-cut
  // has always had an explicit start date; "lose" and "gain" now do too
  // (goalStartedOn) — used when set, with the first logged day as a
  // fallback proxy for anyone who hasn't set one yet, labeled as such
  // below rather than pretending it's precise.
  const cutProgress = useMemo(() => {
    const goalType = profile?.goalType;
    if (goalType !== "mini_cut" && goalType !== "lose" && goalType !== "gain") return null;
    const ascDates = Object.keys(entries).sort();
    if (ascDates.length === 0) return null;
    const isMiniCut = goalType === "mini_cut";
    const isGain = goalType === "gain";
    const explicitStart = isMiniCut ? profile.miniCutStartedOn : profile.goalStartedOn;
    const usedFallback = !isMiniCut && !explicitStart;
    const startDate = explicitStart || ascDates[0];
    if (isMiniCut && !startDate) return null; // mini-cut set but no start date chosen yet

    let totalDelta = 0, daysCounted = 0, daysMissing = 0, lastKnownWeight = null;
    for (const d of ascDates) {
      if (d < startDate || d > todayStr()) continue;
      const e = entries[d];
      if (e?.weight) lastKnownWeight = e.weight;
      const weightForDay = e?.weight ?? lastKnownWeight;
      if (e?.caloriesConsumed == null || !weightForDay) { daysMissing++; continue; }
      const stats = computeStats(profile, weightForDay);
      // Positive totalDelta = deficit (lose/mini-cut framing); for gain we
      // flip the sign so a positive number means "surplus accumulated",
      // matching how people actually think about a bulk.
      const dayDelta = stats.tdee - e.caloriesConsumed;
      totalDelta += isGain ? -dayDelta : dayDelta;
      daysCounted++;
    }
    if (daysCounted === 0) return null;
    const totalDaySpan = Math.round((new Date(todayStr()) - new Date(startDate)) / 86400000) + 1;
    return {
      goalType, isMiniCut, isGain, startDate, usedFallback, totalDelta, daysCounted, daysMissing,
      avgPerDay: totalDelta / daysCounted,
      estLbsChange: totalDelta / energyDensityFor(goalType),
      totalDaySpan,
    };
  }, [entries, profile]);

  const creatineSaturation = useMemo(() => computeCreatineSaturation(entries, 28, profile.creatineAlreadySaturated), [entries, profile.creatineAlreadySaturated]);

  function handleCopyYesterday() {
    if (!yesterdayEntry) return;
    setCaloriesInput(String(yesterdayEntry.caloriesConsumed ?? ""));
    setProteinInput(String(yesterdayEntry.protein ?? ""));
    setCarbInput(String(yesterdayEntry.carbs ?? ""));
    setFatInput(String(yesterdayEntry.fat ?? ""));
    setCreatineInput(String(yesterdayEntry.creatine ?? ""));
  }

  return (
    <div className="ft-mobile-stack" style={{ display: "grid", gridTemplateColumns: "1fr 320px", gap: 16 }}>
      <div className="ft-card" style={{ padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
          <CalendarDays size={16} color={COLORS.ember} />
          <input type="date" className="ft-input" style={{ width: 180 }} value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} />
          {saveStatus === "saving" && (
            <span className="ft-pill" style={{ background: COLORS.amberDim, color: COLORS.amber, display: "flex", alignItems: "center", gap: 5 }}>
              <RefreshCw size={11} style={{ animation: "spin 1.2s linear infinite" }} /> Saving…
            </span>
          )}
          {saveStatus === "saved" && (
            <span className="ft-pill" style={{ background: COLORS.mintDim, color: COLORS.mint, display: "flex", alignItems: "center", gap: 5 }}>
              <Check size={12} /> Saved
            </span>
          )}
          {saveStatus === "idle" && entries[selectedDate] && (
            <span className="ft-pill" style={{ background: COLORS.mintDim, color: COLORS.mint }}>Saved</span>
          )}
          {canCopyYesterday && (
            <button
              className="ft-btn ft-btn-ghost"
              onClick={handleCopyYesterday}
              style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 5, marginLeft: "auto" }}
              title={`Copy calories/macros from ${prettyDate(yesterdayDate)}`}
            >
              <Copy size={12} /> Copy yesterday
            </button>
          )}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 12, marginBottom: 6 }}>
          <div>
            <span className="ft-label">Weight (lbs)</span>
            {hasWeighIn ? (
              <div
                className="ft-input"
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", color: COLORS.creamDim, cursor: "pointer" }}
                onClick={() => setTab && setTab("weighin")}
                title="Sourced from your Weigh-In log — tap to view or add another"
              >
                <span style={{ color: COLORS.cream, fontWeight: 600 }}>{fmt(weightInput, 1)}</span>
                <Scale size={13} color={COLORS.ember} />
              </div>
            ) : (
              <button
                onClick={() => setTab && setTab("weighin")}
                className="ft-input"
                style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, cursor: "pointer", color: COLORS.ember, fontWeight: 600, fontSize: 12 }}
              >
                <Scale size={13} /> Log a weigh-in
              </button>
            )}
          </div>
          <Field label="Calories consumed"><input className="ft-input" type="number" inputMode="decimal" onFocus={selectOnFocus} value={caloriesInput} onChange={(e) => setCaloriesInput(e.target.value)} placeholder="2000" /></Field>
          <Field label="Protein (g)"><input className="ft-input" type="number" inputMode="decimal" onFocus={selectOnFocus} value={proteinInput} onChange={(e) => setProteinInput(e.target.value)} placeholder="150" /></Field>
          <Field label="Carbs (g)"><input className="ft-input" type="number" inputMode="decimal" onFocus={selectOnFocus} value={carbInput} onChange={(e) => setCarbInput(e.target.value)} placeholder="200" /></Field>
          <Field label="Fat (g)"><input className="ft-input" type="number" inputMode="decimal" onFocus={selectOnFocus} value={fatInput} onChange={(e) => setFatInput(e.target.value)} placeholder="60" /></Field>
          <Field label="Creatine">
            <label style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer", padding: "8px 0" }}>
              <input
                type="checkbox"
                checked={parseFloat(creatineInput) > 0}
                onChange={(e) => setCreatineInput(e.target.checked ? "5" : "")}
                style={{ width: 18, height: 18, accentColor: COLORS.ember, cursor: "pointer" }}
              />
              <span style={{ fontSize: 13.5, color: COLORS.cream }}>Took my 5g today</span>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer", padding: "2px 0 6px" }}>
              <input
                type="checkbox"
                checked={!!profile.creatineAlreadySaturated}
                onChange={(e) => onProfileChange({ creatineAlreadySaturated: e.target.checked })}
                style={{ width: 15, height: 15, accentColor: COLORS.mint, cursor: "pointer" }}
              />
              <span style={{ fontSize: 11.5, color: COLORS.creamDim }}>
                Already taking creatine consistently before joining? <span style={{ color: COLORS.mint }}>Mark as already saturated</span>
              </span>
            </label>
          </Field>
        </div>
        <div style={{ fontSize: 11, color: COLORS.creamDim, marginBottom: 16 }}>
          Weight is set from the Weigh-In tab, not typed here — keeps one source of truth for your logged weight. Fill in protein, carbs, and fat and calories consumed will auto-calculate (4 / 4 / 9 cal per gram); you can still edit calories by hand on days you skip macro tracking.
        </div>

        {mealsToday && mealsToday.length > 0 && (
          <div className="ft-card-raised" style={{ padding: "8px 12px", marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <UtensilsCrossed size={13} color={COLORS.ember} />
              <span style={{ fontSize: 12, color: COLORS.creamDim }}>Food Log synced:</span>
              <span className="ft-mono" style={{ fontSize: 12, color: COLORS.cream }}>
                {fmt(mealsToday.reduce((s,m) => s + (parseFloat(m.calories)||0), 0))} cal · {fmt(mealsToday.reduce((s,m) => s + (parseFloat(m.protein)||0), 0))}g protein
              </span>
            </div>
            <span style={{ fontSize: 10, color: COLORS.mint }}>✓ {mealsToday.length} meal{mealsToday.length !== 1 ? "s" : ""}</span>
          </div>
        )}

        <div className="ft-sticky-save">
          <button className="ft-btn ft-btn-primary" onClick={handleSave} disabled={saveStatus === "saving"} style={{ opacity: saveStatus === "saving" ? 0.7 : 1 }}>
            <Flame size={14} /> {saveStatus === "saving" ? "Saving…" : "Save entry"}
          </button>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {cutProgress && <CutProgressCard progress={cutProgress} />}
        <CreatineSaturationCard saturation={creatineSaturation} />
        <div className="ft-card" style={{ padding: 16 }}>
          <div className="ft-label">Live preview</div>
          <Row label="Maintenance (TDEE)" value={`${fmt(liveStats.tdee)} cal`} />
          <Row label="Suggested calories (goal)" value={`${fmt(liveStats.suggestedCalories)} cal`} color={COLORS.ember} bold />
          <div style={{ height: 1, background: COLORS.border, margin: "10px 0" }} />
          <Row label="Net balance" value={`${liveBalance > 0 ? "+" : ""}${fmt(liveBalance)} cal`} bold color={liveBalance < 0 ? COLORS.mint : liveBalance > 0 ? COLORS.amber : COLORS.cream} />
          <div style={{ height: 1, background: COLORS.border, margin: "10px 0" }} />
          {isBodyFatVisible(profile) && <Row label="Est. body fat %" value={`${fmt(liveStats.bodyFatPct, 1)}%`} />}
          <Row label="Est. fat mass" value={`${fmt(liveStats.fatLbs, 1)} lbs`} />
          <Row label="Est. lean mass" value={`${fmt(liveStats.leanLbs, 1)} lbs`} />
        </div>

        <div className="ft-card" style={{ padding: 16 }}>
          <div className="ft-label" style={{ marginBottom: sortedDates.length ? 4 : 0 }}>History</div>
          {sortedDates.length === 0 ? (
            <div style={{ fontSize: 13, color: COLORS.creamDim }}>No entries yet.</div>
          ) : (
            <>
              <div style={{ fontSize: 10.5, color: COLORS.creamDim, marginBottom: 10 }}>Browse past entries, or jump straight to one to edit it.</div>
              <button className="ft-btn ft-btn-ghost" style={{ width: "100%", justifyContent: "center" }} onClick={() => setHistoryOpen(true)}>
                <ExternalLink size={13} /> View history ({sortedDates.length})
              </button>
            </>
          )}
        </div>
      </div>

      {historyOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
          onClick={e => { if (e.target === e.currentTarget) setHistoryOpen(false); }}>
          <div className="ft-card" style={{ padding: 20, maxWidth: 480, width: "100%", maxHeight: "80vh", overflowY: "auto", overscrollBehavior: "contain" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <div className="ft-label" style={{ marginBottom: 0 }}>Entry history</div>
              <button className="ft-btn ft-btn-ghost" style={{ padding: "4px 8px" }} onClick={() => setHistoryOpen(false)}><X size={14} /></button>
            </div>
            {sortedDates.map((d) => {
              const e = entries[d];
              return (
                <div key={d} style={{ padding: "10px 0", borderBottom: `1px solid ${COLORS.border}` }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.cream }}>{prettyDate(d)}</div>
                    <div style={{ display: "flex", gap: 4 }}>
                      <button className="ft-btn ft-btn-ghost" style={{ padding: "4px 7px", fontSize: 11 }} onClick={() => { setSelectedDate(d); setHistoryOpen(false); }}>
                        <Pencil size={11} /> Edit
                      </button>
                      <button className="ft-btn ft-btn-danger" onClick={() => handleDelete(d)}><Trash2 size={13} /></button>
                    </div>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(90px, 1fr))", gap: 8 }}>
                    <div><div style={{ fontSize: 9.5, color: COLORS.creamDim, textTransform: "uppercase" }}>Weight</div><div className="ft-mono" style={{ fontSize: 14, fontWeight: 700 }}>{fmt(e.weight, 1)} lbs</div></div>
                    <div><div style={{ fontSize: 9.5, color: COLORS.creamDim, textTransform: "uppercase" }}>Calories</div><div className="ft-mono" style={{ fontSize: 14, fontWeight: 700 }}>{fmt(e.caloriesConsumed)}</div></div>
                    <div><div style={{ fontSize: 9.5, color: COLORS.creamDim, textTransform: "uppercase" }}>Protein</div><div className="ft-mono" style={{ fontSize: 14, fontWeight: 700 }}>{fmt(e.protein)}g</div></div>
                    <div><div style={{ fontSize: 9.5, color: COLORS.creamDim, textTransform: "uppercase" }}>Carbs</div><div className="ft-mono" style={{ fontSize: 14, fontWeight: 700 }}>{fmt(e.carbs)}g</div></div>
                    <div><div style={{ fontSize: 9.5, color: COLORS.creamDim, textTransform: "uppercase" }}>Fat</div><div className="ft-mono" style={{ fontSize: 14, fontWeight: 700 }}>{fmt(e.fat)}g</div></div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}


// Interactive entry history — a horizontally scrollable row of "bubbles",
// one per date, sized by that day's value. Tapping a bubble expands a
// detail panel below instead of just showing a flat list, so browsing
// your logged history feels like exploring a timeline rather than
// scrolling a plain table. Shared by Weigh-In and Daily Log.
function EntryJourney({ dates, getValue, getLabel, selectedDate, onSelect, renderDetail, emptyMessage = "No entries yet.", accentColor = COLORS.ember }) {
  const sorted = useMemo(() => [...new Set(dates)].sort(), [dates]);
  const scrollRef = useRef(null);

  useEffect(() => {
    // Land on the most recent entry by default, since that's usually
    // what you came here to check.
    if (scrollRef.current) scrollRef.current.scrollLeft = scrollRef.current.scrollWidth;
  }, [sorted.length]);

  if (sorted.length === 0) {
    return <div style={{ fontSize: 13, color: COLORS.creamDim }}>{emptyMessage}</div>;
  }

  const values = sorted.map(getValue).filter((v) => v != null && !isNaN(v));
  const minV = values.length ? Math.min(...values) : 0;
  const maxV = values.length ? Math.max(...values) : 1;
  const range = maxV - minV || 1;

  return (
    <div>
      <div ref={scrollRef} className="ft-scroll" style={{ display: "flex", gap: 14, overflowX: "auto", paddingBottom: 8, paddingTop: 4 }}>
        {sorted.map((d) => {
          const v = getValue(d);
          const pct = v != null ? (v - minV) / range : 0;
          const size = 30 + Math.round(pct * 24); // 30px – 54px, scaled to that day's value
          const isSelected = d === selectedDate;
          return (
            <button
              key={d}
              onClick={() => onSelect(d)}
              className="ft-btn-icon"
              style={{ flexShrink: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, background: "none", border: "none", cursor: "pointer", padding: "4px 2px", minWidth: 44 }}
            >
              <div
                className="ft-mono"
                style={{
                  width: size, height: size, borderRadius: "50%",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: isSelected ? accentColor : COLORS.surfaceRaised,
                  border: `2px solid ${isSelected ? accentColor : COLORS.border}`,
                  color: isSelected ? COLORS.bg : COLORS.creamDim,
                  fontSize: 10, fontWeight: 700,
                  transition: "transform 0.15s cubic-bezier(0.16,1,0.3,1), background 0.15s ease",
                  transform: isSelected ? "scale(1.08)" : "scale(1)",
                }}
              >
                {v != null ? Math.round(v) : "—"}
              </div>
              <div style={{ fontSize: 9.5, color: isSelected ? accentColor : COLORS.creamDim, whiteSpace: "nowrap" }}>{getLabel(d)}</div>
            </button>
          );
        })}
      </div>
      {selectedDate && sorted.includes(selectedDate) && (
        <div className="ft-row-enter" style={{ marginTop: 12, padding: 14, background: COLORS.surfaceRaised, borderRadius: 14, border: `1px solid ${COLORS.border}` }}>
          {renderDetail(selectedDate)}
        </div>
      )}
    </div>
  );
}

function CutProgressCard({ progress }) {
  const { isMiniCut, isGain, startDate, usedFallback, totalDelta, daysCounted, daysMissing, avgPerDay, estLbsChange, totalDaySpan } = progress;
  // Whether the ACTUAL accumulated calories were a surplus or a deficit —
  // independent of which goal was set. totalDelta's sign already flips
  // meaning between goal types upstream (a bulk accumulates "consumed −
  // tdee", a cut accumulates "tdee − consumed"), so a plain totalDelta
  // >= 0 check meant opposite things depending on goal type. This maps
  // both back to one universal, sign-matches-word convention — positive
  // always reads as surplus, negative always reads as deficit, same as
  // the rest of the app (see balancePhrase) — instead of always framing
  // the goal's "good direction" as positive, which made a real deficit
  // during a bulk display as a positive number labeled "deficit".
  const actualIsSurplus = isGain ? totalDelta >= 0 : totalDelta < 0;
  const title = isMiniCut ? "Mini-cut progress" : isGain ? "Bulk progress" : "Cut progress";
  return (
    <div className="ft-card ft-card-hero" style={{ padding: 16 }}>
      <div className="ft-label" style={{ marginBottom: 2 }}>{title}</div>
      <div style={{ fontSize: 10.5, color: COLORS.creamDim, marginBottom: 10 }}>
        Since {prettyDate(startDate)}{usedFallback && " (your first logged day — set a start date in Settings for a precise total)"}
      </div>
      <div className="ft-mono ft-grad-text" style={{ fontSize: 26, fontWeight: 700 }}>
        {actualIsSurplus ? "+" : "−"}{fmt(Math.abs(totalDelta))} cal
      </div>
      <div style={{ fontSize: 11, color: COLORS.creamDim, marginTop: 2 }}>
        accumulated {actualIsSurplus ? "surplus" : "deficit"} · ≈{fmt(Math.abs(estLbsChange), 1)} lbs {actualIsSurplus ? "gained (muscle + some fat)" : "of fat"}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, paddingTop: 12, borderTop: `1px solid ${COLORS.border}` }}>
        <div>
          <div style={{ fontSize: 9.5, color: COLORS.creamDim, textTransform: "uppercase" }}>Avg / day</div>
          <div className="ft-mono" style={{ fontSize: 13, fontWeight: 600 }}>{actualIsSurplus ? "+" : "−"}{fmt(Math.abs(avgPerDay))} cal</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 9.5, color: COLORS.creamDim, textTransform: "uppercase" }}>Logged / calendar days</div>
          <div className="ft-mono" style={{ fontSize: 13, fontWeight: 600 }}>{daysCounted} / {totalDaySpan}</div>
        </div>
      </div>
      {daysMissing > 0 && (
        <div style={{ fontSize: 10, color: COLORS.creamDim, marginTop: 8 }}>
          {daysMissing} day{daysMissing !== 1 ? "s" : ""} without calories logged aren't counted — actual total may run higher.
        </div>
      )}
      {totalDaySpan > 180 && (
        <div style={{ fontSize: 10, color: COLORS.amber, marginTop: 8, display: "flex", alignItems: "center", gap: 4 }}>
          <AlertCircle size={11} /> This is tracking {Math.round(totalDaySpan / 30)} months — if that's longer than intended, double-check the start date in Settings.
        </div>
      )}
    </div>
  );
}

function CreatineSaturationCard({ saturation }) {
  const { pct, daysTaken, windowDays, streak, label, manual } = saturation;
  if (!manual && daysTaken === 0) return null; // nothing to show until it's actually been logged at least once — unless manually marked saturated
  return (
    <div className="ft-card" style={{ padding: 16 }}>
      <div className="ft-label" style={{ marginBottom: 2 }}>Creatine saturation</div>
      <div style={{ fontSize: 10.5, color: COLORS.creamDim, marginBottom: 10 }}>
        {manual
          ? "Marked as already saturated from before joining — real days-taken and streak are still tracked below, in case this ever needs to come off."
          : "Estimated — muscle creatine builds up over ~3-4 weeks of daily use, and this can't be measured directly, only inferred from how consistently you've taken it."}
      </div>
      <div className="ft-mono ft-grad-text" style={{ fontSize: 26, fontWeight: 700 }}>{pct}%</div>
      <div style={{ fontSize: 11, color: COLORS.creamDim, marginTop: 2 }}>
        {label}{manual && <span style={{ color: COLORS.mint }}> · manually set</span>}
      </div>
      <div style={{ height: 6, background: COLORS.surfaceRaised, borderRadius: 3, marginTop: 10, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, backgroundImage: `linear-gradient(135deg, ${COLORS.ember}, ${COLORS.mint})` }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, paddingTop: 12, borderTop: `1px solid ${COLORS.border}` }}>
        <div>
          <div style={{ fontSize: 9.5, color: COLORS.creamDim, textTransform: "uppercase" }}>Days taken{manual && " (real)"}</div>
          <div className="ft-mono" style={{ fontSize: 13, fontWeight: 600 }}>{daysTaken} / {windowDays}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 9.5, color: COLORS.creamDim, textTransform: "uppercase" }}>Current streak</div>
          <div className="ft-mono" style={{ fontSize: 13, fontWeight: 600 }}>{streak} day{streak !== 1 ? "s" : ""}</div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <span className="ft-label">{label}</span>
      {children}
    </div>
  );
}

function Row({ label, value, color, bold }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", fontSize: 13 }}>
      <span style={{ color: COLORS.creamDim }}>{label}</span>
      <span className="ft-mono" style={{ color: color || COLORS.cream, fontWeight: bold ? 700 : 500 }}>{value}</span>
    </div>
  );
}

/* ---------------------------------------------------------------
   Food Log Tab — standalone tab for meal-by-meal tracking.
   Totals auto-sync to the day's caloriesConsumed and protein.
----------------------------------------------------------------*/

function FoodLogTab({ userId, selectedDate, setSelectedDate, meals, addMeal, updateMeal, deleteMeal, applyMealTotals, entries }) {
  const [label, setLabel] = useState("");
  const [calories, setCalories] = useState("");
  const [protein, setProtein] = useState("");
  const [carbs, setCarbs] = useState("");
  const [fat, setFat] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [presets, setPresets] = useState([]);
  const [savingPreset, setSavingPreset] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const mealHistoryDates = useMemo(
    () => Object.keys(entries).filter(d => entries[d].meals?.length > 0).sort().reverse(),
    [entries]
  );
  const [contributing, setContributing] = useState(false);
  const [contributeGrams, setContributeGrams] = useState("");
  const [contributeCode, setContributeCode] = useState("");
  const [contributingBusy, setContributingBusy] = useState(false);

  useEffect(() => {
    if (!userId) return;
    (async () => setPresets(await loadMealPresets(userId)))();
  }, [userId]);

  const totalCal  = meals.reduce((s, m) => s + (parseFloat(m.calories) || 0), 0);
  const totalProt = meals.reduce((s, m) => s + (parseFloat(m.protein)  || 0), 0);
  const totalCarb = meals.reduce((s, m) => s + (parseFloat(m.carbs)    || 0), 0);
  const totalFat  = meals.reduce((s, m) => s + (parseFloat(m.fat)      || 0), 0);

  function resetForm() { setLabel(""); setCalories(""); setProtein(""); setCarbs(""); setFat(""); setEditingId(null); }

  const [submitting, setSubmitting] = useState(false);
  async function handleSubmit() {
    if (!calories && !protein) return;
    if (submitting) return;
    setSubmitting(true);
    const payload = {
      label:    label.trim() || "Meal",
      calories: clampPositive(calories),
      protein:  clampPositive(protein),
      carbs:    clampPositive(carbs),
      fat:      clampPositive(fat),
    };
    if (editingId) { await updateMeal(editingId, payload); }
    else           { await addMeal(payload); }
    resetForm();
    setSubmitting(false);
  }

  async function handleSaveAsPreset() {
    if (!calories && !protein) return;
    setSavingPreset(true);
    const preset = await saveMealPreset(userId, {
      name: label.trim() || "Untitled meal",
      calories: clampPositive(calories),
      protein: clampPositive(protein),
      carbs: clampPositive(carbs),
      fat: clampPositive(fat),
    });
    if (preset) setPresets((prev) => [...prev.filter((p) => p.id !== preset.id), preset].sort((a, b) => a.name.localeCompare(b.name)));
    setSavingPreset(false);
  }

  // "Save as preset" is personal — only you see it. This instead pushes
  // the food into community_foods, the shared database every user's
  // search (and barcode scan) draws from. Needs a serving size in grams
  // to convert your totals into the per-100g shape the rest of the food
  // search stack expects — without it, "650 cal" for a whole plate would
  // get stored as if it were 650 cal per 100g, wildly overstating how
  // calorie-dense the food actually is.
  // The shared database has no real per-user auth to speak of, so this
  // is a lightweight friction gate, not genuine security — anyone who
  // reads the source can find the code. Its actual purpose is filtering
  // out casual/accidental contributions from people who don't realize
  // they're publishing something for every other user to see, not
  // stopping a determined bad actor.
  const COMMUNITY_ADD_CODE = "2517";
  async function handleContributeToDatabase() {
    if (!calories && !protein) return;
    if (contributeCode.trim() !== COMMUNITY_ADD_CODE) return;
    setContributingBusy(true);
    const food = await addCommunityFood({
      name: label.trim() || "Untitled meal",
      calories: parseFloat(calories) || 0,
      protein: parseFloat(protein) || 0,
      carbs: parseFloat(carbs) || 0,
      fat: parseFloat(fat) || 0,
      grams: parseFloat(contributeGrams) || 100,
      servingLabel: contributeGrams ? `${contributeGrams} g` : null,
    });
    setContributingBusy(false);
    setContributing(false);
    setContributeGrams("");
    setContributeCode("");
    if (food) toastSuccess(`Added "${food.name}" to the shared food database`);
  }

  function handleQuickAdd(preset) {
    addMeal({ label: preset.name, calories: preset.calories, protein: preset.protein, carbs: preset.carbs, fat: preset.fat });
  }

  async function handleDeletePreset(id) {
    setPresets((prev) => prev.filter((p) => p.id !== id));
    await deleteMealPreset(userId, id);
  }

  function startEdit(meal) {
    setEditingId(meal.id);
    setLabel(meal.label || "");
    setCalories(String(meal.calories ?? ""));
    setProtein(String(meal.protein ?? ""));
    setCarbs(String(meal.carbs ?? ""));
    setFat(String(meal.fat ?? ""));
  }

  // Detect if this date already has a manual entry with calories > meal total
  const existingEntry = entries[selectedDate];
  const hasMismatch = existingEntry && existingEntry.caloriesConsumed && totalCal > 0 &&
    Math.abs(existingEntry.caloriesConsumed - totalCal) > 5;

  return (
    <div className="ft-mobile-stack" style={{ display: "grid", gridTemplateColumns: "1fr min(340px, 100%)", gap: 16 }}>
      {/* Entry panel */}
      <div className="ft-card" style={{ padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
          <UtensilsCrossed size={16} color={COLORS.ember} />
          <input type="date" className="ft-input" style={{ width: 170 }} value={selectedDate} onChange={(e) => setSelectedDate(e.target.value)} />
          {existingEntry && <span className="ft-pill" style={{ background: COLORS.mintDim, color: COLORS.mint }}>Entry exists</span>}
        </div>

        {/* ── Database search + barcode scanner ── */}
        <div className="ft-label" style={{ marginBottom: 6 }}>Search food database or scan barcode</div>
        <FoodSearch
          onFoodAdded={(food) => {
            addMeal({
              label:    food.label,
              calories: food.calories,
              protein:  food.protein,
              carbs:    food.carbs,
              fat:      food.fat,
            });
          }}
        />

        {/* ── Manual entry ── */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "14px 0 8px" }}>
          <div style={{ flex: 1, height: 1, background: COLORS.border }} />
          <span style={{ fontSize: 11, color: COLORS.creamDim }}>or enter manually</span>
          <div style={{ flex: 1, height: 1, background: COLORS.border }} />
        </div>
        <div className="ft-label" style={{ marginBottom: 6 }}>Add a meal</div>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
          <div style={{ gridColumn: "1 / -1" }}>
            <input className="ft-input" placeholder="Meal name (e.g. Chicken &amp; rice, Whey shake)" value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && handleSubmit()} />
          </div>
          <Field label="Calories">
            <input className="ft-input" type="number" inputMode="decimal" onFocus={selectOnFocus} placeholder="0" value={calories} onChange={(e) => setCalories(e.target.value)} />
          </Field>
          <Field label="Protein (g)">
            <input className="ft-input" type="number" inputMode="decimal" onFocus={selectOnFocus} placeholder="0" value={protein} onChange={(e) => setProtein(e.target.value)} />
          </Field>
          <Field label="Carbs (g)">
            <input className="ft-input" type="number" inputMode="decimal" onFocus={selectOnFocus} placeholder="0" value={carbs} onChange={(e) => setCarbs(e.target.value)} />
          </Field>
          <Field label="Fat (g)">
            <input className="ft-input" type="number" inputMode="decimal" onFocus={selectOnFocus} placeholder="0" value={fat} onChange={(e) => setFat(e.target.value)} />
          </Field>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 6 }}>
            <button className="ft-btn ft-btn-primary" onClick={handleSubmit} disabled={submitting} style={{ flex: 1, opacity: submitting ? 0.7 : 1 }}>
              {submitting ? <RefreshCw size={13} style={{ animation: "spin 1.2s linear infinite" }} /> : editingId ? <><Check size={13} /> Update</> : <><Plus size={13} /> Add</>}
            </button>
            <button
              className="ft-btn ft-btn-ghost"
              onClick={handleSaveAsPreset}
              disabled={savingPreset || (!calories && !protein)}
              title="Save these macros as a reusable preset (only visible to you)"
              style={{ opacity: (!calories && !protein) ? 0.5 : 1 }}
            >
              <BookmarkPlus size={13} />
            </button>
            <button
              className="ft-btn ft-btn-ghost"
              onClick={() => setContributing(true)}
              disabled={!calories && !protein}
              title="Add to the shared food database — searchable by every user"
              style={{ opacity: (!calories && !protein) ? 0.5 : 1, color: COLORS.mint }}
            >
              <Users size={13} />
            </button>
            {editingId && <button className="ft-btn ft-btn-ghost" onClick={resetForm}><X size={13} /></button>}
          </div>
        </div>

        {contributing && (
          <div className="ft-card-raised" style={{ padding: 12, marginBottom: 16, border: `1px solid ${COLORS.mint}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
              <Users size={13} color={COLORS.mint} />
              <span style={{ fontSize: 12, fontWeight: 600, color: COLORS.cream }}>Add "{label.trim() || "this meal"}" to the shared database</span>
            </div>
            <div style={{ fontSize: 11, color: COLORS.creamDim, lineHeight: 1.4, marginBottom: 10 }}>
              Every user's search and barcode scan will be able to find this from now on. What serving size do the numbers above ({fmt(parseFloat(calories) || 0)} cal, {fmt(parseFloat(protein) || 0)}g protein) represent?
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
              <input
                className="ft-input"
                type="number" inputMode="decimal" onFocus={selectOnFocus}
                placeholder="e.g. 350"
                value={contributeGrams}
                onChange={(e) => setContributeGrams(e.target.value)}
                style={{ width: 100 }}
                autoFocus
              />
              <span style={{ fontSize: 12, color: COLORS.creamDim }}>grams (defaults to 100 if left blank)</span>
            </div>
            <div>
              <span className="ft-label" style={{ fontSize: 10.5 }}>Access code</span>
              <input
                className="ft-input"
                type="text" inputMode="numeric" onFocus={selectOnFocus}
                placeholder="Enter code to publish"
                value={contributeCode}
                onChange={(e) => setContributeCode(e.target.value)}
                style={{ maxWidth: 200 }}
              />
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <button className="ft-btn ft-btn-primary" style={{ flex: 1 }} onClick={handleContributeToDatabase} disabled={contributingBusy || contributeCode.trim() !== COMMUNITY_ADD_CODE}>
                {contributingBusy ? <RefreshCw size={13} style={{ animation: "spin 1.2s linear infinite" }} /> : <Users size={13} />}
                {contributingBusy ? "Adding…" : "Confirm & add"}
              </button>
              <button className="ft-btn ft-btn-ghost" onClick={() => { setContributing(false); setContributeGrams(""); setContributeCode(""); }}>Cancel</button>
            </div>
          </div>
        )}

        {presets.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div className="ft-label" style={{ marginBottom: 6, display: "flex", alignItems: "center", gap: 5 }}>
              <Star size={12} color={COLORS.ember} /> Saved presets — tap to add instantly
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {presets.map((p) => (
                <div
                  key={p.id}
                  style={{ display: "flex", alignItems: "center", gap: 6, background: COLORS.surfaceRaised, border: `1px solid ${COLORS.border}`, borderRadius: 999, padding: "4px 6px 4px 12px" }}
                >
                  <button
                    onClick={() => handleQuickAdd(p)}
                    style={{ background: "none", border: "none", cursor: "pointer", color: COLORS.cream, fontSize: 12, fontWeight: 600, padding: 0, display: "flex", alignItems: "center", gap: 5 }}
                  >
                    {p.name}
                    <span className="ft-mono" style={{ color: COLORS.creamDim, fontWeight: 400 }}>{fmt(p.calories)} cal</span>
                  </button>
                  <button
                    className="ft-btn-icon"
                    onClick={() => handleDeletePreset(p.id)}
                    style={{ background: "none", border: "none", cursor: "pointer", color: COLORS.creamDim, display: "flex", alignItems: "center", justifyContent: "center" }}
                    title="Delete preset"
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{ fontSize: 11, color: COLORS.creamDim, marginBottom: 16, lineHeight: 1.5 }}>
          Meals are automatically synced to your Daily Log for this date. The totals update your calorie and protein fields instantly.
        </div>

        {hasMismatch && (
          <div className="ft-card-raised" style={{ padding: "8px 12px", marginBottom: 12, fontSize: 11, color: COLORS.amber }}>
            ⚡ Logged entry shows {fmt(existingEntry.caloriesConsumed)} cal — food log totals {fmt(totalCal)} cal. The food log total will override on next edit.
          </div>
        )}

        {meals.length === 0 ? (
          <div style={{ textAlign: "center", padding: "28px 0", color: COLORS.creamDim, fontSize: 13 }}>
            No meals logged yet for {prettyDate(selectedDate)}.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {meals.map((m) => (
              <div key={m.id} className="ft-row-enter" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 10px", background: COLORS.surface, borderRadius: 10, border: `1px solid ${COLORS.border}` }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{m.label}</div>
                  <div className="ft-mono" style={{ fontSize: 11, color: COLORS.creamDim }}>
                    {fmt(m.calories)} cal · {fmt(m.protein)}g pro
                    {m.carbs ? ` · ${fmt(m.carbs)}g carb` : ""}
                    {m.fat ? ` · ${fmt(m.fat)}g fat` : ""}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 5 }}>
                  <button className="ft-btn ft-btn-ghost" style={{ padding: "5px 8px" }} onClick={() => startEdit(m)}><Pencil size={12} /></button>
                  <button className="ft-btn ft-btn-danger" onClick={() => deleteMeal(m.id)}><Trash2 size={13} /></button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Totals sidebar */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div className="ft-card" style={{ padding: 16 }}>
          <div className="ft-label" style={{ marginBottom: 10 }}>Today's totals</div>
          <div className="ft-mono" style={{ fontSize: 28, fontWeight: 700, color: COLORS.ember, marginBottom: 2 }}>{fmt(totalCal)}</div>
          <div style={{ fontSize: 11, color: COLORS.creamDim, marginBottom: 14 }}>calories logged</div>
          <Row label="Protein" value={`${fmt(totalProt)}g`} color={COLORS.ember} />
          <Row label="Carbs"   value={`${fmt(totalCarb)}g`} />
          <Row label="Fat"     value={`${fmt(totalFat)}g`} />
          <Row label="Meals"   value={meals.length} />
          {totalCal > 0 && (
            <div style={{ marginTop: 10, background: COLORS.bg, borderRadius: 6, height: 4, overflow: "hidden" }}>
              <div style={{ width: `${Math.min(100, (totalProt * 4 / totalCal) * 100)}%`, height: "100%", background: COLORS.ember }} />
            </div>
          )}
          {totalCal > 0 && <div style={{ fontSize: 10, color: COLORS.creamDim, marginTop: 4 }}>Protein: {Math.round((totalProt * 4 / totalCal) * 100)}% of calories</div>}
        </div>

        <div className="ft-card" style={{ padding: 14 }}>
          <div style={{ fontSize: 11, color: COLORS.mint, marginBottom: 6, display: "flex", alignItems: "center", gap: 5 }}>
            <Check size={12} /> Auto-synced to Daily Log
          </div>
          <div style={{ fontSize: 11, color: COLORS.creamDim, lineHeight: 1.5 }}>
            Every change here instantly updates your day's entry on the Daily Log tab.
          </div>
        </div>

        {/* History — a horizontal-scrolling list stretched badly on mobile
            in Daily Log and Weigh-In, so this uses the same popout pattern
            instead of anything scrolling inline. */}
        <div className="ft-card" style={{ padding: 14 }}>
          <div className="ft-label" style={{ marginBottom: mealHistoryDates.length ? 8 : 0 }}>Food log history</div>
          {mealHistoryDates.length === 0 ? (
            <div style={{ fontSize: 13, color: COLORS.creamDim }}>No meals logged yet.</div>
          ) : (
            <button className="ft-btn ft-btn-ghost" style={{ width: "100%", justifyContent: "center" }} onClick={() => setHistoryOpen(true)}>
              <ExternalLink size={13} /> View history ({mealHistoryDates.length} days)
            </button>
          )}
        </div>
      </div>

      {historyOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
          onClick={e => { if (e.target === e.currentTarget) setHistoryOpen(false); }}>
          <div className="ft-card" style={{ padding: 20, maxWidth: 480, width: "100%", maxHeight: "80vh", overflowY: "auto", overscrollBehavior: "contain" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <div className="ft-label" style={{ marginBottom: 0 }}>Food log history</div>
              <button className="ft-btn ft-btn-ghost" style={{ padding: "4px 8px" }} onClick={() => setHistoryOpen(false)}><X size={14} /></button>
            </div>
            {mealHistoryDates.map((d) => {
              const dayMeals = entries[d].meals || [];
              const dayCal = dayMeals.reduce((s, m) => s + (parseFloat(m.calories) || 0), 0);
              const dayProt = dayMeals.reduce((s, m) => s + (parseFloat(m.protein) || 0), 0);
              return (
                <div key={d} style={{ padding: "10px 0", borderBottom: `1px solid ${COLORS.border}` }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: COLORS.cream }}>{prettyDate(d)}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span className="ft-mono" style={{ fontSize: 11, color: COLORS.creamDim }}>{fmt(dayCal)} cal · {fmt(dayProt)}g pro</span>
                      <button className="ft-btn ft-btn-ghost" style={{ padding: "4px 7px", fontSize: 11 }} onClick={() => { setSelectedDate(d); setHistoryOpen(false); }}>
                        <Pencil size={11} /> Edit
                      </button>
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {dayMeals.map((m) => (
                      <div key={m.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12 }}>
                        <span style={{ color: COLORS.cream }}>{m.label}</span>
                        <span className="ft-mono" style={{ color: COLORS.creamDim }}>
                          {fmt(m.calories)} cal · {fmt(m.protein)}g pro
                          {m.carbs ? ` · ${fmt(m.carbs)}g carb` : ""}
                          {m.fat ? ` · ${fmt(m.fat)}g fat` : ""}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------
   Weigh-In Tab — log weight + time independently of the daily
   calorie entry. Multiple weigh-ins per day are supported.
   The most recent reading is used as the day's official weight.
----------------------------------------------------------------*/

function WeighInTab({ entries, weighInsForDate, onAdd, onDelete }) {
  const today = todayStr();
  const [date, setDate] = useState(today);
  const [weightVal, setWeightVal] = useState("");
  const [timeVal, setTimeVal] = useState(() => {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  });
  const [tag, setTag] = useState("");
  const [saving, setSaving] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const weighInDates = useMemo(
    () => Object.keys(entries).filter((d) => (entries[d].weigh_ins?.length > 0) || entries[d].weight),
    [entries]
  );

  const TAGS = ["Fasted", "Morning", "Midday", "Evening", "Post-workout", "Before bed"];

  const todayWeighIns = weighInsForDate(date);

  // Build a 7-day trend from entries
  const trendData = useMemo(() => {
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const ds = localDateStr(d);
      const wi = weighInsForDate(ds);
      const w = wi.length > 0 ? parseFloat(wi[0].weight) : (entries[ds]?.weight ?? null);
      if (w) days.push({ label: ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getDay()], weight: w, date: ds });
    }
    return days;
  }, [entries, date]);

  async function handleLog() {
    if (!weightVal || !timeVal) return;
    setSaving(true);
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      time: timeVal,
      weight: clampPositive(weightVal),
      tag: tag || null,
    };
    await onAdd(date, entry);
    setWeightVal("");
    setTag("");
    setSaving(false);
  }

  return (
    <div className="ft-mobile-stack" style={{ display: "grid", gridTemplateColumns: "1fr min(340px, 100%)", gap: 16 }}>
      {/* Main panel */}
      <div className="ft-card" style={{ padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
          <Scale size={18} color={COLORS.ember} />
          <div>
            <div style={{ fontWeight: 600, fontSize: 15, color: COLORS.cream }}>Daily Weigh-In</div>
            <div style={{ fontSize: 11, color: COLORS.creamDim }}>Log weight without needing to track calories</div>
          </div>
        </div>

        {/* Date */}
        <div style={{ marginBottom: 14 }}>
          <span className="ft-label">Date</span>
          <input type="date" className="ft-input" style={{ maxWidth: 200 }} value={date} onChange={e => setDate(e.target.value)} />
        </div>

        {/* Weight + time in a row */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <div style={{ minWidth: 0 }}>
            <span className="ft-label">Weight (lbs)</span>
            <input
              className="ft-input"
              type="number" inputMode="decimal"
              step="0.1"
              placeholder="e.g. 175.5"
              value={weightVal}
              onFocus={selectOnFocus}
              onChange={e => setWeightVal(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleLog()}
              style={{ fontSize: 20, fontWeight: 700 }}
            />
          </div>
          <div style={{ minWidth: 0 }}>
            <span className="ft-label" style={{ display: "flex", alignItems: "center", gap: 4 }}><Clock size={11} /> Time</span>
            <input
              className="ft-input"
              type="time"
              value={timeVal}
              onChange={e => setTimeVal(e.target.value)}
            />
          </div>
        </div>

        {/* Quick tags */}
        <div className="ft-label" style={{ marginBottom: 6 }}>Tag (optional)</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
          {TAGS.map(t => (
            <button
              key={t}
              onClick={() => setTag(tag === t ? "" : t)}
              className="ft-btn ft-btn-ghost"
              style={{ fontSize: 11, padding: "4px 10px", border: `1px solid ${tag === t ? COLORS.ember : COLORS.border}`, color: tag === t ? COLORS.ember : COLORS.creamDim }}
            >
              {t}
            </button>
          ))}
        </div>

        <button
          className="ft-btn ft-btn-primary"
          onClick={handleLog}
          disabled={!weightVal || !timeVal || saving}
          style={{ opacity: !weightVal ? 0.6 : 1, marginBottom: 20 }}
        >
          <Scale size={14} /> {saving ? "Saving…" : "Log Weigh-In"}
        </button>

        {/* Today's logs */}
        <div className="ft-label" style={{ marginBottom: 8 }}>
          {prettyDate(date)} — {todayWeighIns.length} reading{todayWeighIns.length !== 1 ? "s" : ""}
        </div>
        {todayWeighIns.length === 0 ? (
          <div style={{ fontSize: 13, color: COLORS.creamDim }}>No weigh-ins logged for this date yet.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[...todayWeighIns].sort((a, b) => a.time.localeCompare(b.time)).map(w => (
              <div key={w.id} className="ft-row-enter" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", background: COLORS.surface, borderRadius: 10, border: `1px solid ${COLORS.border}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div className="ft-mono" style={{ fontSize: 22, fontWeight: 700, color: COLORS.ember }}>{fmt(w.weight, 1)}</div>
                  <div>
                    <div style={{ fontSize: 12, color: COLORS.cream, fontWeight: 500 }}>lbs</div>
                    <div style={{ fontSize: 11, color: COLORS.creamDim, display: "flex", alignItems: "center", gap: 4 }}>
                      <Clock size={10} /> {w.time}{w.tag ? ` · ${w.tag}` : ""}
                    </div>
                  </div>
                </div>
                <button className="ft-btn ft-btn-danger" onClick={() => onDelete(date, w.id)}><Trash2 size={13} /></button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Sidebar */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {/* History — a horizontal-scrolling row here misbehaved on narrow
            mobile widths (iOS Safari let it stretch the whole page instead
            of scrolling in place), so this opens a popout instead of
            rendering the list inline. */}
        <div className="ft-card" style={{ padding: 14 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: weighInDates.length ? 8 : 0 }}>
            <div className="ft-label" style={{ marginBottom: 0 }}>Your weigh-in journey</div>
            {trendData.length > 1 && (() => {
              const delta = trendData[trendData.length - 1].weight - trendData[0].weight;
              const color = delta < 0 ? COLORS.mint : delta > 0 ? COLORS.danger : COLORS.creamDim;
              return (
                <span className="ft-mono" style={{ fontSize: 11, color }}>
                  {delta > 0 ? "▲" : delta < 0 ? "▼" : "—"} {Math.abs(delta).toFixed(1)} / 7d
                </span>
              );
            })()}
          </div>
          {weighInDates.length === 0 ? (
            <div style={{ fontSize: 13, color: COLORS.creamDim }}>Log a weigh-in to start your journey.</div>
          ) : (
            <button className="ft-btn ft-btn-ghost" style={{ width: "100%", justifyContent: "center" }} onClick={() => setHistoryOpen(true)}>
              <ExternalLink size={13} /> View history ({weighInDates.length})
            </button>
          )}
        </div>
      </div>

      {historyOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
          onClick={e => { if (e.target === e.currentTarget) setHistoryOpen(false); }}>
          <div className="ft-card" style={{ padding: 20, maxWidth: 480, width: "100%", maxHeight: "80vh", overflowY: "auto", overscrollBehavior: "contain" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <div className="ft-label" style={{ marginBottom: 0 }}>Weigh-in history</div>
              <button className="ft-btn ft-btn-ghost" style={{ padding: "4px 8px" }} onClick={() => setHistoryOpen(false)}><X size={14} /></button>
            </div>
            {[...weighInDates].sort().reverse().map((d) => {
              const wi = weighInsForDate(d);
              return (
                <div key={d} style={{ padding: "10px 0", borderBottom: `1px solid ${COLORS.border}` }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{prettyDate(d)}</div>
                  {wi.length > 0 ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {[...wi].sort((a, b) => a.time.localeCompare(b.time)).map((w) => (
                        <div key={w.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                          <span className="ft-mono" style={{ fontSize: 13, color: COLORS.ember, fontWeight: 700 }}>{fmt(w.weight, 1)} lbs</span>
                          <span style={{ fontSize: 11, color: COLORS.creamDim, display: "flex", alignItems: "center", gap: 4 }}><Clock size={10} /> {w.time}{w.tag ? ` · ${w.tag}` : ""}</span>
                          <button className="ft-btn-icon" style={{ background: "none", border: "none", color: COLORS.danger, cursor: "pointer" }} onClick={() => onDelete(d, w.id)}><Trash2 size={13} /></button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="ft-mono" style={{ fontSize: 13, color: COLORS.ember, fontWeight: 700 }}>{fmt(entries[d]?.weight, 1)} lbs <span style={{ fontSize: 10.5, color: COLORS.creamDim, fontWeight: 400 }}>(from Daily Log)</span></div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const OZ_PER_ML = 1 / 29.5735;
function ozToMl(oz) { return oz / OZ_PER_ML; }
function mlToOz(ml) { return ml * OZ_PER_ML; }

function WaterLogTab({ entries, waterLogsForDate, onAdd, onDelete, profile, latestWeight, onProfileChange }) {
  const today = todayStr();
  const [date, setDate] = useState(today);
  const [amountVal, setAmountVal] = useState("");
  const [timeVal, setTimeVal] = useState(() => {
    const now = new Date();
    return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  });
  const [saving, setSaving] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [useMl, setUseMl] = useState(() => {
    try { return localStorage.getItem("forge_water_units") === "ml"; } catch { return false; }
  });
  const [goalDraft, setGoalDraft] = useState("");
  const [editingGoal, setEditingGoal] = useState(false);
  const [celebrating, setCelebrating] = useState(false);

  function toggleUnits() {
    const next = !useMl;
    setUseMl(next);
    try { localStorage.setItem("forge_water_units", next ? "ml" : "oz"); } catch {}
  }

  const unitLabel = useMl ? "mL" : "oz";
  const toDisplay = (oz) => useMl ? Math.round(ozToMl(oz)) : Math.round(oz);
  const toOz = (val) => useMl ? mlToOz(val) : val;

  // Suggested starting point — roughly half your bodyweight in ounces is
  // the most widely-cited baseline formula. Just a starting point, not a
  // precise target: real needs vary with activity, climate, and body
  // size, so this is editable rather than fixed.
  const suggestedGoalOz = latestWeight ? Math.round(latestWeight * 0.5) : 64;
  const baseGoalOz = profile.waterGoalOz || suggestedGoalOz;
  const tookCreatineToday = (parseFloat(entries[date]?.creatine) || 0) > 0;
  const creatineSatPct = useMemo(() => computeCreatineSaturation(entries, 28, profile.creatineAlreadySaturated).pct, [entries, profile.creatineAlreadySaturated]);
  const creatineBonusOz = tookCreatineToday ? computeCreatineWaterBonusOz(creatineSatPct) : 0;
  const goalOz = computeWaterGoalOz(profile, latestWeight, tookCreatineToday, creatineSatPct);

  const waterDates = useMemo(
    () => Object.keys(entries).filter((d) => (entries[d].water_logs?.length ?? 0) > 0),
    [entries]
  );

  const todayLogs = waterLogsForDate(date);
  const todayTotalOz = todayLogs.reduce((s, w) => s + (parseFloat(w.amountOz) || 0), 0);
  const remainingOz = goalOz - todayTotalOz;

  // Clean, natural serving sizes per unit system — converting 8/16/24oz
  // straight to mL gives ugly numbers (237/473/710) that don't match what
  // someone using mL would actually reach for.
  const QUICK_ADD_OZ = useMl ? [250, 500, 750, 1000].map(mlToOz) : [8, 16, 24, 32];

  // Fires only on the add that actually crosses the line — not on every
  // add once you're already over goal, and not retroactively if you edit
  // the goal itself down to something you'd already hit.
  function checkGoalCelebration(addedOz) {
    if (!(goalOz > 0)) return;
    const wasBelow = todayTotalOz < goalOz;
    const nowAtOrAbove = todayTotalOz + addedOz >= goalOz;
    if (wasBelow && nowAtOrAbove) {
      toastSuccess(`🎉 Nice work — you hit your ${fmt(toDisplay(goalOz))} ${unitLabel} water goal for today.`);
      setCelebrating(true);
      setTimeout(() => setCelebrating(false), 800);
    }
  }

  async function handleLog() {
    if (!amountVal || !timeVal) return;
    setSaving(true);
    const addedOz = Math.max(0, toOz(parseFloat(amountVal) || 0));
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      time: timeVal,
      amountOz: addedOz,
    };
    await onAdd(date, entry);
    checkGoalCelebration(addedOz);
    setAmountVal("");
    setSaving(false);
  }

  async function handleQuickAdd(oz) {
    setSaving(true);
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      time: `${String(new Date().getHours()).padStart(2, "0")}:${String(new Date().getMinutes()).padStart(2, "0")}`,
      amountOz: oz,
    };
    await onAdd(date, entry);
    checkGoalCelebration(oz);
    setSaving(false);
  }

  function saveGoal() {
    const val = parseFloat(goalDraft);
    if (val > 0) onProfileChange({ waterGoalOz: toOz(val) });
    setEditingGoal(false);
  }

  return (
    <div className="ft-mobile-stack" style={{ display: "grid", gridTemplateColumns: "1fr min(340px, 100%)", gap: 16 }}>
      {/* Main panel */}
      <div className="ft-card" style={{ padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
          <Droplet size={18} color={COLORS.ember} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 15, color: COLORS.cream }}>Daily Water Log</div>
            <div style={{ fontSize: 11, color: COLORS.creamDim }}>Track intake against a daily goal</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 11, color: COLORS.creamDim }}>Units:</span>
            {["oz", "ml"].map(u => (
              <button key={u} className="ft-btn ft-btn-ghost" onClick={toggleUnits}
                style={{ padding: "5px 12px", fontSize: 12, border: `1px solid ${(u === "ml") === useMl ? COLORS.ember : COLORS.border}`, color: (u === "ml") === useMl ? COLORS.ember : COLORS.creamDim }}>
                {u}
              </button>
            ))}
          </div>
        </div>

        {/* Date */}
        <div style={{ marginBottom: 14 }}>
          <span className="ft-label">Date</span>
          <input type="date" className="ft-input" style={{ maxWidth: 200 }} value={date} onChange={e => setDate(e.target.value)} />
        </div>

        {/* Progress vs goal */}
        <div className="ft-card-raised" style={{ padding: 18, marginBottom: 16, display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
          <div style={{ position: "relative", width: 130, height: 130 }}>
            <WaterRing size={130} strokeWidth={12} consumed={todayTotalOz} goal={goalOz} gradId="waterTabRingGrad" celebrate={celebrating} />
            <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
              <div className="ft-mono ft-grad-text" style={{ fontWeight: 700, fontSize: 26, letterSpacing: "-0.02em" }}>{toDisplay(todayTotalOz)}</div>
              <div style={{ fontSize: 11, color: COLORS.creamDim, marginTop: 1 }}>of {toDisplay(goalOz)} {unitLabel}</div>
            </div>
          </div>
          <div style={{ fontSize: 11.5, color: COLORS.creamDim, marginTop: 10 }}>
            {remainingOz > 0 ? `${toDisplay(remainingOz)} ${unitLabel} remaining today` : "Goal hit for today ✓"}
          </div>

          {!editingGoal ? (
            <button className="ft-btn ft-btn-ghost" style={{ fontSize: 11, padding: "4px 9px", marginTop: 8 }} onClick={() => { setGoalDraft(String(toDisplay(baseGoalOz))); setEditingGoal(true); }}>
              Goal: {toDisplay(goalOz)} {unitLabel} <Pencil size={10} style={{ marginLeft: 4 }} />
            </button>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8 }}>
              <input className="ft-input" type="number" inputMode="decimal" onFocus={selectOnFocus} value={goalDraft} onChange={e => setGoalDraft(e.target.value)} style={{ width: 80, padding: "5px 8px", fontSize: 12 }} autoFocus />
              <button className="ft-btn ft-btn-primary" style={{ padding: "5px 10px", fontSize: 11 }} onClick={saveGoal}>Save</button>
            </div>
          )}

          {tookCreatineToday && (
            <div style={{ fontSize: 10, color: COLORS.ember, marginTop: 8, display: "flex", alignItems: "center", gap: 4 }}>
              <Droplet size={10} /> +{toDisplay(creatineBonusOz)} {unitLabel} added — {creatineSatPct >= 90 ? "maintenance dose" : creatineSatPct >= 50 ? "still building saturation" : "early stage, closer to a loading-like need"}.
            </div>
          )}
          {!profile.waterGoalOz && (
            <div style={{ fontSize: 10, color: COLORS.creamDim, marginTop: 6 }}>
              Suggested from your weight (~half your bodyweight in oz) — adjust anytime, this is just a starting point.
            </div>
          )}
        </div>

        {/* Quick add */}
        <div className="ft-label" style={{ marginBottom: 8 }}>Quick add</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
          {QUICK_ADD_OZ.map(oz => (
            <button key={oz} className="ft-btn ft-btn-ghost" disabled={saving} onClick={() => handleQuickAdd(oz)} style={{ fontSize: 12.5 }}>
              <Droplet size={12} /> +{toDisplay(oz)} {unitLabel}
            </button>
          ))}
        </div>

        {/* Manual entry */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
          <div style={{ minWidth: 0 }}>
            <span className="ft-label">Amount ({unitLabel})</span>
            <input
              className="ft-input"
              type="number" inputMode="decimal"
              step="1"
              placeholder={useMl ? "e.g. 500" : "e.g. 16"}
              value={amountVal}
              onFocus={selectOnFocus}
              onChange={e => setAmountVal(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleLog()}
              style={{ fontSize: 18, fontWeight: 700 }}
            />
          </div>
          <div style={{ minWidth: 0 }}>
            <span className="ft-label" style={{ display: "flex", alignItems: "center", gap: 4 }}><Clock size={11} /> Time</span>
            <input className="ft-input" type="time" value={timeVal} onChange={e => setTimeVal(e.target.value)} />
          </div>
        </div>

        <button
          className="ft-btn ft-btn-primary"
          onClick={handleLog}
          disabled={!amountVal || !timeVal || saving}
          style={{ opacity: !amountVal ? 0.6 : 1, marginBottom: 20 }}
        >
          <Droplet size={14} /> {saving ? "Saving…" : "Log Water"}
        </button>

        {/* Today's logs */}
        <div className="ft-label" style={{ marginBottom: 8 }}>
          {prettyDate(date)} — {todayLogs.length} entr{todayLogs.length !== 1 ? "ies" : "y"}
        </div>
        {todayLogs.length === 0 ? (
          <div style={{ fontSize: 13, color: COLORS.creamDim }}>No water logged for this date yet.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {[...todayLogs].sort((a, b) => a.time.localeCompare(b.time)).map(w => (
              <div key={w.id} className="ft-row-enter" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", background: COLORS.surface, borderRadius: 10, border: `1px solid ${COLORS.border}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div className="ft-mono" style={{ fontSize: 18, fontWeight: 700, color: COLORS.ember }}>{toDisplay(w.amountOz)}</div>
                  <div>
                    <div style={{ fontSize: 12, color: COLORS.cream, fontWeight: 500 }}>{unitLabel}</div>
                    <div style={{ fontSize: 11, color: COLORS.creamDim, display: "flex", alignItems: "center", gap: 4 }}>
                      <Clock size={10} /> {w.time}
                    </div>
                  </div>
                </div>
                <button className="ft-btn ft-btn-danger" onClick={() => onDelete(date, w.id)}><Trash2 size={13} /></button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Sidebar */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="ft-card" style={{ padding: 14 }}>
          <div className="ft-label" style={{ marginBottom: waterDates.length ? 8 : 0 }}>Your water journey</div>
          {waterDates.length === 0 ? (
            <div style={{ fontSize: 13, color: COLORS.creamDim }}>Log water to start your journey.</div>
          ) : (
            <button className="ft-btn ft-btn-ghost" style={{ width: "100%", justifyContent: "center" }} onClick={() => setHistoryOpen(true)}>
              <ExternalLink size={13} /> View history ({waterDates.length})
            </button>
          )}
        </div>
      </div>

      {historyOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
          onClick={e => { if (e.target === e.currentTarget) setHistoryOpen(false); }}>
          <div className="ft-card" style={{ padding: 20, maxWidth: 480, width: "100%", maxHeight: "80vh", overflowY: "auto", overscrollBehavior: "contain" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <div className="ft-label" style={{ marginBottom: 0 }}>Water log history</div>
              <button className="ft-btn ft-btn-ghost" style={{ padding: "4px 8px" }} onClick={() => setHistoryOpen(false)}><X size={14} /></button>
            </div>
            {[...waterDates].sort().reverse().map((d) => {
              const logs = waterLogsForDate(d);
              const dayTotal = logs.reduce((s, w) => s + (parseFloat(w.amountOz) || 0), 0);
              const metGoal = dayTotal >= goalOz;
              return (
                <div key={d} style={{ padding: "10px 0", borderBottom: `1px solid ${COLORS.border}` }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{prettyDate(d)}</div>
                    <span className="ft-mono" style={{ fontSize: 12, fontWeight: 700, color: metGoal ? COLORS.mint : COLORS.creamDim }}>
                      {toDisplay(dayTotal)} {unitLabel}{metGoal ? " ✓" : ""}
                    </span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {[...logs].sort((a, b) => a.time.localeCompare(b.time)).map((w) => (
                      <div key={w.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <span className="ft-mono" style={{ fontSize: 13, color: COLORS.ember, fontWeight: 700 }}>{toDisplay(w.amountOz)} {unitLabel}</span>
                        <span style={{ fontSize: 11, color: COLORS.creamDim, display: "flex", alignItems: "center", gap: 4 }}><Clock size={10} /> {w.time}</span>
                        <button className="ft-btn-icon" style={{ background: "none", border: "none", color: COLORS.danger, cursor: "pointer" }} onClick={() => onDelete(d, w.id)}><Trash2 size={13} /></button>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------
   Trends
----------------------------------------------------------------*/

// Compares each exercise's best set this week (last 7 logged days) against
// its best set the prior week — real week-over-week progression, separate
// from the single-suggestion logic used in the Coach's note. Only includes
// exercises with data in both windows, since a lone session has nothing to
// compare against yet.
function buildWeeklyLiftComparisons(workoutSessions) {
  if (!workoutSessions || workoutSessions.length === 0) return [];
  const oneDay = 24 * 60 * 60 * 1000;
  const allDates = workoutSessions.map((s) => new Date(s.date).getTime()).sort((a, b) => a - b);
  const latest = allDates[allDates.length - 1];
  const thisWeekStart = latest - 6 * oneDay;
  const lastWeekEnd = latest - 7 * oneDay;
  const lastWeekStart = latest - 13 * oneDay;

  const byExercise = {};
  workoutSessions.forEach((s) => { (byExercise[s.exercise] ||= []).push(s); });

  function bestSet(sessions) {
    let best = null;
    sessions.forEach((s) => (s.sets || []).forEach((set) => {
      const w = parseFloat(set.weight) || 0;
      const r = parseInt(set.reps) || 0;
      if (!best || w > best.weight || (w === best.weight && r > best.reps)) best = { weight: w, reps: r };
    }));
    return best;
  }

  const results = [];
  Object.entries(byExercise).forEach(([exercise, sessions]) => {
    const thisWeek = sessions.filter((s) => { const t = new Date(s.date).getTime(); return t >= thisWeekStart && t <= latest; });
    const lastWeek = sessions.filter((s) => { const t = new Date(s.date).getTime(); return t >= lastWeekStart && t <= lastWeekEnd; });
    if (!thisWeek.length || !lastWeek.length) return;
    const thisBest = bestSet(thisWeek);
    const lastBest = bestSet(lastWeek);
    if (!thisBest || !lastBest) return;

    const weightDelta = thisBest.weight - lastBest.weight;
    const repsDelta = thisBest.reps - lastBest.reps;
    let kind, badge;
    if (weightDelta > 0 && repsDelta >= 0) { kind = "pr"; badge = `PR · +${fmt(weightDelta)} lbs`; }
    else if (weightDelta > 0) { kind = "up"; badge = `+${fmt(weightDelta)} lbs`; }
    else if (weightDelta === 0 && repsDelta > 0) { kind = "up"; badge = `+${repsDelta} reps`; }
    else if (weightDelta === 0 && repsDelta === 0) { kind = "flat"; badge = "No change"; }
    else { kind = "down"; badge = weightDelta < 0 ? `${fmt(weightDelta)} lbs` : `${repsDelta} reps`; }

    results.push({ exercise, lastBest, thisBest, kind, badge, group: thisWeek[thisWeek.length - 1].group });
  });

  const order = { pr: 0, up: 1, flat: 2, down: 3 };
  results.sort((a, b) => (order[a.kind] ?? 2) - (order[b.kind] ?? 2));
  return results;
}

const LIFT_BADGE_STYLE = {
  pr: { bg: COLORS.emberDim, color: COLORS.ember },
  up: { bg: COLORS.mintDim, color: COLORS.mint },
  flat: { bg: COLORS.surfaceRaised, color: COLORS.creamDim },
  down: { bg: COLORS.dangerDim, color: COLORS.danger },
};

function WeeklyLiftImprovements({ workoutSessions }) {
  const rows = useMemo(() => buildWeeklyLiftComparisons(workoutSessions), [workoutSessions]);

  if (!rows.length) {
    return (
      <div className="ft-card" style={{ padding: 18 }}>
        <div className="ft-label" style={{ marginBottom: 2 }}>This week's lifts</div>
        <div style={{ fontSize: 12.5, color: COLORS.creamDim, marginTop: 8 }}>
          Train the same lift on back-to-back weeks and week-over-week progress will show up here.
        </div>
      </div>
    );
  }

  return (
    <div className="ft-card" style={{ padding: 18 }}>
      <div className="ft-label" style={{ marginBottom: 2 }}>This week's lifts</div>
      <div style={{ fontSize: 11.5, color: COLORS.creamDim, marginBottom: 12 }}>Comparing this week's top set to last week's, per exercise.</div>
      {rows.map((r) => {
        const style = LIFT_BADGE_STYLE[r.kind] || LIFT_BADGE_STYLE.flat;
        return (
          <div key={r.exercise} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: `1px solid ${COLORS.border}` }}>
            <div>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: COLORS.cream, marginBottom: 3 }}>{r.exercise}</div>
              <div className="ft-mono" style={{ fontSize: 11.5, color: COLORS.creamDim }}>
                {fmt(r.lastBest.weight)} lbs × {r.lastBest.reps} <span style={{ margin: "0 2px" }}>→</span> {fmt(r.thisBest.weight)} lbs × {r.thisBest.reps}
              </div>
            </div>
            <span style={{ fontSize: 10.5, fontWeight: 700, padding: "5px 10px", borderRadius: 999, whiteSpace: "nowrap", background: style.bg, color: style.color }}>
              {r.badge}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// Smooths a series by averaging each point with up to `window - 1`
// preceding points — reduces day-to-day water-weight noise so the trend
// line reads clearly instead of zig-zagging.
function rollingAverage(data, key, window = 3) {
  return data.map((d, i) => {
    const slice = data.slice(Math.max(0, i - window + 1), i + 1).filter((x) => x[key] != null);
    const avg = slice.length ? slice.reduce((s, x) => s + x[key], 0) / slice.length : null;
    return { ...d, [key]: avg == null ? null : Math.round(avg * 100) / 100 };
  });
}



const BIG_THREE_LIFTS = [
  { key: "squat", exercise: "Barbell Squat" },
  { key: "bench", exercise: "Barbell Bench Press" },
  { key: "deadlift", exercise: "Barbell Deadlift" },
];

function currentMaxAttempt(attempts) {
  const passes = attempts.filter(a => a.pass);
  if (!passes.length) return null;
  return passes.reduce((best, a) => a.weight > best.weight ? a : best, passes[0]);
}

// One tiny reusable count-up — runs a rAF loop nudging a local display
// value toward the real one over `duration`, independent of React's
// normal render cycle so it doesn't fight the surrounding re-renders.
function animateNumber(from, to, duration, onFrame) {
  const start = performance.now();
  function tick(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    onFrame(Math.round(from + (to - from) * eased));
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// DOTS (Dynamic Objective Team Scoring) — the current standard
// bodyweight-normalized powerlifting score outside IPF-affiliated meets
// (USAPL/USPA use it for Best Lifter awards; it's also the default on
// OpenPowerlifting.org). Coefficients per the evaluation paper multiple
// public DOTS calculators cite (Kopayev, Onyshchenko & Stetsenko,
// "Evaluation of Wilks, Wilks-2, DOTS, IPF and GoodLift Formulas,"
// referenced via British Powerlifting). Both bodyweight and total are
// in kg per the formula's own definition, converted from this app's
// lb-based storage before computing. Uses CURRENT bodyweight against
// the CURRENT best total — same simplification every public DOTS
// calculator makes, since a per-lift historical bodyweight isn't
// something any of them ask for either.
const DOTS_COEFFICIENTS = {
  male: { A: -307.75076, B: 24.0900756, C: -0.1918759221, D: 0.0007391293, E: -0.000001093 },
  female: { A: -57.96288, B: 13.6175032, C: -0.1126655495, D: 0.0005158568, E: -0.0000010706 },
};
function computeDotsScore(gender, bodyweightLbs, totalLbs) {
  if (!bodyweightLbs || !totalLbs) return null;
  const coef = DOTS_COEFFICIENTS[gender] || DOTS_COEFFICIENTS.male;
  const bw = bodyweightLbs / 2.20462;
  const total = totalLbs / 2.20462;
  const denom = coef.A + coef.B * bw + coef.C * bw ** 2 + coef.D * bw ** 3 + coef.E * bw ** 4;
  if (denom <= 0) return null; // outside the polynomial's realistic bodyweight range
  return total * (500 / denom);
}
function dotsLevel(score) {
  if (score < 300) return "Beginner";
  if (score < 400) return "Novice";
  if (score < 450) return "Intermediate";
  if (score < 500) return "Advanced";
  if (score < 600) return "Elite";
  return "World class";
}

// Warm-up pyramid for a planned max attempt — the standard ramping
// protocol (low reps, rising rest as the weight climbs) used to test a
// true 1RM without pre-fatiguing: light volume early, singles once it
// gets heavy, real recovery before the actual attempt. Percentages are
// approximate on purpose ("~50%" etc., matching how lifters actually
// talk about warm-up jumps) — weight on the bar is rounded to the
// nearest 5 lbs, the smallest increment most gyms can actually load.
const MAX_DAY_PYRAMID_STEPS = [
  { pct: 0.5, reps: 5, rest: "2 mins" },
  { pct: 0.6, reps: 3, rest: "2 mins" },
  { pct: 0.7, reps: 2, rest: "2 mins" },
  { pct: 0.8, reps: 1, rest: "3 mins" },
  { pct: 0.9, reps: 1, rest: "3-4 mins" },
];
function buildMaxDayPlan(goalWeight) {
  const steps = MAX_DAY_PYRAMID_STEPS.map(s => ({
    pctLabel: `~${Math.round(s.pct * 100)}%`,
    weight: Math.max(5, Math.round((goalWeight * s.pct) / 5) * 5),
    reps: s.reps,
    rest: s.rest,
  }));
  steps.push({ pctLabel: "Attempt", weight: goalWeight, reps: 1, rest: "Celebrate / rest" });
  return steps;
}

function MaxTrackerTab({ userId, maxAttempts, setMaxAttempts, latestWeight, gender, profile, onProfileChange }) {
  const [openForm, setOpenForm] = useState(null); // lift key with its log-attempt form open
  const [weightInput, setWeightInput] = useState("");
  const [dateInput, setDateInput] = useState(todayStr());
  const [resultInput, setResultInput] = useState(null); // "pass" | "fail"
  const [saving, setSaving] = useState(false);
  const [justPRd, setJustPRd] = useState(null); // lift key celebrating a fresh max
  const [displayOverride, setDisplayOverride] = useState({}); // key -> number, mid count-up only
  const [confetti, setConfetti] = useState([]); // [{id, dx, dy, rot}], cleared after the burst
  const [plannerLift, setPlannerLift] = useState(BIG_THREE_LIFTS[0].key);
  const [plannerGoalInput, setPlannerGoalInput] = useState("");
  const [plannerPlanOpen, setPlannerPlanOpen] = useState(true);
  const goals = profile?.maxDayGoals || {};

  // Rounded here too, not just in the warm-up steps — every number in the
  // plan is barbell work, and the only way to actually change the weight
  // on a bar is a plate change in 5 lb steps. Without this, someone
  // typing a goal like 237 would get a plan where the warm-up rows are
  // all clean 5s but the attempt itself isn't — the one number that
  // matters most wouldn't match how the plan can actually be loaded.
  function saveGoal() {
    const raw = parseFloat(plannerGoalInput);
    if (!raw) return;
    const weight = Math.round(raw / 5) * 5;
    onProfileChange({ maxDayGoals: { ...goals, [plannerLift]: weight } });
    setPlannerGoalInput(String(weight));
    setPlannerPlanOpen(true);
  }
  function clearGoal() {
    onProfileChange({ maxDayGoals: { ...goals, [plannerLift]: null } });
    setPlannerGoalInput("");
  }

  const byLift = useMemo(() => {
    const map = {};
    for (const { key, exercise } of BIG_THREE_LIFTS) {
      map[key] = maxAttempts.filter(a => a.exercise === exercise).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    }
    return map;
  }, [maxAttempts]);

  const total = BIG_THREE_LIFTS.reduce((sum, l) => {
    const max = currentMaxAttempt(byLift[l.key] || []);
    return sum + (max ? max.weight : 0);
  }, 0);

  function openLog(key) {
    setOpenForm(key);
    setWeightInput("");
    setDateInput(todayStr());
    setResultInput(null);
    setJustPRd(null);
  }

  function fireConfetti() {
    const particles = Array.from({ length: 10 }, (_, i) => ({
      id: `${Date.now()}-${i}`,
      dx: Math.round((Math.random() - 0.5) * 110),
      dy: Math.round(-(35 + Math.random() * 55)),
      rot: Math.round(Math.random() * 360),
    }));
    setConfetti(particles);
    setTimeout(() => setConfetti([]), 850);
  }

  async function saveAttempt(key) {
    const weight = parseFloat(weightInput);
    if (!weight || !dateInput || !resultInput) return;
    const lift = BIG_THREE_LIFTS.find(l => l.key === key);
    const prevMax = currentMaxAttempt(byLift[key] || []);
    setSaving(true);
    const saved = await insertMaxAttempt(userId, { exercise: lift.exercise, weight, date: dateInput, pass: resultInput === "pass" });
    setSaving(false);
    if (!saved) return;
    setMaxAttempts(prev => [...prev, saved]);
    setOpenForm(null);

    const isPR = resultInput === "pass" && (!prevMax || weight > prevMax.weight);
    if (isPR) {
      setJustPRd(key);
      setDisplayOverride(prev => ({ ...prev, [key]: prevMax ? prevMax.weight : 0 }));
      animateNumber(prevMax ? prevMax.weight : 0, weight, 600, (v) => setDisplayOverride(prev => ({ ...prev, [key]: v })));
      setTimeout(() => setDisplayOverride(prev => { const next = { ...prev }; delete next[key]; return next; }), 650);
      fireConfetti();
    }
  }

  async function removeAttempt(key, id) {
    setMaxAttempts(prev => prev.filter(a => a.id !== id));
    await deleteMaxAttempt(userId, id);
  }

  return (
    <div>
      <div className="ft-card ft-card-hero" style={{ padding: 18, marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
        <div>
          <div className="ft-label" style={{ marginBottom: 2 }}>Big 3 total</div>
          <div style={{ fontSize: 11.5, color: COLORS.creamDim }}>Squat + bench + deadlift</div>
        </div>
        <div className="ft-mono ft-grad-text" style={{ fontSize: 30, fontWeight: 700 }}>{fmt(total)} lbs</div>
        {(() => {
          const dots = total > 0 ? computeDotsScore(gender, latestWeight, total) : null;
          if (dots == null) {
            return (
              <div style={{ fontSize: 11, color: COLORS.creamDim, maxWidth: 140, textAlign: "right" }}>
                {latestWeight ? "Log a max to see your DOTS score" : "Log a weigh-in and a max to see your DOTS score"}
              </div>
            );
          }
          return (
            <div style={{ textAlign: "right" }}>
              <div className="ft-mono" style={{ fontSize: 20, fontWeight: 700, color: COLORS.mint }}>{fmt(dots, 1)}</div>
              <div style={{ fontSize: 10.5, color: COLORS.creamDim, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.03em" }}>DOTS · {dotsLevel(dots)}</div>
            </div>
          );
        })()}
      </div>

      <div className="ft-card" style={{ padding: 18, marginBottom: 14 }}>
        <div className="ft-label" style={{ marginBottom: 4 }}>Max day planner</div>
        <div style={{ fontSize: 11.5, color: COLORS.creamDim, marginBottom: 12, lineHeight: 1.4 }}>
          Pick a lift and a goal weight to get a warm-up ramp for attempt day. Every weight in the plan — including the goal itself — rounds to the nearest 5 lbs, since that's the smallest real change you can make loading a barbell.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select
            className="ft-select"
            value={plannerLift}
            onChange={(e) => { setPlannerLift(e.target.value); setPlannerGoalInput(goals[e.target.value] != null ? String(goals[e.target.value]) : ""); }}
            style={{ flex: "1 1 160px" }}
          >
            {BIG_THREE_LIFTS.map(l => <option key={l.key} value={l.key}>{l.exercise}</option>)}
          </select>
          <input
            className="ft-input" type="number" inputMode="decimal" step="5"
            placeholder="Goal weight (lbs)" value={plannerGoalInput}
            onChange={(e) => setPlannerGoalInput(e.target.value)} onFocus={(e) => e.target.select()}
            style={{ flex: "1 1 140px" }}
          />
          <button className="ft-btn ft-btn-primary" disabled={!plannerGoalInput} onClick={saveGoal}>Save goal</button>
        </div>

        {goals[plannerLift] != null && (
          <div style={{ background: COLORS.surfaceRaised, borderRadius: 8, padding: "10px 12px", marginTop: 14 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <button onClick={() => setPlannerPlanOpen(o => !o)} style={{ background: "none", border: "none", color: COLORS.ember, cursor: "pointer", fontSize: 12, fontWeight: 700, padding: 0, display: "flex", alignItems: "center", gap: 5 }}>
                <Target size={13} /> Warm-up ramp for {fmt(goals[plannerLift])} lbs
                <ChevronDown size={13} style={{ transform: plannerPlanOpen ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
              </button>
              <button className="ft-btn ft-btn-ghost" style={{ fontSize: 10.5, padding: "4px 10px" }} onClick={clearGoal}>Clear goal</button>
            </div>
            {plannerPlanOpen && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 0.6fr 1fr", gap: "4px 6px", fontSize: 11 }}>
                <div style={{ color: COLORS.creamDim, fontWeight: 700 }}>% of max</div>
                <div style={{ color: COLORS.creamDim, fontWeight: 700 }}>Weight</div>
                <div style={{ color: COLORS.creamDim, fontWeight: 700 }}>Reps</div>
                <div style={{ color: COLORS.creamDim, fontWeight: 700 }}>Rest</div>
                {buildMaxDayPlan(goals[plannerLift]).map((step, i) => (
                  <div key={i} style={{ display: "contents" }}>
                    <div style={{ color: step.pctLabel === "Attempt" ? COLORS.mint : COLORS.cream, fontWeight: step.pctLabel === "Attempt" ? 700 : 500 }}>{step.pctLabel}</div>
                    <div className="ft-mono" style={{ color: COLORS.cream, fontWeight: 600 }}>{fmt(step.weight)} lbs</div>
                    <div style={{ color: COLORS.cream }}>{step.reps}</div>
                    <div style={{ color: COLORS.creamDim }}>{step.rest}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
        {BIG_THREE_LIFTS.map(({ key, exercise }) => {
          const history = byLift[key] || [];
          const max = currentMaxAttempt(history);
          const recent = history.slice(-5);
          const recentWeights = recent.map(a => a.weight);
          const spanMax = recentWeights.length ? Math.max(...recentWeights) : 0;
          const spanMin = recentWeights.length ? Math.min(...recentWeights) : 0;
          const spanRange = Math.max(1, spanMax - spanMin);
          const isOpen = openForm === key;
          const pr = justPRd === key;
          const shownValue = displayOverride[key] ?? (max ? max.weight : null);

          return (
            <div key={key} className="ft-card" style={{ padding: 14, borderColor: pr ? COLORS.mint : undefined, transition: "border-color 0.4s ease", position: "relative", overflow: "hidden" }}>
              {confetti.length > 0 && pr && confetti.map(p => (
                <span key={p.id} style={{
                  position: "absolute", left: "40%", top: 40, width: 5, height: 5, borderRadius: 2,
                  background: COLORS.mint, "--dx": `${p.dx}px`, "--dy": `${p.dy}px`, "--rot": `${p.rot}deg`,
                  animation: "ftConfettiBurst 0.8s ease-out forwards", pointerEvents: "none",
                }} />
              ))}
              <style>{`@keyframes ftConfettiBurst { to { transform: translate(var(--dx), var(--dy)) rotate(var(--rot)); opacity: 0; } } `}</style>

              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <div style={{ width: 26, height: 26, borderRadius: 7, background: COLORS.emberDim, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <Dumbbell size={14} color={COLORS.ember} />
                </div>
                <span style={{ fontSize: 13.5, fontWeight: 700, color: COLORS.cream }}>{exercise}</span>
              </div>

              <div className="ft-mono" style={{ fontSize: 26, fontWeight: 700, color: pr ? COLORS.mint : COLORS.cream }}>
                {shownValue != null ? `${fmt(shownValue)} lbs` : "—"}
              </div>
              <div style={{ fontSize: 11, color: COLORS.creamDim }}>
                {max ? `as of ${prettyDate(max.date).split(",")[0]}` : "no confirmed max yet"}
              </div>
              {pr && <div style={{ fontSize: 11, fontWeight: 700, color: COLORS.mint, marginTop: 3, display: "flex", alignItems: "center", gap: 4 }}><Trophy size={12} /> New max</div>}
              {goals[key] != null && (
                <div style={{ fontSize: 11, color: COLORS.ember, marginTop: 3, display: "flex", alignItems: "center", gap: 4 }}>
                  <Target size={11} /> Goal set: {fmt(goals[key])} lbs
                </div>
              )}

              {recent.length > 0 && (
                <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: 28, margin: "10px 0" }}>
                  {recent.map((a, i) => (
                    <div key={i} title={`${a.weight} lbs, ${a.pass ? "pass" : "fail"}`} style={{
                      flex: 1, height: `${25 + ((a.weight - spanMin) / spanRange) * 75}%`, borderRadius: 2,
                      background: a.pass ? COLORS.ember : COLORS.border,
                    }} />
                  ))}
                </div>
              )}

              {history.length > 0 && (
                <div style={{ borderTop: `1px solid ${COLORS.border}`, paddingTop: 8, marginBottom: 10, display: "flex", flexDirection: "column", gap: 5 }}>
                  {[...history].reverse().slice(0, 4).map(a => (
                    <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: a.pass ? COLORS.mint : COLORS.danger, flexShrink: 0 }} />
                      <span style={{ color: COLORS.creamDim, flex: 1 }}>{prettyDate(a.date).split(",")[0]}</span>
                      <span className="ft-mono" style={{ fontWeight: 600 }}>{fmt(a.weight)} lbs</span>
                      <button onClick={() => removeAttempt(key, a.id)} aria-label="Delete attempt" style={{ background: "none", border: "none", color: COLORS.creamDim, cursor: "pointer", padding: 2 }}><X size={11} /></button>
                    </div>
                  ))}
                </div>
              )}

              {isOpen ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <input className="ft-input" type="number" inputMode="decimal" placeholder="Weight (lbs)" value={weightInput} onChange={e => setWeightInput(e.target.value)} onFocus={e => e.target.select()} />
                  <input className="ft-input" type="date" value={dateInput} onChange={e => setDateInput(e.target.value)} />
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={() => setResultInput("pass")}
                      style={{ flex: 1, padding: "8px 0", borderRadius: 8, cursor: "pointer", border: `1px solid ${resultInput === "pass" ? COLORS.mint : COLORS.border}`, background: resultInput === "pass" ? COLORS.mintDim : "transparent", color: resultInput === "pass" ? COLORS.mint : COLORS.creamDim, fontWeight: 700, fontSize: 12.5 }}
                    >
                      Pass
                    </button>
                    <button
                      onClick={() => setResultInput("fail")}
                      style={{ flex: 1, padding: "8px 0", borderRadius: 8, cursor: "pointer", border: `1px solid ${resultInput === "fail" ? COLORS.danger : COLORS.border}`, background: resultInput === "fail" ? COLORS.dangerDim : "transparent", color: resultInput === "fail" ? COLORS.danger : COLORS.creamDim, fontWeight: 700, fontSize: 12.5 }}
                    >
                      Fail
                    </button>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button className="ft-btn ft-btn-primary" style={{ flex: 1 }} disabled={saving || !weightInput || !resultInput} onClick={() => saveAttempt(key)}>
                      {saving ? "Saving…" : "Save attempt"}
                    </button>
                    <button className="ft-btn ft-btn-ghost" onClick={() => setOpenForm(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <button className="ft-btn ft-btn-ghost" style={{ width: "100%" }} onClick={() => openLog(key)}>
                  <Plus size={13} /> Log attempt
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SetCoverageTab({ workoutSessions, profile, onProfileChange }) {
  const coverage = useMemo(() => computeSetCoverageDetailed(workoutSessions, ANATOMICAL_GROUPS), [workoutSessions]);
  // Whether ANYTHING has been logged this window — deliberately checked
  // against direct sets only. Indirect credit only ever flows in from
  // another group's direct sessions, so if nothing anywhere has direct
  // sets, there's nothing to show regardless of which mode is selected.
  const hasAny = coverage.some(c => c.direct > 0);
  const [expandedGroup, setExpandedGroup] = useState(null);
  const [trendGroup, setTrendGroup] = useState(null);
  const [customizing, setCustomizing] = useState(false);
  // Target Hit mirrors the tab's original behavior exactly — direct sets
  // only, same badge/target logic, untouched by anything below. Volume
  // Sets is a second, purely informational lens that adds indirect
  // ("fractional") credit on top — it never changes what counts as
  // "hit," on purpose, so starring a priority muscle still means it
  // needs real direct work.
  const [coverageMode, setCoverageMode] = useState("target");

  // Per-muscle targets: up to 2 "priority" groups aim for 20 sets/week
  // (the top of the research range), everything else gets a user-chosen
  // target between 10-14. Persisted on the profile so it follows the
  // person across devices, not the browser. Null = defaults: no
  // priorities, 10 (the research floor) for everything.
  const PRIORITY_TARGET = 20;
  const cfg = profile?.setCoverageTargets || {};
  const priority = Array.isArray(cfg.priority) ? cfg.priority : [];
  const customTargets = cfg.targets || {};
  function targetFor(group) {
    if (priority.includes(group)) return PRIORITY_TARGET;
    const t = parseInt(customTargets[group]);
    return t >= 10 && t <= 14 ? t : 10;
  }
  function togglePriority(group) {
    let next;
    if (priority.includes(group)) next = priority.filter(g => g !== group);
    else if (priority.length >= 2) return; // hard cap at 2 — that's the point of "priority"
    else next = [...priority, group];
    onProfileChange({ setCoverageTargets: { priority: next, targets: customTargets } });
  }
  function setGroupTarget(group, t) {
    onProfileChange({ setCoverageTargets: { priority, targets: { ...customTargets, [group]: t } } });
  }

  function statusFor(sets, target) {
    if (sets === 0) return { label: "No sets logged", color: COLORS.creamDim };
    if (sets < target) return { label: `Building up`, color: COLORS.amber };
    return { label: "Target hit", color: COLORS.mint };
  }

  // Trims trailing ".0" for whole numbers, keeps one decimal for
  // anything fractional (indirect credit is rarely a round number).
  function fmtSets(n) {
    return fmt(n, Number.isInteger(n) ? 0 : 1);
  }

  // Contributing sessions for whichever group is expanded — same 7-day
  // window as the headline number, so tapping "Chest: 4 sets" actually
  // shows you the 4 sets it's counting instead of leaving you to go dig
  // through History separately to reconstruct it.
  // Not memoized with an empty array — same staleness bug just found and
  // fixed in SplitDashboard's "today" — this would silently drift if the
  // tab stayed open across a midnight boundary.
  const cutoffStr = (() => {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 6);
    return localDateStr(d);
  })();
  const contributingSessions = useMemo(() => {
    if (!expandedGroup) return [];
    return (workoutSessions || [])
      .filter(s => s.group === expandedGroup && s.date >= cutoffStr)
      .sort((a, b) => b.date.localeCompare(a.date));
  }, [workoutSessions, expandedGroup, cutoffStr]);

  // Sampled weekly (not daily) for the trend chart — a rolling 7-day sum
  // barely moves day to day, so daily sampling would just be a noisy,
  // mostly-flat line. Weekly steps actually show the trend. Follows
  // whichever mode is active, same as the cards — direct only for
  // Target Hit, direct + indirect for Volume Sets.
  const trendData = useMemo(() => {
    if (!trendGroup) return [];
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const weeks = [];
    for (let i = 7; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i * 7);
      const ds = localDateStr(d);
      const result = computeSetCoverageDetailed(workoutSessions, [trendGroup], ds);
      const row = result[0];
      weeks.push({ label: i === 0 ? "This wk" : `${i}wk ago`, sets: coverageMode === "volume" ? (row?.total ?? 0) : (row?.direct ?? 0) });
    }
    return weeks;
  }, [workoutSessions, trendGroup, coverageMode]);

  return (
    <div>
      <div className="ft-card" style={{ padding: 18, marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div className="ft-label" style={{ marginBottom: 0 }}>Set Coverage — last 7 days</div>
          <button className="ft-btn ft-btn-ghost" style={{ fontSize: 11, padding: "4px 10px" }} onClick={() => setCustomizing(c => !c)}>
            {customizing ? "Done" : "Customize targets"}
          </button>
        </div>
        {!customizing && (
          <div style={{ display: "flex", gap: 4, padding: 3, background: COLORS.surfaceRaised, borderRadius: 8, width: "fit-content", marginBottom: 10 }}>
            <button
              onClick={() => setCoverageMode("target")}
              style={{ border: "none", borderRadius: 6, padding: "5px 12px", fontSize: 11.5, fontWeight: 700, cursor: "pointer", background: coverageMode === "target" ? COLORS.surface : "transparent", color: coverageMode === "target" ? COLORS.cream : COLORS.creamDim }}
            >
              Target hit
            </button>
            <button
              onClick={() => setCoverageMode("volume")}
              style={{ border: "none", borderRadius: 6, padding: "5px 12px", fontSize: 11.5, fontWeight: 700, cursor: "pointer", background: coverageMode === "volume" ? COLORS.surface : "transparent", color: coverageMode === "volume" ? COLORS.cream : COLORS.creamDim }}
            >
              Volume sets
            </button>
          </div>
        )}
        <div style={{ fontSize: 12, color: COLORS.creamDim, lineHeight: 1.5 }}>
          {customizing
            ? <>Star up to <b>2 priority muscles</b> — those aim for <b>{20} sets/week</b>, the top of the research range. Everything else gets its own target you pick between <b>10 and 14</b>.</>
            : coverageMode === "target"
              ? <>Total working sets per muscle group in a rolling 7-day window, regardless of which split day they came from. Priority muscles (★) target 20 sets/week; the rest use your chosen target. Research most consistently supports roughly 10–20 sets per muscle per week for hypertrophy.</>
              : <>Adds roughly half a set of credit for muscles trained indirectly by compound lifts (rows crediting biceps, presses crediting triceps, squats crediting glutes) — a coaching heuristic, not measured data. <b>Target Hit always uses direct sets only</b>; this view is informational and never changes whether a target counts as hit.</>}
        </div>
      </div>

      {!hasAny && !customizing ? (
        <div className="ft-card" style={{ padding: 40, textAlign: "center", color: COLORS.creamDim }}>
          Log a few workouts to see your set coverage here.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {coverage.map(({ group, direct, indirect, total, indirectSources }) => {
            const target = targetFor(group);
            const isPriority = priority.includes(group);
            const value = coverageMode === "target" ? direct : total;
            const hasData = coverageMode === "target" ? direct > 0 : total > 0;
            const status = coverageMode === "target" ? statusFor(direct, target) : null;
            const directPct = Math.min(100, (direct / target) * 100);
            const indirectPct = coverageMode === "volume" ? Math.min(100 - directPct, (indirect / target) * 100) : 0;
            const isExpanded = expandedGroup === group;
            return (
              <div key={group} className="ft-card" style={{ padding: 14, cursor: hasData && !customizing ? "pointer" : "default", borderColor: isPriority ? `${COLORS.ember}60` : undefined }} onClick={() => !customizing && hasData && setExpandedGroup(isExpanded ? null : group)}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: COLORS.cream, display: "flex", alignItems: "center", gap: 5 }}>
                    {customizing ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); togglePriority(group); }}
                        title={isPriority ? "Remove priority" : priority.length >= 2 ? "Two priorities already picked" : "Make priority (20 sets/wk)"}
                        style={{ background: "none", border: "none", padding: 0, cursor: priority.length >= 2 && !isPriority ? "not-allowed" : "pointer", display: "flex", opacity: priority.length >= 2 && !isPriority ? 0.35 : 1 }}
                      >
                        <Star size={15} fill={isPriority ? COLORS.ember : "none"} color={isPriority ? COLORS.ember : COLORS.creamDim} />
                      </button>
                    ) : (
                      isPriority && <Star size={13} fill={COLORS.ember} color={COLORS.ember} />
                    )}
                    {group}
                    {!customizing && hasData && <ChevronDown size={13} color={COLORS.creamDim} style={{ transform: isExpanded ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {coverageMode === "target" ? (
                      <span style={{ fontSize: 11, color: status.color, fontWeight: 600 }}>{status.label}</span>
                    ) : (
                      <span style={{ fontSize: 11, color: COLORS.creamDim }}>{fmtSets(direct)} direct + {fmtSets(indirect)} indirect</span>
                    )}
                    <span className="ft-mono" style={{ fontSize: 15, fontWeight: 700, color: COLORS.cream }}>{fmtSets(value)}<span style={{ fontSize: 11, color: COLORS.creamDim, fontWeight: 500 }}>/{target}</span></span>
                  </div>
                </div>
                {coverageMode === "target" ? (
                  <div style={{ height: 6, background: COLORS.surfaceRaised, borderRadius: 3, overflow: "hidden", position: "relative" }}>
                    <div style={{ height: "100%", width: `${directPct}%`, background: status.color, transition: "width 0.4s ease" }} />
                  </div>
                ) : (
                  <div style={{ height: 6, background: COLORS.surfaceRaised, borderRadius: 3, overflow: "hidden", display: "flex" }}>
                    <div style={{ height: "100%", width: `${directPct}%`, background: COLORS.ember, transition: "width 0.4s ease" }} />
                    <div style={{ height: "100%", width: `${indirectPct}%`, background: `repeating-linear-gradient(45deg, ${COLORS.ember}80, ${COLORS.ember}80 3px, transparent 3px, transparent 6px)`, transition: "width 0.4s ease" }} />
                  </div>
                )}
                {customizing && !isPriority && (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 10 }} onClick={e => e.stopPropagation()}>
                    <span style={{ fontSize: 10.5, color: COLORS.creamDim }}>Weekly target:</span>
                    {[10, 11, 12, 13, 14].map(t => (
                      <button
                        key={t}
                        onClick={() => setGroupTarget(group, t)}
                        style={{
                          fontSize: 11.5, fontWeight: 700, padding: "3px 9px", borderRadius: 999, cursor: "pointer",
                          border: `1px solid ${targetFor(group) === t ? COLORS.mint : COLORS.border}`,
                          background: targetFor(group) === t ? `${COLORS.mint}18` : "transparent",
                          color: targetFor(group) === t ? COLORS.mint : COLORS.creamDim,
                        }}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                )}
                {customizing && isPriority && (
                  <div style={{ fontSize: 10.5, color: COLORS.ember, marginTop: 10 }}>Priority — targeting {PRIORITY_TARGET} sets/week</div>
                )}
                {/* Explicit "drop-down" toggle — works the same whether this
                    group has hit its target or is still building up toward
                    it (status only changes the badge above, never whether
                    the breakdown is available). A dedicated button here
                    instead of only relying on tapping the whole card, so
                    it's obvious there's a breakdown to open. */}
                {!customizing && hasData && (
                  <button
                    className="ft-btn ft-btn-ghost"
                    onClick={(e) => { e.stopPropagation(); setExpandedGroup(isExpanded ? null : group); }}
                    aria-expanded={isExpanded}
                    style={{
                      display: "flex", alignItems: "center", gap: 5, marginTop: 10, fontSize: 11, padding: "5px 10px",
                      color: isExpanded ? COLORS.ember : COLORS.creamDim,
                      borderColor: isExpanded ? COLORS.ember : COLORS.border,
                      background: isExpanded ? `${COLORS.ember}14` : COLORS.surfaceRaised,
                    }}
                  >
                    <ChevronDown size={12} style={{ transform: isExpanded ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
                    {isExpanded ? "Hide sets" : "View sets"}
                  </button>
                )}
                {isExpanded && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${COLORS.border}`, display: "flex", flexDirection: "column", gap: 10 }} onClick={e => e.stopPropagation()}>
                    {contributingSessions.length === 0 ? (
                      <div style={{ fontSize: 11.5, color: COLORS.creamDim }}>
                        {coverageMode === "volume" ? "No direct sets in the last 7 days." : "No sets in the last 7 days."}
                      </div>
                    ) : contributingSessions.map(s => (
                      <div key={s.id} style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12 }}>
                          <span style={{ color: COLORS.cream, fontWeight: 600 }}>{s.exercise}</span>
                          <span className="ft-mono" style={{ color: COLORS.creamDim, fontSize: 11 }}>
                            {s.sets?.length || 0} set{(s.sets?.length || 0) !== 1 ? "s" : ""} · {prettyDate(s.date).split(",")[0]}
                          </span>
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                          {(s.sets || []).map((set, i) => (
                            <span
                              key={i}
                              className="ft-mono"
                              style={{ fontSize: 10.5, color: COLORS.creamDim, background: COLORS.surfaceRaised, border: `1px solid ${COLORS.border}`, borderRadius: 5, padding: "2px 7px" }}
                            >
                              {formatSetDetail(set)}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                    {coverageMode === "volume" && indirectSources.length > 0 && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 5, paddingTop: contributingSessions.length ? 6 : 0, borderTop: contributingSessions.length ? `1px solid ${COLORS.border}` : "none" }}>
                        <div style={{ fontSize: 10.5, fontWeight: 700, color: COLORS.creamDim, textTransform: "uppercase", letterSpacing: "0.04em" }}>Indirect credit</div>
                        {indirectSources.map((src, i) => (
                          <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12, gap: 10 }}>
                            <span style={{ color: COLORS.cream }}>{src.exercise} <span style={{ color: COLORS.creamDim, fontSize: 11 }}>({src.group})</span></span>
                            <span className="ft-mono" style={{ color: COLORS.creamDim, fontSize: 11, whiteSpace: "nowrap" }}>{src.sets} × {src.factor} = {fmtSets(src.credit)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    <button
                      className="ft-btn ft-btn-ghost"
                      style={{ fontSize: 11, marginTop: 2, alignSelf: "flex-start" }}
                      onClick={() => setTrendGroup(group)}
                    >
                      View {group} trend
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {trendGroup && (
        <div className="ft-card" style={{ padding: 18, marginTop: 14 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <div className="ft-label" style={{ marginBottom: 0 }}>{trendGroup} — 8-week trend</div>
              <span style={{ fontSize: 10, color: COLORS.creamDim }}>{coverageMode === "volume" ? "direct + indirect" : "direct only"}</span>
            </div>
            <button className="ft-btn ft-btn-ghost" style={{ padding: "4px 8px" }} onClick={() => setTrendGroup(null)}><X size={13} /></button>
          </div>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={trendData}>
              <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
              <XAxis dataKey="label" stroke={COLORS.creamDim} fontSize={11} />
              <YAxis stroke={COLORS.creamDim} fontSize={11} />
              <Tooltip contentStyle={{ background: COLORS.surfaceRaised, border: `1px solid ${COLORS.border}`, borderRadius: 8, color: COLORS.cream }} formatter={(v) => [`${v} ${coverageMode === "volume" ? "total " : ""}sets`, trendGroup]} />
              <ReferenceLine y={targetFor(trendGroup)} stroke={COLORS.mint} strokeDasharray="4 4" label={{ value: `target ${targetFor(trendGroup)}`, fill: COLORS.creamDim, fontSize: 10, position: "insideTopRight" }} />
              <Line type="monotone" dataKey="sets" stroke={COLORS.ember} strokeWidth={2.5} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

function Trends({ chartData, workoutSessions, showLifts = true, showWater = true, profile }) {
  const [smoothWeight, setSmoothWeight] = useState(true);

  if (chartData.length === 0) {
    return (
      <div className="ft-card" style={{ padding: 40, textAlign: "center", color: COLORS.creamDim }}>
        Log a few days to see trends here.
      </div>
    );
  }

  const weightData = smoothWeight ? rollingAverage(chartData, "weight", 3) : chartData;
  // Fixed per-point width instead of stretching to the container — on
  // mobile with many days logged, cramming every date label into a
  // narrow viewport is what made this chart feel cluttered. Scrolling
  // horizontally at a readable density fixes that without losing detail.
  const weightChartWidth = Math.max(320, weightData.length * 46);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="ft-card" style={{ padding: 18 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
          <div className="ft-label" style={{ marginBottom: 0 }}>Weight (lbs)</div>
          <button
            className="ft-btn ft-btn-ghost"
            onClick={() => setSmoothWeight((s) => !s)}
            style={{ fontSize: 11, padding: "5px 11px", color: smoothWeight ? COLORS.ember : COLORS.creamDim, border: `1px solid ${smoothWeight ? COLORS.ember : COLORS.border}` }}
          >
            {smoothWeight ? "3-day average" : "Daily readings"}
          </button>
        </div>
        <div className="ft-scroll" style={{ overflowX: "auto" }}>
          <LineChart width={weightChartWidth} height={220} data={weightData}>
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
            <XAxis dataKey="label" stroke={COLORS.creamDim} fontSize={11} />
            <YAxis stroke={COLORS.creamDim} fontSize={11} domain={["auto", "auto"]} />
            <Tooltip
              contentStyle={{ background: COLORS.surfaceRaised, border: `1px solid ${COLORS.border}`, borderRadius: 8, color: COLORS.cream }}
              formatter={(value) => [`${fmt(value, 2)} lbs`, "Weight"]}
            />
            <Line type="monotone" dataKey="weight" stroke={COLORS.ember} strokeWidth={2.5} dot={{ r: 3 }} connectNulls />
          </LineChart>
        </div>
        {smoothWeight && <div style={{ fontSize: 10.5, color: COLORS.creamDim, marginTop: 6 }}>Smoothed — each point averages that day with the 2 before it.</div>}
      </div>

      <div className="ft-card" style={{ padding: 18 }}>
        <div className="ft-label" style={{ marginBottom: 10 }}>
          {isBodyFatVisible(profile) ? "Estimated body fat % & fat mass" : "Estimated fat mass"}
        </div>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
            <XAxis dataKey="label" stroke={COLORS.creamDim} fontSize={11} />
            <YAxis stroke={COLORS.creamDim} fontSize={11} domain={["auto", "auto"]} />
            <Tooltip contentStyle={{ background: COLORS.surfaceRaised, border: `1px solid ${COLORS.border}`, borderRadius: 8, color: COLORS.cream }} />
            {isBodyFatVisible(profile) && <Line type="monotone" dataKey="bodyFatPct" stroke={COLORS.amber} strokeWidth={2.5} dot={{ r: 3 }} name="Body fat %" />}
            <Line type="monotone" dataKey="fatLbs" stroke={COLORS.ember} strokeWidth={1.5} strokeDasharray="4 4" dot={false} name="Fat lbs" />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {showWater && (
        <div className="ft-card" style={{ padding: 18 }}>
          <div className="ft-label" style={{ marginBottom: 2 }}>Water intake</div>
          <div style={{ fontSize: 10.5, color: COLORS.creamDim, marginBottom: 10 }}>
            Goal line moves day to day — it includes the creatine hydration bonus on days that applied.
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
              <XAxis dataKey="label" stroke={COLORS.creamDim} fontSize={11} />
              <YAxis stroke={COLORS.creamDim} fontSize={11} />
              <Tooltip
                contentStyle={{ background: COLORS.surfaceRaised, border: `1px solid ${COLORS.border}`, borderRadius: 8, color: COLORS.cream }}
                formatter={(value, name) => [`${fmt(value)} oz`, name === "waterOz" ? "Consumed" : "Goal"]}
              />
              <Bar dataKey="waterOz" radius={[4, 4, 0, 0]}>
                {chartData.map((d, i) => (
                  <Cell key={i} fill={d.waterOz >= d.waterGoalOz && d.waterGoalOz > 0 ? COLORS.mint : COLORS.ember} />
                ))}
              </Bar>
              <Line type="stepAfter" dataKey="waterGoalOz" stroke={COLORS.creamDim} strokeWidth={1.5} strokeDasharray="4 4" dot={false} name="Goal" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="ft-card" style={{ padding: 18 }}>
        {(() => {
          // On a cut, a deficit IS the progress — flipping the y-axis makes
          // your good days point up instead of down, which reads far more
          // intuitively while cutting. Untouched for maintain/gain.
          const cutting = profile?.goalType === "lose" || profile?.goalType === "mini_cut";
          return (
            <>
              <div className="ft-label" style={{ marginBottom: 10 }}>
                Daily calorie balance (vs. maintenance){cutting ? " — axis flipped: deficit points up" : ""}
              </div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
                  <XAxis dataKey="label" stroke={COLORS.creamDim} fontSize={11} />
                  <YAxis stroke={COLORS.creamDim} fontSize={11} reversed={cutting} />
                  <Tooltip contentStyle={{ background: COLORS.surfaceRaised, border: `1px solid ${COLORS.border}`, borderRadius: 8, color: COLORS.cream }} />
                  <ReferenceLine y={0} stroke={COLORS.creamDim} />
                  <Bar dataKey="balance" radius={[4, 4, 4, 4]}>
                    {chartData.map((d, i) => (
                      <Cell key={i} fill={d.balance < 0 ? COLORS.mint : COLORS.amber} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </>
          );
        })()}
      </div>

      <div className="ft-card" style={{ padding: 18 }}>
        <div className="ft-label" style={{ marginBottom: 10 }}>Calories consumed vs. maintenance (TDEE)</div>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
            <XAxis dataKey="label" stroke={COLORS.creamDim} fontSize={11} />
            <YAxis stroke={COLORS.creamDim} fontSize={11} />
            <Tooltip contentStyle={{ background: COLORS.surfaceRaised, border: `1px solid ${COLORS.border}`, borderRadius: 8, color: COLORS.cream }} />
            <Line type="monotone" dataKey="caloriesConsumed" stroke={COLORS.amber} strokeWidth={2} dot={{ r: 3 }} name="Consumed (cal)" />
            <Line type="monotone" dataKey="suggestedCalories" stroke={COLORS.mint} strokeWidth={1.5} strokeDasharray="5 3" dot={false} name="Goal (cal)" />
            <Line type="monotone" dataKey="tdee" stroke={COLORS.creamDim} strokeWidth={1.5} strokeDasharray="3 3" dot={false} name="Maintenance (cal)" />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {showLifts && <WeeklyLiftImprovements workoutSessions={workoutSessions} />}
    </div>
  );
}

// Method 2 from the Nutrition Booklet's maintenance-finding guide,
// running continuously in the background: real weight change vs. real
// calories logged over a window, solved for what your actual maintenance
// must be — rather than a one-time formula estimate that never updates.
function AdaptiveTdeeCard({ adaptive, profile, latestWeight, onProfileChange }) {
  const isActive = profile?.adaptiveTdee != null;
  // Compare formula-vs-adaptive at the same bodyweight the person is
  // actually at right now — comparing against goal weight or some other
  // figure would make the "+X cal" difference meaningless.
  const comparisonWeight = latestWeight || FALLBACK_WEIGHT_ESTIMATE_LBS;
  const formulaTdee = computeStats(profile, comparisonWeight).formulaTdee;

  if (!adaptive.ready) {
    const need = adaptive.minRequired;
    const have = adaptive.daysLogged;
    return (
      <div className="ft-card" style={{ padding: 18, maxWidth: 380, flex: 1, minWidth: 280 }}>
        <div className="ft-label" style={{ marginBottom: 6 }}>Adaptive TDEE</div>
        <div style={{ fontSize: 12.5, color: COLORS.creamDim, lineHeight: 1.5 }}>
          Log your weight and calories most days. This works out your real maintenance calories from what actually happened to your body — more accurate than a formula that only knows your height, weight, and age. A rough early read appears after {need} days; it keeps getting more confident the longer you log.
        </div>
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 10.5, color: have >= need ? COLORS.mint : COLORS.creamDim, marginBottom: 4 }}>
            {have} of {need} days logged {have >= need && "✓"}
          </div>
          <div style={{ height: 6, background: COLORS.surfaceRaised, borderRadius: 3, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${Math.min(100, (have / need) * 100)}%`, backgroundImage: `linear-gradient(135deg, ${COLORS.ember}, ${COLORS.mint})` }} />
          </div>
        </div>
      </div>
    );
  }

  const diff = adaptive.tdee - formulaTdee;
  // Confidence is a proxy for "how much to trust this yet," not a true
  // statistical interval — see computeAdaptiveTDEE for what it's
  // actually built from (days of data AND how gap-free the comparison
  // window is, not just a day count).
  const confLabel = adaptive.confidence >= 75 ? "Well-established" : adaptive.confidence >= 40 ? "Building confidence" : "Still calibrating";
  const confColor = adaptive.confidence >= 75 ? COLORS.mint : adaptive.confidence >= 40 ? COLORS.amber : COLORS.creamDim;
  return (
    <div className={`ft-card ${isActive ? "ft-card-hero" : ""}`} style={{ padding: 18, maxWidth: 380, flex: 1, minWidth: 280 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4, flexWrap: "wrap", gap: 6 }}>
        <div className="ft-label" style={{ marginBottom: 0 }}>Adaptive TDEE</div>
        {isActive && <span style={{ fontSize: 10, fontWeight: 700, color: COLORS.mint, background: COLORS.mintDim, padding: "3px 8px", borderRadius: 999 }}>ACTIVE</span>}
      </div>
      <div className="ft-mono ft-grad-text" style={{ fontSize: 26, fontWeight: 700 }}>{fmt(adaptive.tdee)} cal</div>
      <div style={{ fontSize: 11.5, color: COLORS.creamDim, marginTop: 2 }}>
        vs {fmt(formulaTdee)} cal from your profile stats — {diff >= 0 ? "+" : ""}{fmt(diff)} cal
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 10, gap: 8 }}>
        <div style={{ height: 5, flex: 1, background: COLORS.surfaceRaised, borderRadius: 3, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${adaptive.confidence}%`, background: confColor, transition: "width 0.4s ease" }} />
        </div>
        <span style={{ fontSize: 10, color: confColor, fontWeight: 700, whiteSpace: "nowrap" }}>{confLabel}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12, paddingTop: 12, borderTop: `1px solid ${COLORS.border}` }}>
        <div>
          <div style={{ fontSize: 9.5, color: COLORS.creamDim, textTransform: "uppercase" }}>Weight trend</div>
          {(() => {
            // A tiny negative rate (near-maintenance) rounds to -0 in
            // JS, and -0 still renders as "-0.00" through
            // toLocaleString — reads as a data error even though it's
            // mathematically "correct." Normalizing -0 to 0 here is
            // display-only; the underlying adaptive.weightChangeLbsPerWeek
            // value is untouched.
            const rounded = Math.round(adaptive.weightChangeLbsPerWeek * 100) / 100;
            const display = rounded === 0 ? 0 : rounded;
            return <div className="ft-mono" style={{ fontSize: 13, fontWeight: 600 }}>{display > 0 ? "+" : ""}{fmt(display, 2)} lbs/wk</div>;
          })()}
        </div>
        <div>
          <div style={{ fontSize: 9.5, color: COLORS.creamDim, textTransform: "uppercase" }}>Avg calories</div>
          <div className="ft-mono" style={{ fontSize: 13, fontWeight: 600 }}>{fmt(adaptive.avgCalories)}</div>
        </div>
      </div>
      <div style={{ fontSize: 10, color: COLORS.creamDim, marginTop: 10 }}>
        Based on {adaptive.daysLogged} logged days, trend spanning ~{adaptive.daysSpan} days.
        {isActive && profile.adaptiveTdeeSetOn && ` Adopted ${prettyDate(profile.adaptiveTdeeSetOn)}.`}
      </div>
      {isActive && (
        <div style={{ fontSize: 10, color: COLORS.creamDim, marginTop: 4 }}>
          Refreshes on its own at most every 3 days as you log — tap Update to latest for the newest number right now.
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        {!isActive ? (
          <button className="ft-btn ft-btn-primary" style={{ flex: 1 }} onClick={() => onProfileChange({ adaptiveTdee: adaptive.tdee, adaptiveTdeeSetOn: todayStr(), adaptiveTdeeUpdatedAt: new Date().toISOString() })}>
            Use this as my TDEE
          </button>
        ) : (
          <>
            <button className="ft-btn ft-btn-primary" style={{ flex: 1 }} onClick={() => onProfileChange({ adaptiveTdee: adaptive.tdee, adaptiveTdeeSetOn: todayStr(), adaptiveTdeeUpdatedAt: new Date().toISOString() })}>
              Update to latest
            </button>
            <button className="ft-btn ft-btn-ghost" onClick={() => onProfileChange({ adaptiveTdee: null, adaptiveTdeeSetOn: null, adaptiveTdeeUpdatedAt: null })}>
              Use formula instead
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function AdaptiveBodyFatCard({ profile, entries, latestWeight, onProfileChange }) {
  const cardStyle = { padding: 18, maxWidth: 380, flex: 1, minWidth: 280 };

  if (profile.gender !== "male") {
    return (
      <div className="ft-card" style={cardStyle}>
        <div className="ft-label" style={{ marginBottom: 6 }}>Adaptive Body Fat %</div>
        <div style={{ fontSize: 12.5, color: COLORS.creamDim, lineHeight: 1.5 }}>
          This blend — the formula estimate combined with the U.S. Navy circumference method — is male-only for now. The women's version of the Navy method also needs hip circumference, which isn't tracked yet.
        </div>
      </div>
    );
  }

  const neckIn = latestMeasurement(entries, "neck");
  const waistIn = latestMeasurement(entries, "waist");
  const stats = computeStats(profile, latestWeight || FALLBACK_WEIGHT_ESTIMATE_LBS, { neckIn, waistIn });
  const isActive = profile?.useAdaptiveBodyFat === true;

  if (!stats.navyEligible) {
    const missing = [!neckIn && "neck", !waistIn && "waist"].filter(Boolean);
    return (
      <div className="ft-card" style={cardStyle}>
        <div className="ft-label" style={{ marginBottom: 6 }}>Adaptive Body Fat %</div>
        <div style={{ fontSize: 12.5, color: COLORS.creamDim, lineHeight: 1.5 }}>
          The formula estimate only knows your weight, height, age, and gender — it can't tell a muscular build from a fat one at the same BMI. Log your neck and waist measurements and this blends in the U.S. Navy circumference method for a more accurate estimate.
        </div>
        <div style={{ marginTop: 10, fontSize: 11, color: COLORS.creamDim }}>
          Still need: {missing.join(" and ")} measurement{missing.length > 1 ? "s" : ""}.
        </div>
      </div>
    );
  }

  const blendedPct = 0.65 * stats.formulaBodyFatPct + 0.35 * stats.navyBodyFatPct;
  const diff = blendedPct - stats.formulaBodyFatPct;
  return (
    <div className={`ft-card ${isActive ? "ft-card-hero" : ""}`} style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4, flexWrap: "wrap", gap: 6 }}>
        <div className="ft-label" style={{ marginBottom: 0 }}>Adaptive Body Fat %</div>
        {isActive && <span style={{ fontSize: 10, fontWeight: 700, color: COLORS.mint, background: COLORS.mintDim, padding: "3px 8px", borderRadius: 999 }}>ACTIVE</span>}
      </div>
      <div className="ft-mono ft-grad-text" style={{ fontSize: 26, fontWeight: 700 }}>{fmt(blendedPct, 1)}%</div>
      <div style={{ fontSize: 11.5, color: COLORS.creamDim, marginTop: 2 }}>
        vs {fmt(stats.formulaBodyFatPct, 1)}% from the formula — {diff >= 0 ? "+" : ""}{fmt(diff, 1)}%
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12, paddingTop: 12, borderTop: `1px solid ${COLORS.border}` }}>
        <div>
          <div style={{ fontSize: 9.5, color: COLORS.creamDim, textTransform: "uppercase" }}>Neck</div>
          <div className="ft-mono" style={{ fontSize: 13, fontWeight: 600 }}>{fmt(neckIn, 1)} in</div>
        </div>
        <div>
          <div style={{ fontSize: 9.5, color: COLORS.creamDim, textTransform: "uppercase" }}>Waist</div>
          <div className="ft-mono" style={{ fontSize: 13, fontWeight: 600 }}>{fmt(waistIn, 1)} in</div>
        </div>
      </div>
      <div style={{ fontSize: 10, color: COLORS.creamDim, marginTop: 10 }}>
        Blend weighted 65% formula / 35% Navy method — updates automatically as you log new measurements. Unlike Adaptive TDEE, this doesn't freeze at a snapshot.
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        {!isActive ? (
          <button className="ft-btn ft-btn-primary" style={{ flex: 1 }} onClick={() => onProfileChange({ useAdaptiveBodyFat: true })}>
            Use this on my Dashboard
          </button>
        ) : (
          <button className="ft-btn ft-btn-ghost" style={{ flex: 1 }} onClick={() => onProfileChange({ useAdaptiveBodyFat: false })}>
            Revert to formula
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   Settings
----------------------------------------------------------------*/

// Minimal RFC4180-ish CSV parser matching the quoting style
// handleExportCsv produces (every cell quoted, internal quotes doubled) —
// handles CRLF and bare LF line endings since spreadsheet apps vary on
// save. Not a general-purpose CSV library, just enough to round-trip
// what this app itself exports.
function parseCsvText(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\r") { /* skip — \n handles the actual line break */ }
      else if (c === "\n") { row.push(field); field = ""; if (row.some(v => v !== "")) rows.push(row); row = []; }
      else field += c;
    }
  }
  if (field !== "" || row.length) { row.push(field); if (row.some(v => v !== "")) rows.push(row); }
  return rows;
}

// "Weigh-ins" and "Meals logged" are deliberately absent here — the
// export only ever writes a COUNT for those two columns, not the
// underlying records, so there's nothing to reconstruct from them on
// the way back in.
const IMPORT_COLUMN_MAP = {
  "Weight (lbs)": "weight",
  "Calories": "caloriesConsumed",
  "Protein (g)": "protein",
  "Carbs (g)": "carbs",
  "Fat (g)": "fat",
  "Creatine (g)": "creatine",
  "Body Fat %": "bodyFatPct",
  "Water (oz)": "waterOz",
};

function parseImportCsv(text) {
  const raw = parseCsvText(text);
  if (raw.length < 2) return { rows: [], errors: ["File is empty or has no data rows."] };
  const header = raw[0];
  const dateIdx = header.indexOf("Date");
  if (dateIdx === -1) return { rows: [], errors: ['No "Date" column found — this doesn\'t look like a Forge Log export.'] };

  const fieldIdx = {};
  header.forEach((h, i) => { if (IMPORT_COLUMN_MAP[h] != null) fieldIdx[IMPORT_COLUMN_MAP[h]] = i; });

  const rows = [];
  const errors = [];
  for (let r = 1; r < raw.length; r++) {
    const cells = raw[r];
    const date = cells[dateIdx];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) { errors.push(`Row ${r + 1}: skipped — "${date}" isn't a valid date.`); continue; }
    const parsed = { date };
    for (const [field, idx] of Object.entries(fieldIdx)) {
      const v = cells[idx];
      if (v === undefined || v === "") continue;
      const num = parseFloat(v);
      if (!Number.isNaN(num)) parsed[field] = num;
    }
    rows.push(parsed);
  }
  return { rows, errors };
}

function SettingsPanel({ profile, onChange, latestWeight, features, onToggleFeature, entries, onImportCsv, userId }) {
  const adaptive = useMemo(() => computeAdaptiveTDEE(entries, profile.goalType), [entries, profile.goalType]);
  const [importPreview, setImportPreview] = useState(null); // { rows, errors, fileName }
  const [importing, setImporting] = useState(false);
  const importInputRef = useRef(null);

  // "unknown" while checking on mount, then "unsupported" | "off" | "on".
  // Checked against the browser's ACTUAL current subscription rather
  // than just trusting a stored flag — a subscription that lives in the
  // browser but never made it to Supabase (a failed save, a cleared
  // cache) would otherwise show as "on" when notifications wouldn't
  // really be tracked anywhere.
  const [notifStatus, setNotifStatus] = useState("unknown");
  const [notifBusy, setNotifBusy] = useState(false);

  useEffect(() => {
    if (!pushNotificationsSupported()) { setNotifStatus("unsupported"); return; }
    getCurrentPushSubscription().then(sub => setNotifStatus(sub ? "on" : "off"));
  }, []);

  async function handleToggleNotifications() {
    setNotifBusy(true);
    if (notifStatus === "on") {
      await unsubscribeFromPushNotifications();
      setNotifStatus("off");
    } else {
      const result = await subscribeToPushNotifications(userId);
      if (result.ok) {
        setNotifStatus("on");
        toastSuccess("Notifications enabled");
      } else if (result.reason === "denied") {
        toastError("Notifications blocked — check your browser's site settings to allow them.");
      } else if (result.reason === "not-configured") {
        toastError("Notifications aren't set up yet on this deployment.");
      } else {
        toastError("Couldn't enable notifications — try again in a moment.");
      }
    }
    setNotifBusy(false);
  }

  function handleFileSelected(e) {
    const file = e.target.files?.[0];
    e.target.value = ""; // clears the picker so re-selecting the same file still fires onChange
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const { rows, errors } = parseImportCsv(String(reader.result));
      setImportPreview({ rows, errors, fileName: file.name });
    };
    reader.readAsText(file);
  }

  async function handleConfirmImport() {
    if (!importPreview?.rows?.length) return;
    setImporting(true);
    try {
      await onImportCsv(importPreview.rows);
      toastSuccess(`Imported ${importPreview.rows.length} day${importPreview.rows.length !== 1 ? "s" : ""}`);
      setImportPreview(null);
    } finally {
      setImporting(false);
    }
  }

  function handleExportCsv() {
    const dates = Object.keys(entries).sort();
    const headers = ["Date", "Weight (lbs)", "Calories", "Protein (g)", "Carbs (g)", "Fat (g)", "Creatine (g)", "Body Fat %", "Water (oz)", "Weigh-ins", "Meals logged"];
    const rows = dates.map(d => {
      const e = entries[d];
      const waterOz = (e.water_logs || []).reduce((s, w) => s + (parseFloat(w.amountOz) || 0), 0);
      return [
        d,
        e.weight ?? "",
        e.caloriesConsumed ?? "",
        e.protein ?? "",
        e.carbs ?? "",
        e.fat ?? "",
        e.creatine ?? "",
        e.bodyFatPct != null ? (Math.round(e.bodyFatPct * 100) / 100) : "",
        waterOz ? Math.round(waterOz) : "",
        (e.weigh_ins || []).length || "",
        (e.meals || []).length || "",
      ];
    });
    // Quote every cell so a stray comma in freeform data (there isn't
    // any today, but defensive against future fields) can't silently
    // shift columns in whatever spreadsheet app opens this.
    const csv = [headers, ...rows]
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `forge-log-export-${todayStr()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const rate = profile.goalRateLbsPerWeek || 0;
  const formulaTdee = computeStats(profile, latestWeight || FALLBACK_WEIGHT_ESTIMATE_LBS).tdee;
  let dailyAdj = 0;
  if (profile.goalType === "lose") dailyAdj = -(rate * energyDensityFor(profile.goalType)) / 7;
  else if (profile.goalType === "gain") dailyAdj = (rate * energyDensityFor(profile.goalType)) / 7;
  else if (profile.goalType === "mini_cut") {
    const tdeeEstimate = computeStats(profile, FALLBACK_WEIGHT_ESTIMATE_LBS).tdee; // rough estimate for display before a real weigh-in
    dailyAdj = -tdeeEstimate * 0.25;
  }

  const miniCutDaysIn = profile.miniCutStartedOn
    ? Math.floor((new Date(todayStr()) - new Date(profile.miniCutStartedOn)) / 86400000)
    : null;
  const miniCutOverdue = miniCutDaysIn !== null && miniCutDaysIn > MINI_CUT_MAX_DAYS;

  const goalDaysIn = profile.goalStartedOn
    ? Math.floor((new Date(todayStr()) - new Date(profile.goalStartedOn)) / 86400000)
    : null;
  const recommendedRate = getRecommendedMaxRate(profile.goalType, latestWeight);
  const rateOverRecommended = recommendedRate && rate > recommendedRate.max;

  return (
    <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
      <div className="ft-card" style={{ padding: 20, maxWidth: 460, flex: 1, minWidth: 300 }}>
        <div className="ft-label" style={{ marginBottom: 14 }}>Profile</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <Field label="Gender">
            <select className="ft-select" value={profile.gender} onChange={(e) => onChange("gender", e.target.value)}>
              <option value="male">Male</option>
              <option value="female">Female</option>
            </select>
          </Field>
          <Field label="Age">
            <input className="ft-input" type="number" inputMode="decimal" onFocus={selectOnFocus} value={profile.age} onChange={(e) => onChange("age", parseFloat(e.target.value) || 0)} />
          </Field>
          <Field label="Height (in)">
            <input className="ft-input" type="number" inputMode="decimal" onFocus={selectOnFocus} value={profile.heightIn} onChange={(e) => onChange("heightIn", parseFloat(e.target.value) || 0)} />
          </Field>
          <Field label="Activity">
            <select className="ft-select" value={profile.activityIdx} onChange={(e) => onChange("activityIdx", parseInt(e.target.value))}>
              {ACTIVITY_LEVELS.map((a, i) => <option key={i} value={i}>{a.label}</option>)}
            </select>
          </Field>
        </div>
        <div className="ft-card-raised" style={{ marginTop: 16, padding: 12 }}>
          <Row label="Maintenance (TDEE)" value={`${fmt(formulaTdee)} cal`} bold />
          <div style={{ fontSize: 10.5, color: COLORS.creamDim, marginTop: 4, lineHeight: 1.4 }}>
            Mifflin-St Jeor BMR × activity multiplier{latestWeight == null ? " — using an estimated weight, log a weigh-in for an exact number" : ""}. Adaptive TDEE below can override this once you've logged enough days.
          </div>
        </div>
        <div style={{ marginTop: 12, fontSize: 11.5, color: COLORS.creamDim, lineHeight: 1.5 }}>
          Macro targets come from your goal intake, not maintenance: protein ~1g/lb, fat 25% of calories, carbs fill the rest. Body fat % is a BMI-based estimate — not a substitute for a real scan.
        </div>
      </div>

      <div className="ft-card" style={{ padding: 20, maxWidth: 380, flex: 1, minWidth: 280 }}>
        <div className="ft-label" style={{ marginBottom: 14 }}>Weight goal</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label="Goal">
            <select
              className="ft-select"
              value={profile.goalType}
              onChange={(e) => {
                // A goal-type change means a new goal has started — clear
                // any start date from whatever the previous goal was, so
                // "Day X" and the accumulated deficit/surplus can't
                // silently carry over from an unrelated cut or bulk.
                onChange({ goalType: e.target.value, miniCutStartedOn: null, goalStartedOn: null });
              }}
            >
              <option value="lose">Lose fat</option>
              <option value="mini_cut">Mini cut (short, aggressive — 2-6 weeks)</option>
              <option value="maintain">Maintain</option>
              <option value="gain">Gain (build muscle)</option>
            </select>
          </Field>

          {(profile.goalType === "lose" || profile.goalType === "gain") && (
            <>
              <Field label={profile.goalType === "lose" ? "Lbs to lose per week" : "Lbs to gain per week"}>
                <input
                  className="ft-input"
                  type="number" inputMode="decimal" onFocus={selectOnFocus}
                  step="0.25"
                  value={profile.goalRateLbsPerWeek}
                  onChange={(e) => onChange("goalRateLbsPerWeek", parseFloat(e.target.value) || 0)}
                  style={rateOverRecommended ? { borderColor: COLORS.amber } : undefined}
                />
                {profile.goalType === "gain" && (
                  <div style={{ fontSize: 11, color: COLORS.creamDim, marginTop: 5, lineHeight: 1.4 }}>
                    Research on lean gains favors a modest surplus — most people do well around 0.25-0.5 lbs/week. Faster gains usually mean more fat gained alongside muscle.
                  </div>
                )}
                {profile.goalType === "lose" && (
                  <div style={{ fontSize: 11, color: COLORS.creamDim, marginTop: 5, lineHeight: 1.4 }}>
                    Widely-cited guidance favors losing no more than about 0.5-1% of bodyweight per week to limit muscle loss — faster than that tends to cost more muscle for the same fat lost.
                  </div>
                )}
                {recommendedRate && (
                  <div
                    className={rateOverRecommended ? "ft-card-raised" : undefined}
                    style={{
                      fontSize: 11, marginTop: 6, lineHeight: 1.4,
                      color: rateOverRecommended ? COLORS.amber : COLORS.creamDim,
                      padding: rateOverRecommended ? 8 : 0,
                      border: rateOverRecommended ? `1px solid ${COLORS.amber}60` : "none",
                    }}
                  >
                    Recommended max: ~{fmt(recommendedRate.max, 2)} lbs/week ({recommendedRate.basis}
                    {latestWeight ? "" : " — estimate, log a weigh-in for an exact number"}).
                    {rateOverRecommended && " Your current rate is above this — not dangerous, just likely to cost more muscle/add more fat than necessary."}
                  </div>
                )}
              </Field>

              <Field label="Started on (optional — tracks days in and your accumulated deficit/surplus)">
                <input
                  className="ft-input"
                  type="date"
                  value={profile.goalStartedOn || ""}
                  onChange={(e) => onChange("goalStartedOn", e.target.value || null)}
                />
              </Field>
              {goalDaysIn !== null && (
                <div className="ft-card-raised" style={{ padding: 10 }}>
                  <div style={{ fontSize: 12, color: COLORS.cream, fontWeight: 600 }}>
                    Calendar day {goalDaysIn} of your current {profile.goalType === "lose" ? "cut" : "bulk"}
                  </div>
                  <div style={{ fontSize: 11, color: COLORS.creamDim, marginTop: 3, lineHeight: 1.4 }}>
                    Daily Log shows your accumulated {profile.goalType === "lose" ? "deficit" : "surplus"} since this date — a separate number, since it only counts days you actually logged calories on.
                  </div>
                </div>
              )}
            </>
          )}

          {profile.goalType === "mini_cut" && (
            <>
              <div style={{ fontSize: 12, color: COLORS.creamDim, lineHeight: 1.5 }}>
                A mini cut is a short, aggressive deficit (~25% below maintenance) meant to run <strong style={{ color: COLORS.cream }}>2-6 weeks max</strong> — not a long-term plan. Keep protein high and keep lifting heavy; trim volume if recovery suffers.
              </div>
              <Field label="Mini cut start date (optional — tracks how many days in)">
                <input
                  className="ft-input"
                  type="date"
                  value={profile.miniCutStartedOn || ""}
                  onChange={(e) => onChange("miniCutStartedOn", e.target.value || null)}
                />
              </Field>
              {miniCutDaysIn !== null && (
                <div className="ft-card-raised" style={{ padding: 10, border: miniCutOverdue ? `1px solid ${COLORS.danger}60` : "none" }}>
                  <div style={{ fontSize: 12, color: miniCutOverdue ? COLORS.danger : COLORS.cream, fontWeight: 600 }}>
                    Calendar day {miniCutDaysIn} of your mini cut
                  </div>
                  <div style={{ fontSize: 11, color: COLORS.creamDim, marginTop: 3, lineHeight: 1.4 }}>
                    {miniCutOverdue
                      ? "You're past the recommended 6-week cap — consider moving back to maintenance for a week or two before continuing."
                      : `Recommended max: ${MINI_CUT_MAX_DAYS} days (6 weeks).`}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="ft-card-raised" style={{ marginTop: 16, padding: 12 }}>
          <Row label="Daily calorie adjustment" value={`${dailyAdj > 0 ? "+" : ""}${fmt(dailyAdj)} cal`} color={dailyAdj < 0 ? COLORS.mint : dailyAdj > 0 ? COLORS.amber : COLORS.cream} bold />
        </div>
        <div style={{ marginTop: 12, fontSize: 12, color: COLORS.creamDim, lineHeight: 1.5 }}>
          Losing fat runs ≈3,500 cal/lb; gaining weight while training runs lower, ≈2,800 cal/lb, since a surplus builds meaningfully more lean tissue than a deficit burns away — both are estimates, not measured constants. This goal sets the "Suggested calories" target shown on the Dashboard and Log Entry — maintenance ± (rate × density ÷ 7) for lose/gain, or 25% below maintenance for a mini cut.
        </div>
      </div>

      <div className="ft-card" style={{ padding: 20, maxWidth: 380, flex: 1, minWidth: 280 }}>
        <div className="ft-label" style={{ marginBottom: 14, display: "flex", alignItems: "center", gap: 6 }}>
          <Target size={14} color={COLORS.ember} /> Goal weight
        </div>
        <Field label="Target weight (lbs)">
          <input
            className="ft-input"
            type="number" inputMode="decimal"
            step="0.5"
            onFocus={selectOnFocus}
            placeholder="e.g. 165"
            value={profile.goalWeightLbs ?? ""}
            onChange={(e) => onChange("goalWeightLbs", e.target.value ? parseFloat(e.target.value) : null)}
          />
        </Field>
        {profile.goalWeightLbs ? (
          latestWeight != null ? (() => {
            const diff = profile.goalWeightLbs - latestWeight;
            const absDiff = Math.abs(diff);
            const reached = absDiff < 0.5;
            const weeksEst = !reached && rate > 0 ? Math.ceil(absDiff / rate) : null;
            return (
              <div className="ft-card-raised" style={{ marginTop: 12, padding: 12 }}>
                {reached ? (
                  <div style={{ fontSize: 12.5, color: COLORS.mint, fontWeight: 700 }}>You're at your goal weight!</div>
                ) : (
                  <>
                    <Row label={diff < 0 ? "Lbs to lose" : "Lbs to gain"} value={fmt(absDiff, 1)} bold />
                    <div style={{ fontSize: 11, color: COLORS.creamDim, marginTop: 4, lineHeight: 1.4 }}>
                      {weeksEst != null
                        ? `~${weeksEst} week${weeksEst !== 1 ? "s" : ""} at your current rate of ${fmt(rate, 2)} lbs/week.`
                        : "Set a weekly rate on your Weight goal to see an estimated timeline."}
                    </div>
                  </>
                )}
              </div>
            );
          })() : (
            <div style={{ marginTop: 10, fontSize: 11.5, color: COLORS.creamDim, lineHeight: 1.4 }}>
              Log a weigh-in to see your progress toward this.
            </div>
          )
        ) : (
          <div style={{ marginTop: 10, fontSize: 12, color: COLORS.creamDim, lineHeight: 1.5 }}>
            Shown on your Dashboard with progress toward this number and an estimated timeline based on your current rate. Leave blank to hide it.
          </div>
        )}
      </div>

      <AdaptiveTdeeCard adaptive={adaptive} profile={profile} latestWeight={latestWeight} onProfileChange={onChange} />

      <div className={`ft-card ${isBodyFatVisible(profile) ? "ft-card-hero" : ""}`} style={{ padding: 18, maxWidth: 380, flex: 1, minWidth: 280 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 2 }}>
              <div className="ft-label" style={{ marginBottom: 0 }}>Show body fat %</div>
              {isBodyFatVisible(profile) && <span style={{ fontSize: 10, fontWeight: 700, color: COLORS.mint, background: COLORS.mintDim, padding: "3px 8px", borderRadius: 999 }}>ACTIVE</span>}
            </div>
            <div style={{ fontSize: 11.5, color: COLORS.creamDim, lineHeight: 1.4 }}>
              Hides body fat %, fat mass, and lean mass everywhere in the app — Dashboard, Daily Log, and Trends. This can be sensitive information, so it defaults to hidden for female profiles and shown for male; either way it's your call.
            </div>
          </div>
          <button
            role="switch"
            aria-checked={isBodyFatVisible(profile)}
            onClick={() => onChange({ showBodyFatPct: !isBodyFatVisible(profile) })}
            className="ft-btn-icon"
            style={{
              width: 44, height: 25, borderRadius: 999, border: "none", cursor: "pointer",
              background: isBodyFatVisible(profile) ? `linear-gradient(135deg, ${COLORS.ember}, ${COLORS.mint})` : COLORS.surfaceRaised,
              position: "relative", flexShrink: 0, padding: 0, minWidth: 44, minHeight: 25,
              transition: "background 0.25s ease",
            }}
          >
            <span style={{
              position: "absolute", top: 3, left: isBodyFatVisible(profile) ? 22 : 3,
              width: 19, height: 19, borderRadius: "50%", background: COLORS.cream,
              transition: "left 0.22s cubic-bezier(0.16,1,0.3,1)",
              boxShadow: "0 2px 6px rgba(0,0,0,0.35)",
            }} />
          </button>
        </div>
      </div>

      {isBodyFatVisible(profile) && (
        <AdaptiveBodyFatCard profile={profile} entries={entries} latestWeight={latestWeight} onProfileChange={onChange} />
      )}

      <div className={`ft-card ${profile.dedicatedProgressiveOverload ? "ft-card-hero" : ""}`} style={{ padding: 20, maxWidth: 380, flex: 1, minWidth: 280 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div className="ft-label" style={{ marginBottom: 0 }}>Dedicated Progressive Overload</div>
            {profile.dedicatedProgressiveOverload && <span style={{ fontSize: 10, fontWeight: 700, color: COLORS.mint, background: COLORS.mintDim, padding: "3px 8px", borderRadius: 999 }}>ACTIVE</span>}
          </div>
          <button
            role="switch"
            aria-checked={!!profile.dedicatedProgressiveOverload}
            onClick={() => onChange("dedicatedProgressiveOverload", !profile.dedicatedProgressiveOverload)}
            className="ft-btn-icon"
            style={{
              width: 44, height: 25, borderRadius: 999, border: "none", cursor: "pointer",
              background: profile.dedicatedProgressiveOverload ? `linear-gradient(135deg, ${COLORS.ember}, ${COLORS.mint})` : COLORS.surfaceRaised,
              position: "relative", flexShrink: 0, padding: 0, minWidth: 44, minHeight: 25,
              transition: "background 0.25s ease",
            }}
          >
            <span style={{
              position: "absolute", top: 3, left: profile.dedicatedProgressiveOverload ? 22 : 3,
              width: 19, height: 19, borderRadius: "50%", background: COLORS.cream,
              transition: "left 0.22s cubic-bezier(0.16,1,0.3,1)",
              boxShadow: "0 2px 6px rgba(0,0,0,0.35)",
            }} />
          </button>
        </div>
        <div style={{ fontSize: 12, color: COLORS.creamDim, lineHeight: 1.5 }}>
          Adds an RPE (1-10) field to every set in Daily Log, and weighs how hard your last session actually felt — not just whether you hit the top of the rep range — when suggesting your next weight. Hit the rep ceiling at a low RPE and it'll suggest a bigger jump than usual; hit it at RPE 9+ and it'll have you hold instead of piling on more. Off by default — the suggestion math is smarter either way, this just adds effort into the equation on top of that. Nothing you've already logged is affected either way.
        </div>
      </div>

      <div className="ft-card" style={{ padding: 20, maxWidth: 380, flex: 1, minWidth: 280 }}>
        <div className="ft-label" style={{ marginBottom: 4 }}>Features</div>
        <div style={{ fontSize: 12, color: COLORS.creamDim, lineHeight: 1.5, marginBottom: 14 }}>
          Turn off what you don't use and it disappears from the nav — focus on just calorie counting and weigh-ins, or just training and trends. Dashboard, Daily Log, and Settings always stay on. Everything you've logged is kept; toggling a feature back on brings its data right back.
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {FEATURE_DEFS.map((f) => {
            const on = !!features?.[f.key];
            return (
              <div key={f.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: on ? COLORS.cream : COLORS.creamDim }}>{f.label}</div>
                  <div style={{ fontSize: 11, color: COLORS.creamDim, lineHeight: 1.35 }}>{f.blurb}</div>
                </div>
                <button
                  role="switch"
                  aria-checked={on}
                  onClick={() => onToggleFeature(f.key)}
                  className="ft-btn-icon"
                  style={{
                    width: 44, height: 25, borderRadius: 999, border: "none", cursor: "pointer",
                    background: on ? `linear-gradient(135deg, ${COLORS.ember}, ${COLORS.mint})` : COLORS.surfaceRaised,
                    position: "relative", flexShrink: 0, padding: 0, minWidth: 44, minHeight: 25,
                    transition: "background 0.25s ease",
                  }}
                >
                  <span style={{
                    position: "absolute", top: 3, left: on ? 22 : 3,
                    width: 19, height: 19, borderRadius: "50%", background: COLORS.cream,
                    transition: "left 0.22s cubic-bezier(0.16,1,0.3,1)",
                    boxShadow: "0 2px 6px rgba(0,0,0,0.35)",
                  }} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="ft-card" style={{ padding: 20, maxWidth: 380, flex: 1, minWidth: 280 }}>
        <div className="ft-label" style={{ marginBottom: 4 }}>Export your data</div>
        <div style={{ fontSize: 12, color: COLORS.creamDim, lineHeight: 1.5, marginBottom: 14 }}>
          Download everything you've logged as a CSV — weight, calories, macros, creatine, water, body fat %. Opens in Excel, Sheets, or any spreadsheet app. Useful as a backup, for sharing with a coach or doctor, or if you ever want to take your history somewhere else.
        </div>
        <button className="ft-btn ft-btn-primary" onClick={handleExportCsv} disabled={Object.keys(entries).length === 0}>
          <Download size={14} /> Download CSV
        </button>
        {Object.keys(entries).length === 0 && (
          <div style={{ fontSize: 11, color: COLORS.creamDim, marginTop: 8 }}>Log a few days first — nothing to export yet.</div>
        )}
      </div>

      <div className="ft-card" style={{ padding: 20, maxWidth: 380, flex: 1, minWidth: 280 }}>
        <div className="ft-label" style={{ marginBottom: 4 }}>Import data</div>
        <div style={{ fontSize: 12, color: COLORS.creamDim, lineHeight: 1.5, marginBottom: 14 }}>
          Restore from a Forge Log CSV export. Merges into existing days rather than replacing them — only weight, calories, macros, creatine, body fat %, and a water total round-trip; per-meal and per-weigh-in detail isn't in the export, so those aren't recreated.
        </div>
        <input ref={importInputRef} type="file" accept=".csv" style={{ display: "none" }} onChange={handleFileSelected} />
        <button className="ft-btn ft-btn-ghost" onClick={() => importInputRef.current?.click()}>
          <Upload size={14} /> Choose CSV file
        </button>

        {importPreview && (
          <div className="ft-card-raised" style={{ marginTop: 14, padding: 12 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: COLORS.cream, marginBottom: 4 }}>{importPreview.fileName}</div>
            {importPreview.rows.length === 0 ? (
              <div style={{ fontSize: 12, color: COLORS.warn }}>
                No usable rows found.{importPreview.errors[0] ? ` ${importPreview.errors[0]}` : ""}
              </div>
            ) : (
              <>
                <div style={{ fontSize: 12, color: COLORS.creamDim, lineHeight: 1.5 }}>
                  Ready to import <b style={{ color: COLORS.cream }}>{importPreview.rows.length}</b> day{importPreview.rows.length !== 1 ? "s" : ""}
                  {" "}({prettyDate(importPreview.rows[0].date)} – {prettyDate(importPreview.rows[importPreview.rows.length - 1].date)}).
                  {" "}{importPreview.rows.filter(r => entries[r.date]).length} of these already have data and will be updated, not replaced.
                </div>
                {importPreview.errors.length > 0 && (
                  <div style={{ fontSize: 11, color: COLORS.amber, marginTop: 6 }}>
                    {importPreview.errors.length} row{importPreview.errors.length !== 1 ? "s" : ""} skipped (bad date).
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <button className="ft-btn ft-btn-primary" style={{ flex: 1 }} onClick={handleConfirmImport} disabled={importing}>
                    {importing ? "Importing…" : "Confirm import"}
                  </button>
                  <button className="ft-btn ft-btn-ghost" onClick={() => setImportPreview(null)} disabled={importing}>Cancel</button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <div className={`ft-card ${notifStatus === "on" ? "ft-card-hero" : ""}`} style={{ padding: 18, maxWidth: 380, flex: 1, minWidth: 280 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div className="ft-label" style={{ marginBottom: 0 }}>Notifications</div>
            {notifStatus === "on" && <span style={{ fontSize: 10, fontWeight: 700, color: COLORS.mint, background: COLORS.mintDim, padding: "3px 8px", borderRadius: 999 }}>ACTIVE</span>}
          </div>
          <button
            role="switch"
            aria-checked={notifStatus === "on"}
            disabled={notifStatus === "unsupported" || notifStatus === "unknown" || notifBusy}
            onClick={handleToggleNotifications}
            className="ft-btn-icon"
            style={{
              width: 44, height: 25, borderRadius: 999, border: "none",
              cursor: (notifStatus === "unsupported" || notifBusy) ? "not-allowed" : "pointer",
              opacity: notifStatus === "unsupported" ? 0.4 : 1,
              background: notifStatus === "on" ? `linear-gradient(135deg, ${COLORS.ember}, ${COLORS.mint})` : COLORS.surfaceRaised,
              position: "relative", flexShrink: 0, padding: 0, minWidth: 44, minHeight: 25,
              transition: "background 0.25s ease",
            }}
          >
            <span style={{
              position: "absolute", top: 3, left: notifStatus === "on" ? 22 : 3,
              width: 19, height: 19, borderRadius: "50%", background: COLORS.cream,
              transition: "left 0.22s cubic-bezier(0.16,1,0.3,1)",
              boxShadow: "0 2px 6px rgba(0,0,0,0.35)",
            }} />
          </button>
        </div>
        <div style={{ fontSize: 12, color: COLORS.creamDim, lineHeight: 1.5 }}>
          {notifStatus === "unsupported"
            ? "Not supported in this browser — try Chrome, Edge, or Safari on iOS 16.4+ with the app added to your home screen."
            : "Gentle nudges if water, weight, or food haven't been logged yet — never more than needed, and they stop the moment you log or hit that day's goal."}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   Measurements — optional body measurements, with how-to-measure
   hints, cm/inch toggle, and a pop-out history modal.
----------------------------------------------------------------*/

function MeasurementsTab({ selectedDate, setSelectedDate, measurementsInput, setMeasurementsInput, onSave, onDelete, entries }) {
  const [useCm, setUseCm] = useState(() => {
    try { return localStorage.getItem("forge_units") === "cm"; } catch { return false; }
  });
  const [saving, setSaving] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);

  // ── Local display state ────────────────────────────────────────────────
  // We store what the user is actually typing here. No live unit conversion
  // happens during typing — values only convert to storage (inches) on blur.
  const [displayVals, setDisplayVals] = useState({});

  // Only re-derive displayVals from canonical (inches) storage when the
  // date or unit actually changes — NOT every time measurementsInput
  // changes, since handleFieldBlur itself writes to measurementsInput as
  // part of keeping the canonical value current. Re-deriving on every one
  // of those echoes was the bug: converting cm -> inches -> cm through two
  // rounds of 1-decimal rounding doesn't reliably round-trip (2.54 isn't a
  // clean factor), so a typed "70" would silently become "70.1" the
  // instant you left the field — before you'd even hit Save.
  const lastSync = useRef({ date: null, useCm: null });
  useEffect(() => {
    const dateChanged = lastSync.current.date !== selectedDate;
    const unitChanged = lastSync.current.useCm !== useCm;
    if (!dateChanged && !unitChanged) return;
    lastSync.current = { date: selectedDate, useCm };

    const next = {};
    MEASUREMENT_FIELDS.forEach(f => {
      const stored = measurementsInput[f.key];
      if (!stored) { next[f.key] = ""; return; }
      next[f.key] = useCm
        ? String(Math.round(parseFloat(stored) * 2.54 * 10) / 10)
        : stored;
    });
    setDisplayVals(next);
  }, [selectedDate, useCm, measurementsInput]);

  function toggleUnits() {
    const next = !useCm;
    setUseCm(next);
    try { localStorage.setItem("forge_units", next ? "cm" : "in"); } catch {}
  }

  function handleFieldChange(key, val) {
    setDisplayVals(prev => ({ ...prev, [key]: val }));
  }

  function handleFieldBlur(key) {
    const raw = displayVals[key];
    if (!raw) return;
    // 2 decimals of inch precision, not 1 — 0.1in (~0.25cm) is coarser
    // than the 0.1cm the UI displays, so a whole-number cm entry like 92
    // was rounding to 36.2in and reading back as 91.9cm instead of 92.
    const inches = useCm
      ? String(Math.max(0, Math.round((parseFloat(raw) / 2.54) * 100) / 100))
      : String(Math.max(0, parseFloat(raw) || 0));
    setMeasurementsInput(prev => ({ ...prev, [key]: inches }));
  }

  async function handleSave() {
    const stored = {};
    MEASUREMENT_FIELDS.forEach(f => {
      const raw = displayVals[f.key];
      if (!raw) return;
      stored[f.key] = useCm
        ? String(Math.max(0, Math.round((parseFloat(raw) / 2.54) * 100) / 100))
        : String(Math.max(0, parseFloat(raw) || 0));
    });
    setSaving(true);
    try {
      await onSave(stored);
      toastSuccess("Measurements saved");
    } finally {
      setSaving(false);
    }
  }

  const historyDates = Object.keys(entries)
    .filter(d => entries[d].measurements && Object.values(entries[d].measurements).some(v => v !== "" && v !== undefined && v !== null))
    .sort().reverse();

  const unitLabel = useCm ? "cm" : "in";
  const toDisplay = (inchesStr) => useCm ? Math.round(parseFloat(inchesStr) * 2.54 * 10) / 10 : parseFloat(inchesStr);

  return (
    <>
      <div className="ft-card" style={{ padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
          <Ruler size={16} color={COLORS.ember} />
          <input type="date" className="ft-input" style={{ width: 170 }} value={selectedDate} onChange={e => setSelectedDate(e.target.value)} />
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto" }}>
            <span style={{ fontSize: 11, color: COLORS.creamDim }}>Units:</span>
            {["cm", "in"].map(u => (
              <button key={u} className="ft-btn ft-btn-ghost" onClick={toggleUnits}
                style={{ padding: "5px 12px", fontSize: 12, border: `1px solid ${(u === "cm") === useCm ? COLORS.ember : COLORS.border}`, color: (u === "cm") === useCm ? COLORS.ember : COLORS.creamDim }}>
                {u}
              </button>
            ))}
          </div>
        </div>

        <div style={{ fontSize: 12, color: COLORS.creamDim, lineHeight: 1.5, marginBottom: 14 }}>
          Optional — track body measurements alongside your weight to see changes a scale alone won't show.{" "}
          <a href={MEASUREMENT_GUIDE_URL} target="_blank" rel="noopener noreferrer" style={{ color: COLORS.ember, display: "inline-flex", alignItems: "center", gap: 3 }}>
            Measuring guide <ExternalLink size={11} />
          </a>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14 }}>
          {MEASUREMENT_FIELDS.map(f => (
            <div key={f.key}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span className="ft-label" style={{ marginBottom: 0 }}>{f.label.split(" (")[0]} ({unitLabel})</span>
                {f.tutorialUrl && (
                  <a href={f.tutorialUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 10, color: COLORS.ember, display: "inline-flex", alignItems: "center", gap: 2 }}>
                    Tutorial <ExternalLink size={9} />
                  </a>
                )}
              </div>
              <input
                className="ft-input"
                type="number" inputMode="decimal"
                step="0.1"
                onFocus={selectOnFocus}
                value={displayVals[f.key] ?? ""}
                onChange={e => handleFieldChange(f.key, e.target.value)}
                onBlur={() => handleFieldBlur(f.key)}
                placeholder="0.0"
              />
              <div style={{ fontSize: 10, color: COLORS.creamDim, fontStyle: "italic", marginTop: 4, lineHeight: 1.4 }}>{f.hint}</div>
            </div>
          ))}
        </div>

        <div className="ft-sticky-save">
          <button className="ft-btn ft-btn-primary" onClick={handleSave} disabled={saving} style={{ opacity: saving ? 0.7 : 1 }}>
            {saving ? <RefreshCw size={14} style={{ animation: "spin 1.2s linear infinite" }} /> : <Ruler size={14} />}
            {saving ? "Saving…" : "Save measurements"}
          </button>
        </div>
      </div>

      {/* Overall history — since measurements only get logged occasionally,
          this stays visible on the page instead of hidden behind a button,
          so there's always something here even between measuring sessions. */}
      <div className="ft-card" style={{ padding: 18, marginTop: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <div className="ft-label" style={{ marginBottom: 0 }}>Overall history</div>
          {historyDates.length > 0 && (
            <button className="ft-btn ft-btn-ghost" style={{ fontSize: 11 }} onClick={() => setManageOpen(o => !o)}>
              {manageOpen ? "Done" : "Manage entries"}
            </button>
          )}
        </div>
        {historyDates.length === 0 ? (
          <div style={{ fontSize: 13, color: COLORS.creamDim }}>No measurements recorded yet — log your first set above.</div>
        ) : manageOpen ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {historyDates.map(d => (
              <div key={d} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "7px 0", borderBottom: `1px solid ${COLORS.border}` }}>
                <span style={{ fontSize: 12.5 }}>{prettyDate(d)}</span>
                <div style={{ display: "flex", gap: 4 }}>
                  <button className="ft-btn ft-btn-ghost" style={{ padding: "4px 7px", fontSize: 11 }} onClick={() => setSelectedDate(d)}><Pencil size={11} /></button>
                  <button className="ft-btn ft-btn-danger" style={{ padding: "4px 7px" }} onClick={() => onDelete(d)}><Trash2 size={12} /></button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 12 }}>
            <div>
              <div style={{ fontSize: 9.5, color: COLORS.creamDim, textTransform: "uppercase" }}>Last measured</div>
              <div className="ft-mono" style={{ fontSize: 15, fontWeight: 700 }}>{prettyDate(historyDates[0])}</div>
            </div>
            <div>
              <div style={{ fontSize: 9.5, color: COLORS.creamDim, textTransform: "uppercase" }}>Sessions logged</div>
              <div className="ft-mono" style={{ fontSize: 15, fontWeight: 700 }}>{historyDates.length}</div>
            </div>
            <div>
              <div style={{ fontSize: 9.5, color: COLORS.creamDim, textTransform: "uppercase" }}>Tracking span</div>
              <div className="ft-mono" style={{ fontSize: 15, fontWeight: 700 }}>
                {historyDates.length > 1 ? `${Math.round((new Date(historyDates[0]) - new Date(historyDates[historyDates.length - 1])) / 86400000)} days` : "—"}
              </div>
            </div>
          </div>
        )}
      </div>

      {historyDates.length > 1 && <MeasurementsTrendChart entries={entries} unitLabel={unitLabel} toDisplay={toDisplay} />}

      {/* One history card per measurement point — click a bubble to see
          that reading's exact date and value. Each point tracks its own
          dates independently, since people rarely measure everything on
          the exact same schedule (e.g. waist weekly, arms monthly). */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 14, marginTop: 14 }}>
        {MEASUREMENT_FIELDS.map(f => (
          <MeasurementPointCard
            key={f.key}
            field={f}
            entries={entries}
            unitLabel={unitLabel}
            toDisplay={toDisplay}
            onJumpToDate={setSelectedDate}
          />
        ))}
      </div>
    </>
  );
}

// Different measurements live at wildly different scales (a 15in neck
// vs a 45in shoulder span) — plotting all seven at once on one shared
// axis would make the smaller ones invisible. Instead of normalizing to
// % change (technically tidy, but "your waist is -3%" is a less direct
// answer than "your waist is 33.5in" for what people actually want to
// see), this lets you pick which 1-3 to compare directly, defaulting to
// whichever field has the most logged history.
function MeasurementsTrendChart({ entries, unitLabel, toDisplay }) {
  const fieldCounts = useMemo(() => {
    return MEASUREMENT_FIELDS.map(f => ({
      field: f,
      count: Object.values(entries).filter(e => e.measurements?.[f.key]).length,
    })).filter(x => x.count > 0).sort((a, b) => b.count - a.count);
  }, [entries]);

  const [selectedKeys, setSelectedKeys] = useState(() => fieldCounts.slice(0, 1).map(x => x.field.key));

  const LINE_COLORS = [COLORS.ember, COLORS.mint, COLORS.amber];

  const chartData = useMemo(() => {
    const dates = [...new Set(
      Object.keys(entries).filter(d => selectedKeys.some(k => entries[d].measurements?.[k]))
    )].sort();
    return dates.map(d => {
      const row = { date: d, label: prettyDate(d).split(",")[0] + " " + d.slice(8) };
      selectedKeys.forEach(k => {
        const raw = entries[d].measurements?.[k];
        row[k] = raw ? toDisplay(parseFloat(raw)) : null;
      });
      return row;
    });
  }, [entries, selectedKeys, toDisplay]);

  function toggleKey(key) {
    setSelectedKeys(prev => {
      if (prev.includes(key)) return prev.filter(k => k !== key);
      if (prev.length >= 3) return prev; // 3 lines is already a lot to read at once
      return [...prev, key];
    });
  }

  if (fieldCounts.length === 0) return null;

  return (
    <div className="ft-card" style={{ padding: 18, marginTop: 14 }}>
      <div className="ft-label" style={{ marginBottom: 10 }}>Measurements trend</div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {fieldCounts.map(({ field: f }) => {
          const on = selectedKeys.includes(f.key);
          return (
            <button
              key={f.key}
              onClick={() => toggleKey(f.key)}
              style={{
                fontSize: 11.5, padding: "5px 11px", borderRadius: 999, cursor: "pointer",
                border: `1px solid ${on ? COLORS.ember : COLORS.border}`,
                background: on ? `${COLORS.ember}18` : "transparent",
                color: on ? COLORS.ember : COLORS.creamDim, fontWeight: on ? 700 : 500,
              }}
            >
              {f.label.split(" (")[0]}
            </button>
          );
        })}
      </div>
      {selectedKeys.length === 0 ? (
        <div style={{ fontSize: 13, color: COLORS.creamDim }}>Pick at least one measurement above to see its trend.</div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke={COLORS.border} />
            <XAxis dataKey="label" stroke={COLORS.creamDim} fontSize={11} />
            <YAxis stroke={COLORS.creamDim} fontSize={11} domain={["auto", "auto"]} unit={unitLabel} />
            <Tooltip contentStyle={{ background: COLORS.surfaceRaised, border: `1px solid ${COLORS.border}`, borderRadius: 8, color: COLORS.cream }} />
            {selectedKeys.map((k, i) => {
              const f = MEASUREMENT_FIELDS.find(x => x.key === k);
              return (
                <Line key={k} type="monotone" dataKey={k} stroke={LINE_COLORS[i % LINE_COLORS.length]} strokeWidth={2.5} dot={{ r: 3 }} connectNulls name={f.label.split(" (")[0]} />
              );
            })}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

function MeasurementPointCard({ field, entries, unitLabel, toDisplay, onJumpToDate }) {
  const [journeyDate, setJourneyDate] = useState(null);
  const dates = useMemo(
    () => Object.keys(entries).filter(d => entries[d].measurements?.[field.key]),
    [entries, field.key]
  );
  const sorted = [...dates].sort();
  const latest = sorted[sorted.length - 1];
  const previous = sorted[sorted.length - 2];
  const latestVal = latest ? toDisplay(entries[latest].measurements[field.key]) : null;
  const prevVal = previous ? toDisplay(entries[previous].measurements[field.key]) : null;
  const delta = latestVal != null && prevVal != null ? latestVal - prevVal : null;

  return (
    <div className="ft-card" style={{ padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 2 }}>
        <div className="ft-label" style={{ marginBottom: 0 }}>{field.label.split(" (")[0]}</div>
        {delta != null && Math.abs(delta) > 0.01 && (
          <span className="ft-mono" style={{ fontSize: 10.5, color: COLORS.creamDim }}>
            {delta > 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(1)} {unitLabel}
          </span>
        )}
      </div>
      {latestVal != null ? (
        <div className="ft-mono ft-grad-text" style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>{latestVal.toFixed(1)} <span style={{ fontSize: 12, opacity: 0.7 }}>{unitLabel}</span></div>
      ) : (
        <div style={{ fontSize: 12, color: COLORS.creamDim, marginBottom: 8 }}>Not measured yet</div>
      )}
      <EntryJourney
        dates={dates}
        getValue={(d) => toDisplay(entries[d].measurements[field.key])}
        getLabel={(d) => prettyDate(d).split(",")[0].slice(0, 6)}
        selectedDate={journeyDate}
        onSelect={(d) => setJourneyDate(d === journeyDate ? null : d)}
        emptyMessage="No readings yet for this one."
        renderDetail={(d) => (
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: COLORS.cream }}>{prettyDate(d)}</div>
                <div className="ft-mono" style={{ fontSize: 15, color: COLORS.ember, fontWeight: 700, marginTop: 2 }}>{toDisplay(entries[d].measurements[field.key]).toFixed(1)} {unitLabel}</div>
              </div>
              <button className="ft-btn ft-btn-ghost" style={{ fontSize: 11 }} onClick={() => onJumpToDate(d)}>
                <Pencil size={11} /> Edit
              </button>
            </div>
          </div>
        )}
      />
    </div>
  );
}

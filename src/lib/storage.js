import { supabase } from "./supabase";
import { enqueueOp, isOnline } from "./offlineQueue";
import { toastError } from "./toast";

/* ---------------------------------------------------------------
   Local "who am I" — just remembers a user_id on this device.
   No auth, no passwords — anyone with the URL can pick any user.
----------------------------------------------------------------*/

const USER_ID_KEY = "forgelog_user_id";

export function getCurrentUserId() {
  try {
    return localStorage.getItem(USER_ID_KEY) || null;
  } catch {
    return null;
  }
}

export function setCurrentUserId(id) {
  try {
    localStorage.setItem(USER_ID_KEY, id);
  } catch {}
}

export function clearCurrentUserId() {
  try {
    localStorage.removeItem(USER_ID_KEY);
  } catch {}
}

/* ---------------------------------------------------------------
   Local read cache — every successful load mirrors its result here,
   so if a later load fails (no signal), the app shows the last-known
   data instead of going blank / looking like everything vanished.
----------------------------------------------------------------*/

function cacheKey(kind, userId) {
  return `forge_cache_${kind}_${userId}`;
}
function readCache(kind, userId, fallback) {
  try {
    const raw = localStorage.getItem(cacheKey(kind, userId));
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function writeCache(kind, userId, value) {
  try {
    localStorage.setItem(cacheKey(kind, userId), JSON.stringify(value));
  } catch {}
}

function newId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function healthMetricFromRow(row) {
  return {
    date: row.date,
    restingHeartRate: row.resting_heart_rate != null ? parseFloat(row.resting_heart_rate) : null,
    sleepScore: row.sleep_score != null ? parseFloat(row.sleep_score) : null,
    sleepDurationMinutes: row.sleep_duration_minutes != null ? parseFloat(row.sleep_duration_minutes) : null,
    steps: row.steps != null ? parseFloat(row.steps) : null,
    activeZoneMinutes: row.active_zone_minutes != null ? parseFloat(row.active_zone_minutes) : null,
    hrv: row.hrv != null ? parseFloat(row.hrv) : null,
    syncedAt: row.synced_at,
  };
}

// Synced wearable data (Google Health / Fitbit Air, via api/health-sync.js)
// — date-keyed map, most recent N days. Not part of the big initial
// Promise.all load, same reasoning as pendingShares: this is externally-
// arriving data on its own schedule, not something that needs to block
// the rest of the app loading.
// Whether this user has actually gone through the OAuth "Connect
// Google Health" flow — distinct from whether health_metrics has any
// rows, since that table can also be populated by the bridge-app sync
// path (api/health-sync.js), which never touches this table at all.
// Used to gate UI that's specifically about the direct Google Health
// connection, not health data in general.
export async function loadGoogleHealthConnection(userId) {
  if (!userId) return null;
  try {
    const { data, error } = await supabase
      .from("google_health_connections")
      .select("health_user_id, connected_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    return data ? { healthUserId: data.health_user_id, connectedAt: data.connected_at } : null;
  } catch (e) {
    console.error("loadGoogleHealthConnection failed:", e);
    return null;
  }
}

export async function loadHealthMetrics(userId, days = 30) {
  if (!userId) return {};
  try {
    const { data, error } = await supabase
      .from("health_metrics")
      .select("*")
      .eq("user_id", userId)
      .order("date", { ascending: false })
      .limit(days);
    if (error) throw error;
    const map = {};
    for (const row of data || []) map[row.date] = healthMetricFromRow(row);
    return map;
  } catch (e) {
    console.error("loadHealthMetrics failed:", e);
    return {};
  }
}

// One token per user, created lazily on first request rather than at
// signup — most users will never turn this on, so there's no reason
// every profile carries one from day one.
export async function getOrCreateSyncToken(userId) {
  if (!userId) return null;
  try {
    const { data: existing, error: readErr } = await supabase
      .from("health_sync_tokens")
      .select("token")
      .eq("user_id", userId)
      .maybeSingle();
    if (readErr) throw readErr;
    if (existing) return existing.token;

    const token = newId();
    const { error: insertErr } = await supabase
      .from("health_sync_tokens")
      .insert({ user_id: userId, token });
    if (insertErr) throw insertErr;
    return token;
  } catch (e) {
    console.error("getOrCreateSyncToken failed:", e);
    toastError("Couldn't set up sync — try again.");
    return null;
  }
}

// Invalidates the old URL entirely (e.g. if it was shared/leaked) —
// whoever's still pointed at the old token starts failing immediately,
// and a fresh getOrCreateSyncToken call mints a new one.
export async function regenerateSyncToken(userId) {
  if (!userId) return null;
  try {
    const { error: delErr } = await supabase.from("health_sync_tokens").delete().eq("user_id", userId);
    if (delErr) throw delErr;
    return await getOrCreateSyncToken(userId);
  } catch (e) {
    console.error("regenerateSyncToken failed:", e);
    toastError("Couldn't reset the sync link — try again.");
    return null;
  }
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* ---------------------------------------------------------------
   Users
----------------------------------------------------------------*/

export async function fetchUsers() {
  try {
    const { data, error } = await supabase.from("users").select("id, name, avatar_data").order("name");
    if (error) throw error;
    writeCache("users", "all", data || []);
    return data || [];
  } catch (e) {
    console.error("fetchUsers failed, using cache:", e);
    return readCache("users", "all", []);
  }
}

export async function createUser(name) {
  const { data, error } = await supabase.from("users").insert({ name }).select().single();
  if (error) {
    console.error("createUser failed:", error);
    throw error;
  }
  return data;
}

export async function fetchUserById(id) {
  if (!id) return null;
  try {
    const { data, error } = await supabase.from("users").select("id, name, avatar_data").eq("id", id).maybeSingle();
    if (error) throw error;
    if (data) writeCache("user", id, data);
    return data;
  } catch (e) {
    console.error("fetchUserById failed, using cache:", e);
    return readCache("user", id, null);
  }
}

export async function renameUser(id, name) {
  if (!isOnline()) {
    enqueueOp("renameUser", [id, name]);
    return;
  }
  try {
    const { error } = await supabase.from("users").update({ name }).eq("id", id);
    if (error) throw error;
  } catch (e) {
    console.error("renameUser failed, queuing for retry:", e);
    toastError("Couldn't save — we'll keep retrying in the background.");
    enqueueOp("renameUser", [id, name]);
  }
}

// Stores a small compressed image (base64 data URL) as the user's avatar.
// Resizing/compression happens client-side before this is called, so the
// data URL is already small (~150x150, JPEG) — safe to store as text.
export async function setUserAvatar(id, dataUrl) {
  if (!isOnline()) {
    enqueueOp("setUserAvatar", [id, dataUrl]);
    return;
  }
  try {
    const { error } = await supabase.from("users").update({ avatar_data: dataUrl }).eq("id", id);
    if (error) throw error;
  } catch (e) {
    console.error("setUserAvatar failed, queuing for retry:", e);
    toastError("Couldn't save — we'll keep retrying in the background.");
    enqueueOp("setUserAvatar", [id, dataUrl]);
  }
}

/* ---------------------------------------------------------------
   Profile  (camelCase in the app  <->  snake_case in Postgres)
----------------------------------------------------------------*/

const DEFAULT_PROFILE = {
  gender: "male",
  age: 26,
  heightIn: 70,
  activityIdx: 1,
  goalType: "lose",
  goalRateLbsPerWeek: 1,
  goalWeightLbs: null,
  waterGoalOz: null,
  miniCutStartedOn: null,
  goalStartedOn: null,
  adaptiveTdee: null,
  adaptiveTdeeSetOn: null,
  adaptiveTdeeUpdatedAt: null,
  bodyFatMethod: "formula", // "formula" | "navy" | "blend"
  showBodyFatPct: null,
  creatineAlreadySaturated: false,
  setCoverageTargets: null,
  // Opt-in: RPE/RIR-driven autoregulation layered on top of the
  // always-on percentage-based suggestion math. Off by default so
  // nobody's logging flow changes shape without them choosing it.
  dedicatedProgressiveOverload: false,
  // Per-lift goal weight for an upcoming Big 3 max attempt, e.g.
  // { squat: 335, bench: 245, deadlift: null } — feeds the warm-up
  // pyramid plan on the Big 3 Maxes tab.
  maxDayGoals: null,
  // Opt-in alternative to mini_cut's flat 25%-below-TDEE rule — a
  // specific %-of-bodyweight-per-week rate instead, with an optional
  // taper to a gentler rate once weight crosses a threshold (protects
  // muscle as a cut gets deeper into a leaner bodyweight). Null for
  // everyone by default; mini_cut's normal flat-25% math is completely
  // unaffected unless this is explicitly set.
  customLossRatePct: null,
  customLossRateTaperWeight: null,
  customLossRateTaperedPct: null,
};

function profileFromRow(row) {
  if (!row) return DEFAULT_PROFILE;
  // "aggressive" was the old name for what's now "mini_cut" — map it so
  // anyone who saved a profile before the rename keeps working correctly.
  const rawGoalType = row.goal_type ?? DEFAULT_PROFILE.goalType;
  return {
    gender: row.gender ?? DEFAULT_PROFILE.gender,
    age: row.age ?? DEFAULT_PROFILE.age,
    heightIn: row.height_in ?? DEFAULT_PROFILE.heightIn,
    activityIdx: row.activity_idx ?? DEFAULT_PROFILE.activityIdx,
    goalType: rawGoalType === "aggressive" ? "mini_cut" : rawGoalType,
    goalRateLbsPerWeek: row.goal_rate_lbs_per_week ?? DEFAULT_PROFILE.goalRateLbsPerWeek,
    goalWeightLbs: row.goal_weight_lbs ?? null,
    waterGoalOz: row.water_goal_oz ?? null,
    miniCutStartedOn: row.mini_cut_started_on ?? null,
    goalStartedOn: row.goal_started_on ?? null,
    adaptiveTdee: row.adaptive_tdee ?? null,
    adaptiveTdeeSetOn: row.adaptive_tdee_set_on ?? null,
    // Was missing from this mapping entirely — the column didn't even
    // exist in Supabase (added in v30_adaptive_tdee_updated_at). Without
    // it, this always came back null on a fresh load, so the 72-hour
    // auto-update cooldown in maybeAutoUpdateAdaptiveTdee (App.jsx) had
    // no persisted memory of when it last fired: it looked "expired"
    // immediately after every reload, regardless of how recently it had
    // actually run in a previous session.
    adaptiveTdeeUpdatedAt: row.adaptive_tdee_updated_at ?? null,
    // v32_body_fat_method added the real 3-way column and backfilled it
    // from the old boolean for every existing row; the boolean fallback
    // here only matters for a row that migration somehow missed.
    bodyFatMethod: row.body_fat_method ?? (row.use_adaptive_body_fat ? "blend" : "formula"),
    showBodyFatPct: row.show_body_fat_pct ?? null,
    creatineAlreadySaturated: row.creatine_already_saturated ?? false,
    setCoverageTargets: row.set_coverage_targets ?? null,
    dedicatedProgressiveOverload: row.dedicated_progressive_overload ?? false,
    maxDayGoals: row.max_day_goals ?? null,
    customLossRatePct: row.custom_loss_rate_pct ?? null,
    customLossRateTaperWeight: row.custom_loss_rate_taper_weight ?? null,
    customLossRateTaperedPct: row.custom_loss_rate_tapered_pct ?? null,
  };
}

function profileToRow(userId, profile) {
  return {
    user_id: userId,
    gender: profile.gender,
    age: profile.age,
    height_in: profile.heightIn,
    activity_idx: profile.activityIdx,
    goal_type: profile.goalType,
    goal_rate_lbs_per_week: profile.goalRateLbsPerWeek,
    goal_weight_lbs: profile.goalWeightLbs ?? null,
    water_goal_oz: profile.waterGoalOz ?? null,
    mini_cut_started_on: profile.miniCutStartedOn ?? null,
    goal_started_on: profile.goalStartedOn ?? null,
    adaptive_tdee: profile.adaptiveTdee ?? null,
    adaptive_tdee_set_on: profile.adaptiveTdeeSetOn ?? null,
    adaptive_tdee_updated_at: profile.adaptiveTdeeUpdatedAt ?? null,
    body_fat_method: profile.bodyFatMethod ?? "formula",
    // Kept in sync for backward compatibility, though nothing in this
    // app reads it anymore now that body_fat_method exists.
    use_adaptive_body_fat: profile.bodyFatMethod === "blend",
    show_body_fat_pct: profile.showBodyFatPct ?? null,
    creatine_already_saturated: profile.creatineAlreadySaturated ?? false,
    set_coverage_targets: profile.setCoverageTargets ?? null,
    dedicated_progressive_overload: profile.dedicatedProgressiveOverload ?? false,
    max_day_goals: profile.maxDayGoals ?? null,
    custom_loss_rate_pct: profile.customLossRatePct ?? null,
    custom_loss_rate_taper_weight: profile.customLossRateTaperWeight ?? null,
    custom_loss_rate_tapered_pct: profile.customLossRateTaperedPct ?? null,
  };
}

export async function loadProfile(userId) {
  if (!userId) return DEFAULT_PROFILE;
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    const profile = profileFromRow(data);
    writeCache("profile", userId, profile);
    return profile;
  } catch (e) {
    console.error("loadProfile failed, using cache:", e);
    return readCache("profile", userId, DEFAULT_PROFILE);
  }
}

export async function saveProfile(userId, profile) {
  if (!userId) return;
  writeCache("profile", userId, profile); // optimistic — show it immediately

  if (!isOnline()) {
    enqueueOp("saveProfile", [userId, profile]);
    return;
  }
  try {
    const { error } = await supabase
      .from("profiles")
      .upsert(profileToRow(userId, profile), { onConflict: "user_id" });
    if (error) throw error;
  } catch (e) {
    console.error("saveProfile failed, queuing for retry:", e);
    toastError("Couldn't save — we'll keep retrying in the background.");
    enqueueOp("saveProfile", [userId, profile]);
  }
}

/* ---------------------------------------------------------------
   Entries  (one row per user_id + date  <->  app's { [date]: entry } map)
----------------------------------------------------------------*/

function entryFromRow(row) {
  return {
    weight: row.weight,
    caloriesConsumed: row.calories_consumed,
    protein: row.protein,
    carbs: row.carbs,
    fat: row.fat,
    creatine: row.creatine,
    bodyFatPct: row.body_fat_pct,
    fatLbs: row.fat_lbs,
    suggestedCalories: row.suggested_calories,
    meals: row.meals || [],
    measurements: row.measurements || {},
    weigh_ins: row.weigh_ins || [],
    water_logs: row.water_logs || [],
  };
}

function entryToRow(userId, date, entry) {
  // Defensive: a null/undefined entry here previously crashed on
  // entry.weight (surfaced in the UI as "Last error (saveEntry): null is
  // not an object (evaluating 'r.weight')" — r being the minified name
  // for this parameter in the production build). saveEntry now refuses
  // to even queue a call like that in the first place, but this fallback
  // also covers offlineExecutors.saveEntry below, which calls this
  // directly during queue replay and wouldn't go through that guard —
  // and covers any already-queued op from before that guard existed,
  // sitting in someone's local queue on an old app version.
  entry = entry || {};
  return {
    user_id: userId,
    date,
    weight: entry.weight,
    calories_consumed: entry.caloriesConsumed,
    protein: entry.protein,
    carbs: entry.carbs,
    fat: entry.fat,
    creatine: entry.creatine,
    body_fat_pct: entry.bodyFatPct,
    fat_lbs: entry.fatLbs,
    suggested_calories: entry.suggestedCalories,
    meals: entry.meals || [],
    measurements: entry.measurements || {},
    weigh_ins: entry.weigh_ins || [],
    water_logs: entry.water_logs || [],
  };
}

export async function loadEntries(userId) {
  if (!userId) return {};
  try {
    const { data, error } = await supabase
      .from("entries")
      .select("*")
      .eq("user_id", userId)
      .order("date");
    if (error) throw error;
    const map = {};
    for (const row of data || []) map[row.date] = entryFromRow(row);
    writeCache("entries", userId, map);
    return map;
  } catch (e) {
    console.error("loadEntries failed, using cache:", e);
    return readCache("entries", userId, {});
  }
}

// Saves a single day's entry (upsert on the user_id+date unique key).
export async function saveEntry(userId, date, entry) {
  if (!userId) return;
  if (!entry) {
    console.error("saveEntry called with no entry data — refusing to save or queue this", { userId, date });
    return;
  }

  // Mirror into the cache immediately so a reload (even offline) still
  // shows this entry, and so the queued replay has a consistent source.
  const cached = readCache("entries", userId, {});
  cached[date] = entry;
  writeCache("entries", userId, cached);

  if (!isOnline()) {
    enqueueOp("saveEntry", [userId, date, entry]);
    return;
  }
  try {
    const { error } = await supabase
      .from("entries")
      .upsert(entryToRow(userId, date, entry), { onConflict: "user_id,date" });
    if (error) throw error;
  } catch (e) {
    console.error("saveEntry failed, queuing for retry:", e);
    toastError("Couldn't save — we'll keep retrying in the background.");
    enqueueOp("saveEntry", [userId, date, entry]);
  }
}

export async function deleteEntry(userId, date) {
  if (!userId) return;

  const cached = readCache("entries", userId, {});
  delete cached[date];
  writeCache("entries", userId, cached);

  if (!isOnline()) {
    enqueueOp("deleteEntry", [userId, date]);
    return;
  }
  try {
    const { error } = await supabase.from("entries").delete().eq("user_id", userId).eq("date", date);
    if (error) throw error;
  } catch (e) {
    console.error("deleteEntry failed, queuing for retry:", e);
    toastError("Couldn't save — we'll keep retrying in the background.");
    enqueueOp("deleteEntry", [userId, date]);
  }
}

/* ---------------------------------------------------------------
   Overload Log — progressive overload / workout sessions.
   Completely separate from the daily entries table; one row per
   logged session (an exercise + its sets on a given date), scoped
   by user_id like everything else.
----------------------------------------------------------------*/

function sessionFromRow(row) {
  return {
    id: row.id,
    date: row.date,
    exercise: row.exercise,
    group: row.muscle_group,
    sets: row.sets || [],
    splitId: row.split_id ?? null,
    // Was silently dropped before — the column has existed since the
    // earliest migration, and select("*") was already fetching it, it
    // just never made it into the mapped object. Used as a tiebreak
    // wherever "the last session" matters (PR flags, progression/deload
    // suggestions, exercise history) — date alone can't distinguish two
    // sessions of the same exercise logged on the same calendar day.
    createdAt: row.created_at ?? null,
  };
}

export async function loadWorkoutSessions(userId) {
  if (!userId) return [];
  try {
    const { data, error } = await supabase
      .from("workout_sessions")
      .select("*")
      .eq("user_id", userId)
      .order("date")
      .order("created_at");
    if (error) throw error;
    const sessions = (data || []).map(sessionFromRow);
    writeCache("sessions", userId, sessions);
    return sessions;
  } catch (e) {
    console.error("loadWorkoutSessions failed, using cache:", e);
    return readCache("sessions", userId, []);
  }
}

// Inserts one or more finished exercise blocks as new session rows.
// IDs are generated client-side so the UI can show them immediately even
// before the write reaches the server (and so a queued retry replays
// with the exact same IDs instead of creating duplicates). created_at is
// also set client-side (rather than left to the DB default) so the
// optimistic version shown before the server round-trip already has a
// real timestamp instead of a temporary null.
export async function insertWorkoutSessions(userId, sessions) {
  if (!userId || !sessions.length) return [];
  const rows = sessions.map((s) => ({
    id: newId(),
    user_id: userId,
    date: s.date,
    exercise: s.exercise,
    muscle_group: s.group,
    sets: s.sets,
    split_id: s.splitId ?? null,
    created_at: new Date().toISOString(),
  }));
  const optimistic = rows.map(sessionFromRow);

  const cached = readCache("sessions", userId, []);
  writeCache("sessions", userId, [...cached, ...optimistic]);

  if (!isOnline()) {
    enqueueOp("insertWorkoutSessionsRaw", [rows]);
    return optimistic;
  }
  try {
    const { data, error } = await supabase.from("workout_sessions").insert(rows).select();
    if (error) throw error;
    return (data || []).map(sessionFromRow);
  } catch (e) {
    console.error("insertWorkoutSessions failed, queuing for retry:", e);
    toastError("Couldn't save — we'll keep retrying in the background.");
    enqueueOp("insertWorkoutSessionsRaw", [rows]);
    return optimistic;
  }
}

export async function deleteWorkoutSession(userId, id) {
  if (!userId) return;

  const cached = readCache("sessions", userId, []);
  writeCache("sessions", userId, cached.filter((s) => s.id !== id));

  if (!isOnline()) {
    enqueueOp("deleteWorkoutSession", [userId, id]);
    return;
  }
  try {
    const { error } = await supabase.from("workout_sessions").delete().eq("user_id", userId).eq("id", id);
    if (error) throw error;
  } catch (e) {
    console.error("deleteWorkoutSession failed, queuing for retry:", e);
    toastError("Couldn't save — we'll keep retrying in the background.");
    enqueueOp("deleteWorkoutSession", [userId, id]);
  }
}

// Deletes every session for a given user+date+split in one server-side
// query, instead of looping over whatever IDs the client's local
// workoutSessions state currently happens to know about. That loop-over-
// known-IDs pattern is exactly what let re-saving an already-logged day
// silently duplicate it: if the local state hadn't yet caught up with
// what was actually already in the database (stale prop, a reload
// mid-session, anything), the "existing rows to delete" list would miss
// real rows, and the fresh insert right after would land on top of them
// instead of replacing them. A single filtered delete is correct
// regardless of what the client's local state currently believes.
export async function deleteWorkoutSessionsForDate(userId, date, splitId) {
  if (!userId) return;

  const cached = readCache("sessions", userId, []);
  writeCache("sessions", userId, cached.filter((s) => !(s.date === date && s.splitId === splitId)));

  if (!isOnline()) {
    enqueueOp("deleteWorkoutSessionsForDate", [userId, date, splitId]);
    return;
  }
  try {
    const { error } = await supabase.from("workout_sessions").delete().eq("user_id", userId).eq("date", date).eq("split_id", splitId);
    if (error) throw error;
  } catch (e) {
    console.error("deleteWorkoutSessionsForDate failed, queuing for retry:", e);
    toastError("Couldn't save — we'll keep retrying in the background.");
    enqueueOp("deleteWorkoutSessionsForDate", [userId, date, splitId]);
  }
}

function maxAttemptFromRow(row) {
  return {
    id: row.id,
    exercise: row.exercise,
    weight: parseFloat(row.weight),
    date: row.date,
    pass: !!row.pass,
  };
}

// Big 3 max attempts (squat/bench/deadlift) — deliberately a separate
// table from workout_sessions, since a max attempt is a single pass/fail
// lift with no rep count, not a set of reps like everything else logged
// through Daily Log.
export async function loadMaxAttempts(userId) {
  if (!userId) return [];
  try {
    const { data, error } = await supabase
      .from("max_attempts")
      .select("*")
      .eq("user_id", userId)
      .order("date")
      .order("created_at");
    if (error) throw error;
    const attempts = (data || []).map(maxAttemptFromRow);
    writeCache("maxAttempts", userId, attempts);
    return attempts;
  } catch (e) {
    console.error("loadMaxAttempts failed, using cache:", e);
    return readCache("maxAttempts", userId, []);
  }
}

export async function insertMaxAttempt(userId, attempt) {
  if (!userId) return null;
  const row = {
    id: newId(),
    user_id: userId,
    exercise: attempt.exercise,
    weight: attempt.weight,
    date: attempt.date,
    pass: attempt.pass,
  };
  const optimistic = maxAttemptFromRow(row);
  const cached = readCache("maxAttempts", userId, []);
  writeCache("maxAttempts", userId, [...cached, optimistic]);

  if (!isOnline()) {
    enqueueOp("insertMaxAttemptRaw", [row]);
    return optimistic;
  }
  try {
    const { error } = await supabase.from("max_attempts").insert(row);
    if (error) throw error;
    return optimistic;
  } catch (e) {
    console.error("insertMaxAttempt failed, queuing for retry:", e);
    toastError("Couldn't save — we'll keep retrying in the background.");
    enqueueOp("insertMaxAttemptRaw", [row]);
    return optimistic;
  }
}

export async function deleteMaxAttempt(userId, id) {
  if (!userId) return;

  const cached = readCache("maxAttempts", userId, []);
  writeCache("maxAttempts", userId, cached.filter((a) => a.id !== id));

  if (!isOnline()) {
    enqueueOp("deleteMaxAttempt", [userId, id]);
    return;
  }
  try {
    const { error } = await supabase.from("max_attempts").delete().eq("user_id", userId).eq("id", id);
    if (error) throw error;
  } catch (e) {
    console.error("deleteMaxAttempt failed, queuing for retry:", e);
    toastError("Couldn't save — we'll keep retrying in the background.");
    enqueueOp("deleteMaxAttempt", [userId, id]);
  }
}

function rehabLogFromRow(row) {
  return {
    id: row.id,
    date: row.date,
    side: row.side,
    exercise: row.exercise,
    sets: row.sets || [],
  };
}

// Free-form left/right tracking (Balancing Chart tab — DB table and
// internal names still say "rehab", since that's what this table/these
// functions were originally built as; only the user-facing label
// changed) — deliberately NOT tied to a split, a split day, or the
// curated exercise pool in splits.js, since the whole point is logging
// whatever the person's balance-check work has them doing, exercise
// name typed freely. Same cache-first / optimistic / offline-queue-on-
// failure pattern as everywhere else in this file.
export async function loadRehabLogs(userId) {
  if (!userId) return [];
  try {
    const { data, error } = await supabase
      .from("rehab_logs")
      .select("*")
      .eq("user_id", userId)
      .order("date")
      .order("created_at");
    if (error) throw error;
    const logs = (data || []).map(rehabLogFromRow);
    writeCache("rehabLogs", userId, logs);
    return logs;
  } catch (e) {
    console.error("loadRehabLogs failed, using cache:", e);
    return readCache("rehabLogs", userId, []);
  }
}

export async function insertRehabLog(userId, log) {
  if (!userId) return null;
  const row = {
    id: newId(),
    user_id: userId,
    date: log.date,
    side: log.side,
    exercise: log.exercise,
    sets: log.sets || [],
  };
  const optimistic = rehabLogFromRow(row);
  const cached = readCache("rehabLogs", userId, []);
  writeCache("rehabLogs", userId, [...cached, optimistic]);

  if (!isOnline()) {
    enqueueOp("insertRehabLogRaw", [row]);
    return optimistic;
  }
  try {
    const { error } = await supabase.from("rehab_logs").insert(row);
    if (error) throw error;
    return optimistic;
  } catch (e) {
    console.error("insertRehabLog failed, queuing for retry:", e);
    toastError("Couldn't save — we'll keep retrying in the background.");
    enqueueOp("insertRehabLogRaw", [row]);
    return optimistic;
  }
}

export async function deleteRehabLog(userId, id) {
  if (!userId) return;

  const cached = readCache("rehabLogs", userId, []);
  writeCache("rehabLogs", userId, cached.filter((l) => l.id !== id));

  if (!isOnline()) {
    enqueueOp("deleteRehabLog", [userId, id]);
    return;
  }
  try {
    const { error } = await supabase.from("rehab_logs").delete().eq("user_id", userId).eq("id", id);
    if (error) throw error;
  } catch (e) {
    console.error("deleteRehabLog failed, queuing for retry:", e);
    toastError("Couldn't save — we'll keep retrying in the background.");
    enqueueOp("deleteRehabLog", [userId, id]);
  }
}

function customDayPlanFromRow(row) {
  return {
    date: row.date,
    dayType: row.day_type,
    isRest: !!row.is_rest,
    exercises: row.exercises || [],
  };
}

// A one-time forward plan for specific calendar dates — keyed by date in
// the returned object (not an array) since callers always want "what's
// planned for THIS date," never a list to iterate.
export async function loadCustomDayPlans(userId) {
  if (!userId) return {};
  try {
    const { data, error } = await supabase
      .from("custom_day_plans")
      .select("*")
      .eq("user_id", userId)
      .order("date");
    if (error) throw error;
    const map = {};
    for (const row of data || []) map[row.date] = customDayPlanFromRow(row);
    writeCache("customDayPlans", userId, map);
    return map;
  } catch (e) {
    console.error("loadCustomDayPlans failed, using cache:", e);
    return readCache("customDayPlans", userId, {});
  }
}

// Upsert on (user_id, date) — re-planning an already-planned date cleanly
// replaces it rather than creating a duplicate row, matching the unique
// constraint on the table.
export async function saveCustomDayPlan(userId, plan) {
  if (!userId) return null;
  const row = {
    user_id: userId,
    date: plan.date,
    day_type: plan.dayType,
    is_rest: plan.isRest,
    exercises: plan.exercises || [],
  };
  const optimistic = customDayPlanFromRow(row);
  const cached = readCache("customDayPlans", userId, {});
  writeCache("customDayPlans", userId, { ...cached, [plan.date]: optimistic });

  if (!isOnline()) {
    enqueueOp("saveCustomDayPlanRaw", [row]);
    return optimistic;
  }
  try {
    const { error } = await supabase.from("custom_day_plans").upsert(row, { onConflict: "user_id,date" });
    if (error) throw error;
    return optimistic;
  } catch (e) {
    console.error("saveCustomDayPlan failed, queuing for retry:", e);
    toastError("Couldn't save — we'll keep retrying in the background.");
    enqueueOp("saveCustomDayPlanRaw", [row]);
    return optimistic;
  }
}

export async function deleteCustomDayPlan(userId, date) {
  if (!userId) return;

  const cached = readCache("customDayPlans", userId, {});
  const next = { ...cached };
  delete next[date];
  writeCache("customDayPlans", userId, next);

  if (!isOnline()) {
    enqueueOp("deleteCustomDayPlan", [userId, date]);
    return;
  }
  try {
    const { error } = await supabase.from("custom_day_plans").delete().eq("user_id", userId).eq("date", date);
    if (error) throw error;
  } catch (e) {
    console.error("deleteCustomDayPlan failed, queuing for retry:", e);
    toastError("Couldn't save — we'll keep retrying in the background.");
    enqueueOp("deleteCustomDayPlan", [userId, date]);
  }
}

// ---------- Calorie overrides ----------
// A per-date custom "Suggested calories" that overrides the normal
// profile-formula number for that specific day — e.g. a hand-planned
// cut schedule. Same {date: value} map shape and upsert-on-date pattern
// as custom_day_plans above. Not yet exposed as its own Settings
// editor — for now these get written directly; when no override exists
// for a date, callers fall back to the formula exactly as before.
export async function loadCalorieOverrides(userId) {
  if (!userId) return {};
  try {
    const { data, error } = await supabase
      .from("calorie_overrides")
      .select("*")
      .eq("user_id", userId)
      .order("date");
    if (error) throw error;
    const map = {};
    for (const row of data || []) map[row.date] = parseFloat(row.calories);
    writeCache("calorieOverrides", userId, map);
    return map;
  } catch (e) {
    console.error("loadCalorieOverrides failed, using cache:", e);
    return readCache("calorieOverrides", userId, {});
  }
}

// Fully separate from loadCalorieOverrides above rather than changing
// that function's return shape — calorieOverrides is read as a bare
// number-per-date in a lot of places already (Dashboard, computeStats,
// the trend chart), and changing it to an object would mean touching
// every one of those call sites. This reads the SAME table's protein/
// fat/carbs columns into their own date-keyed map instead, only
// including a date if at least one macro was actually set on it (a
// calories-only override row, the far more common case, correctly
// produces no entry here).
export async function loadMacroOverrides(userId) {
  if (!userId) return {};
  try {
    const { data, error } = await supabase
      .from("calorie_overrides")
      .select("date, protein, fat, carbs")
      .eq("user_id", userId)
      .order("date");
    if (error) throw error;
    const map = {};
    for (const row of data || []) {
      if (row.protein == null && row.fat == null && row.carbs == null) continue;
      map[row.date] = {
        protein: row.protein != null ? parseFloat(row.protein) : null,
        fat: row.fat != null ? parseFloat(row.fat) : null,
        carbs: row.carbs != null ? parseFloat(row.carbs) : null,
      };
    }
    return map;
  } catch (e) {
    console.error("loadMacroOverrides failed:", e);
    return {};
  }
}

// macros ({protein,fat,carbs}) is optional and additive — omitted keys
// are simply absent from the upsert payload, so PostgREST leaves
// whatever's already stored in those columns untouched rather than
// nulling them out. Every existing 3-argument call site (calories
// only) keeps working exactly as before.
export async function saveCalorieOverride(userId, date, calories, macros = null) {
  if (!userId) return null;
  const row = { user_id: userId, date, calories };
  if (macros) {
    if (macros.protein != null) row.protein = macros.protein;
    if (macros.fat != null) row.fat = macros.fat;
    if (macros.carbs != null) row.carbs = macros.carbs;
  }
  const cached = readCache("calorieOverrides", userId, {});
  writeCache("calorieOverrides", userId, { ...cached, [date]: calories });

  if (!isOnline()) {
    enqueueOp("saveCalorieOverrideRaw", [row]);
    return calories;
  }
  try {
    const { error } = await supabase.from("calorie_overrides").upsert(row, { onConflict: "user_id,date" });
    if (error) throw error;
    return calories;
  } catch (e) {
    console.error("saveCalorieOverride failed, queuing for retry:", e);
    toastError("Couldn't save — we'll keep retrying in the background.");
    enqueueOp("saveCalorieOverrideRaw", [row]);
    return calories;
  }
}

export async function deleteCalorieOverride(userId, date) {
  if (!userId) return;

  const cached = readCache("calorieOverrides", userId, {});
  const next = { ...cached };
  delete next[date];
  writeCache("calorieOverrides", userId, next);

  if (!isOnline()) {
    enqueueOp("deleteCalorieOverride", [userId, date]);
    return;
  }
  try {
    const { error } = await supabase.from("calorie_overrides").delete().eq("user_id", userId).eq("date", date);
    if (error) throw error;
  } catch (e) {
    console.error("deleteCalorieOverride failed, queuing for retry:", e);
    toastError("Couldn't save — we'll keep retrying in the background.");
    enqueueOp("deleteCalorieOverride", [userId, date]);
  }
}

// ---------- Workout attendance ----------
// Backfilling "I worked out this day" for days logged before someone
// started using the app (or just forgot to log in the moment) —
// deliberately just a date, no exercise data. Kept as its own table
// rather than a fake workout_sessions row specifically so it can never
// pollute PR tracking, volume totals, or exercise history with data
// that was never actually logged — the History calendar renders these
// with a distinct visual treatment from real logged days for the same
// reason (see the attendance calendar in SplitDashboard).
export async function loadWorkoutAttendance(userId) {
  if (!userId) return new Set();
  try {
    const { data, error } = await supabase.from("workout_attendance").select("date").eq("user_id", userId);
    if (error) throw error;
    const dates = (data || []).map(r => r.date);
    writeCache("workoutAttendance", userId, dates);
    return new Set(dates);
  } catch (e) {
    console.error("loadWorkoutAttendance failed, using cache:", e);
    return new Set(readCache("workoutAttendance", userId, []));
  }
}

export async function markWorkoutAttendance(userId, date) {
  if (!userId) return;
  const cached = readCache("workoutAttendance", userId, []);
  if (!cached.includes(date)) writeCache("workoutAttendance", userId, [...cached, date]);

  const row = { user_id: userId, date };
  if (!isOnline()) {
    enqueueOp("markWorkoutAttendanceRaw", [row]);
    return;
  }
  try {
    const { error } = await supabase.from("workout_attendance").upsert(row, { onConflict: "user_id,date" });
    if (error) throw error;
  } catch (e) {
    console.error("markWorkoutAttendance failed, queuing for retry:", e);
    toastError("Couldn't save — we'll keep retrying in the background.");
    enqueueOp("markWorkoutAttendanceRaw", [row]);
  }
}

export async function unmarkWorkoutAttendance(userId, date) {
  if (!userId) return;
  const cached = readCache("workoutAttendance", userId, []);
  writeCache("workoutAttendance", userId, cached.filter(d => d !== date));

  if (!isOnline()) {
    enqueueOp("unmarkWorkoutAttendance", [userId, date]);
    return;
  }
  try {
    const { error } = await supabase.from("workout_attendance").delete().eq("user_id", userId).eq("date", date);
    if (error) throw error;
  } catch (e) {
    console.error("unmarkWorkoutAttendance failed, queuing for retry:", e);
    toastError("Couldn't save — we'll keep retrying in the background.");
    enqueueOp("unmarkWorkoutAttendance", [userId, date]);
  }
}

function customSplitTemplateFromRow(row) {
  return { id: row.id, name: row.name, days: row.days || [] };
}

// Named, reusable version of a week built in the day-plan builder —
// keyed by relative day position (Day 1..7), not real dates, so the
// same template can be applied to any future week.
export async function loadCustomSplitTemplates(userId) {
  if (!userId) return [];
  try {
    const { data, error } = await supabase
      .from("custom_split_templates")
      .select("*")
      .eq("user_id", userId)
      .order("created_at");
    if (error) throw error;
    const templates = (data || []).map(customSplitTemplateFromRow);
    writeCache("customSplitTemplates", userId, templates);
    return templates;
  } catch (e) {
    console.error("loadCustomSplitTemplates failed, using cache:", e);
    return readCache("customSplitTemplates", userId, []);
  }
}

export async function saveCustomSplitTemplate(userId, template) {
  if (!userId) return null;
  const row = {
    id: (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    user_id: userId,
    name: template.name,
    days: template.days || [],
  };
  const optimistic = customSplitTemplateFromRow(row);
  const cached = readCache("customSplitTemplates", userId, []);
  writeCache("customSplitTemplates", userId, [...cached, optimistic]);

  if (!isOnline()) {
    enqueueOp("saveCustomSplitTemplateRaw", [row]);
    return optimistic;
  }
  try {
    const { error } = await supabase.from("custom_split_templates").insert(row);
    if (error) throw error;
    return optimistic;
  } catch (e) {
    console.error("saveCustomSplitTemplate failed, queuing for retry:", e);
    toastError("Couldn't save — we'll keep retrying in the background.");
    enqueueOp("saveCustomSplitTemplateRaw", [row]);
    return optimistic;
  }
}

export async function deleteCustomSplitTemplate(userId, id) {
  if (!userId) return;

  const cached = readCache("customSplitTemplates", userId, []);
  writeCache("customSplitTemplates", userId, cached.filter((t) => t.id !== id));

  if (!isOnline()) {
    enqueueOp("deleteCustomSplitTemplate", [userId, id]);
    return;
  }
  try {
    const { error } = await supabase.from("custom_split_templates").delete().eq("user_id", userId).eq("id", id);
    if (error) throw error;
  } catch (e) {
    console.error("deleteCustomSplitTemplate failed, queuing for retry:", e);
    toastError("Couldn't save — we'll keep retrying in the background.");
    enqueueOp("deleteCustomSplitTemplate", [userId, id]);
  }
}

function splitShareFromRow(row) {
  return { id: row.id, fromUserId: row.from_user_id, fromName: row.from_name, name: row.name, days: row.days || [], createdAt: row.created_at };
}

// Sending a saved (or just-built) split template to another user. Two
// distinct paths, matching the two ways this was asked for:
//   - forced=true skips the accept step entirely — it's written straight
//     into the recipient's own saved-plan list via the same
//     saveCustomSplitTemplate() used when someone builds one themselves,
//     so a forced share is indistinguishable from a self-made template
//     once it lands.
//   - forced=false creates a pending row in split_shares instead. It
//     doesn't touch the recipient's saved plans until they accept it —
//     see acceptSplitShare below.
// Deliberately NOT run through the offline queue's optimistic-cache
// pattern the way most other writes are: there's no local "cache" of
// someone else's pending-shares inbox to optimistically update, since
// this writes into another user's data, not the sender's own. Still
// queued for retry on failure so a share sent while offline isn't
// silently dropped.
export async function shareSplitTemplate(fromUserId, fromName, toUserId, template, forced) {
  if (!toUserId) return null;
  if (forced) {
    return saveCustomSplitTemplate(toUserId, template);
  }
  const row = {
    id: (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    from_user_id: fromUserId,
    to_user_id: toUserId,
    from_name: fromName || "",
    name: template.name,
    days: template.days || [],
    status: "pending",
  };
  if (!isOnline()) {
    enqueueOp("shareSplitTemplateRaw", [row]);
    return splitShareFromRow(row);
  }
  try {
    const { error } = await supabase.from("split_shares").insert(row);
    if (error) throw error;
    return splitShareFromRow(row);
  } catch (e) {
    console.error("shareSplitTemplate failed, queuing for retry:", e);
    toastError("Couldn't send that share — we'll keep retrying in the background.");
    enqueueOp("shareSplitTemplateRaw", [row]);
    return splitShareFromRow(row);
  }
}

// Pending shares waiting on the CURRENT user's decision. Not cached
// locally the way most loaders are — this is someone else's action
// waiting on you, not your own data, so it's always fetched fresh
// rather than risking a stale "you have a pending share" that's
// actually already been accepted/declined elsewhere.
export async function loadPendingSplitShares(userId) {
  if (!userId) return [];
  try {
    const { data, error } = await supabase
      .from("split_shares")
      .select("*")
      .eq("to_user_id", userId)
      .eq("status", "pending")
      .order("created_at");
    if (error) throw error;
    return (data || []).map(splitShareFromRow);
  } catch (e) {
    console.error("loadPendingSplitShares failed:", e);
    return [];
  }
}

// Accepting drops the share into the recipient's OWN saved-plan list —
// same saveCustomSplitTemplate() call a self-built template goes
// through, so once accepted it's a completely normal saved plan with
// no lingering "this came from a share" distinction. The status update
// is best-effort; even if it fails, the template's already saved, so
// this never throws back to the caller.
export async function acceptSplitShare(userId, share) {
  const saved = await saveCustomSplitTemplate(userId, { name: share.name, days: share.days });
  try {
    const { error } = await supabase.from("split_shares").update({ status: "accepted" }).eq("id", share.id);
    if (error) throw error;
  } catch (e) {
    console.error("acceptSplitShare status update failed, queuing for retry:", e);
    enqueueOp("updateSplitShareStatus", [share.id, "accepted"]);
  }
  return saved;
}

export async function declineSplitShare(shareId) {
  try {
    const { error } = await supabase.from("split_shares").update({ status: "declined" }).eq("id", shareId);
    if (error) throw error;
  } catch (e) {
    console.error("declineSplitShare failed, queuing for retry:", e);
    enqueueOp("updateSplitShareStatus", [shareId, "declined"]);
  }
}

// Push notification subscriptions — deliberately NOT run through the
// offline queue like everything else in this file. Subscribing requires
// a live connection to the browser's push service in the first place
// (there's nothing to queue and retry — if you're offline, the
// subscribe attempt itself fails immediately), and it's a rare,
// deliberate action rather than routine logging data.
export async function loadPushSubscriptions(userId) {
  if (!userId) return [];
  try {
    const { data, error } = await supabase.from("push_subscriptions").select("*").eq("user_id", userId);
    if (error) throw error;
    return data || [];
  } catch (e) {
    console.error("loadPushSubscriptions failed:", e);
    return [];
  }
}

// Upsert on endpoint (unique per browser+device) — resubscribing the
// same device (e.g. after clearing the permission and re-enabling)
// cleanly replaces its row instead of erroring on a duplicate.
export async function savePushSubscription(userId, sub) {
  if (!userId) return null;
  try {
    const { error } = await supabase.from("push_subscriptions").upsert({
      user_id: userId,
      endpoint: sub.endpoint,
      p256dh: sub.p256dh,
      auth: sub.auth,
      timezone: sub.timezone,
    }, { onConflict: "endpoint" });
    if (error) throw error;
    return true;
  } catch (e) {
    console.error("savePushSubscription failed:", e);
    toastError("Couldn't enable notifications — try again in a moment.");
    return false;
  }
}

export async function deletePushSubscriptionByEndpoint(endpoint) {
  try {
    const { error } = await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
    if (error) throw error;
  } catch (e) {
    console.error("deletePushSubscriptionByEndpoint failed:", e);
  }
}

/* ---------------------------------------------------------------
   User split selection — stores which Lifting Schedule split
   each user has chosen, so it persists across devices/sessions.
----------------------------------------------------------------*/

export async function getUserSplitId(userId) {
  if (!userId) return null;
  try {
    const { data, error } = await supabase.from("user_splits").select("split_id").eq("user_id", userId).maybeSingle();
    if (error) throw error;
    const splitId = data?.split_id || null;
    writeCache("splitId", userId, splitId);
    return splitId;
  } catch (e) {
    console.error("getUserSplitId failed, using cache:", e);
    return readCache("splitId", userId, null);
  }
}

export async function setUserSplitId(userId, splitId) {
  if (!userId) return;
  writeCache("splitId", userId, splitId);
  const startedOn = todayStr();
  writeCache("splitStartedOn", userId, startedOn);

  if (!isOnline()) {
    enqueueOp("setUserSplitId", [userId, splitId]);
    return;
  }
  try {
    const { error } = await supabase
      .from("user_splits")
      .upsert({ user_id: userId, split_id: splitId, split_started_on: startedOn }, { onConflict: "user_id" });
    if (error) throw error;
  } catch (e) {
    console.error("setUserSplitId failed, queuing for retry:", e);
    toastError("Couldn't save — we'll keep retrying in the background.");
    enqueueOp("setUserSplitId", [userId, splitId]);
  }
}

export async function getUserSplitStartedOn(userId) {
  if (!userId) return null;
  try {
    const { data, error } = await supabase.from("user_splits").select("split_started_on").eq("user_id", userId).maybeSingle();
    if (error) throw error;
    const startedOn = data?.split_started_on || null;
    writeCache("splitStartedOn", userId, startedOn);
    return startedOn;
  } catch (e) {
    console.error("getUserSplitStartedOn failed, using cache:", e);
    return readCache("splitStartedOn", userId, null);
  }
}

// ── Weak Point Day muscle-group choice ──────────────────────────────
// Exclusive to the "PPL + Weak Point Day" split — lets the user pick
// which muscle group(s) their bonus 4th day specializes in.
export async function getUserWeakPointGroups(userId) {
  if (!userId) return [];
  try {
    const { data, error } = await supabase.from("user_splits").select("weak_point_groups").eq("user_id", userId).maybeSingle();
    if (error) throw error;
    const groups = data?.weak_point_groups || [];
    writeCache("weakPointGroups", userId, groups);
    return groups;
  } catch (e) {
    console.error("getUserWeakPointGroups failed, using cache:", e);
    return readCache("weakPointGroups", userId, []);
  }
}

export async function setUserWeakPointGroups(userId, groups, splitId) {
  if (!userId) return;
  writeCache("weakPointGroups", userId, groups);

  // Includes split_id when the caller already knows it, so a row created
  // here doesn't unnecessarily leave it null — but doesn't require it,
  // since this can legitimately be called before a split's fully chosen.
  const payload = { user_id: userId, weak_point_groups: groups };
  if (splitId) payload.split_id = splitId;

  if (!isOnline()) {
    enqueueOp("setUserWeakPointGroups", [userId, groups, splitId]);
    return;
  }
  try {
    const { error } = await supabase
      .from("user_splits")
      .upsert(payload, { onConflict: "user_id" });
    if (error) throw error;
  } catch (e) {
    console.error("setUserWeakPointGroups failed, queuing for retry:", e);
    toastError("Couldn't save — we'll keep retrying in the background.");
    enqueueOp("setUserWeakPointGroups", [userId, groups, splitId]);
  }
}

/* ---------------------------------------------------------------
   Saved meal presets — a user's frequently-eaten meals/combos,
   saved by name so they can be added to the Food Log in one tap
   instead of re-entering the same macros every time.
----------------------------------------------------------------*/

function presetFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    calories: row.calories,
    protein: row.protein,
    carbs: row.carbs,
    fat: row.fat,
  };
}

export async function loadMealPresets(userId) {
  if (!userId) return [];
  try {
    const { data, error } = await supabase
      .from("meal_presets")
      .select("*")
      .eq("user_id", userId)
      .order("name");
    if (error) throw error;
    const presets = (data || []).map(presetFromRow);
    writeCache("mealPresets", userId, presets);
    return presets;
  } catch (e) {
    console.error("loadMealPresets failed, using cache:", e);
    return readCache("mealPresets", userId, []);
  }
}

export async function saveMealPreset(userId, preset) {
  if (!userId) return null;
  const row = {
    id: preset.id || newId(),
    user_id: userId,
    name: preset.name,
    calories: preset.calories || 0,
    protein: preset.protein || 0,
    carbs: preset.carbs || 0,
    fat: preset.fat || 0,
  };
  const optimistic = presetFromRow(row);

  const cached = readCache("mealPresets", userId, []);
  writeCache("mealPresets", userId, [...cached.filter((p) => p.id !== row.id), optimistic]);

  if (!isOnline()) {
    enqueueOp("saveMealPresetRaw", [row]);
    return optimistic;
  }
  try {
    const { error } = await supabase.from("meal_presets").upsert(row, { onConflict: "id" });
    if (error) throw error;
    return optimistic;
  } catch (e) {
    console.error("saveMealPreset failed, queuing for retry:", e);
    toastError("Couldn't save — we'll keep retrying in the background.");
    enqueueOp("saveMealPresetRaw", [row]);
    return optimistic;
  }
}

export async function deleteMealPreset(userId, id) {
  if (!userId) return;

  const cached = readCache("mealPresets", userId, []);
  writeCache("mealPresets", userId, cached.filter((p) => p.id !== id));

  if (!isOnline()) {
    enqueueOp("deleteMealPreset", [userId, id]);
    return;
  }
  try {
    const { error } = await supabase.from("meal_presets").delete().eq("user_id", userId).eq("id", id);
    if (error) throw error;
  } catch (e) {
    console.error("deleteMealPreset failed, queuing for retry:", e);
    toastError("Couldn't save — we'll keep retrying in the background.");
    enqueueOp("deleteMealPreset", [userId, id]);
  }
}

// ── Community food database ──────────────────────────────────────────
// A shared, cross-user food database — separate from meal_presets, which
// is personal to one user. Anyone knowledgeable about a food's real
// nutrition (or who scanned a barcode USDA didn't have) can contribute an
// entry here, and it becomes searchable for every user from then on.
// Stored per-100g, same normalized shape as USDA results, so it plugs
// into the existing search/scale UI without any special-casing.
function communityFoodFromRow(row) {
  return {
    id: `community:${row.id}`,
    rowId: row.id,
    name: row.name,
    brand: row.brand || null,
    source: "Community",
    cal100: row.cal100,
    protein100: row.protein100,
    carbs100: row.carbs100,
    fat100: row.fat100,
    servingG: row.serving_g || 100,
    servingLabel: row.serving_label || `${row.serving_g || 100} g`,
    image: null,
    gtinUpc: row.barcode || null,
  };
}

export async function searchCommunityFoods(query) {
  if (!query?.trim()) return [];
  try {
    const { data, error } = await supabase
      .from("community_foods")
      .select("*")
      .ilike("name", `%${query.trim()}%`)
      .order("use_count", { ascending: false })
      .limit(10);
    if (error) throw error;
    return (data || []).map(communityFoodFromRow);
  } catch (e) {
    console.error("searchCommunityFoods failed:", e);
    return [];
  }
}

export async function lookupCommunityFoodByBarcode(barcode) {
  if (!barcode) return null;
  try {
    const { data, error } = await supabase
      .from("community_foods")
      .select("*")
      .eq("barcode", barcode)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data ? communityFoodFromRow(data) : null;
  } catch (e) {
    console.error("lookupCommunityFoodByBarcode failed:", e);
    return null;
  }
}

// grams = the serving size the contributor's totals represent (e.g. 350
// for "350g plate"), used to back-calculate the per-100g values every
// other part of the food search stack expects.
export async function addCommunityFood({ name, brand, calories, protein, carbs, fat, grams, servingLabel, barcode, addedBy }) {
  if (!name?.trim()) return null;
  const g = Math.max(1, parseFloat(grams) || 100);
  const k = 100 / g;
  const row = {
    id: newId(),
    name: name.trim(),
    brand: brand?.trim() || null,
    cal100: Math.round((calories || 0) * k),
    protein100: Math.round((protein || 0) * k * 10) / 10,
    carbs100: Math.round((carbs || 0) * k * 10) / 10,
    fat100: Math.round((fat || 0) * k * 10) / 10,
    serving_g: g,
    serving_label: servingLabel?.trim() || null,
    barcode: barcode?.trim() || null,
    added_by: addedBy || null,
  };
  const optimistic = communityFoodFromRow(row);

  if (!isOnline()) {
    enqueueOp("addCommunityFoodRaw", [row]);
    return optimistic;
  }
  try {
    const { error } = await supabase.from("community_foods").insert(row);
    if (error) throw error;
    return optimistic;
  } catch (e) {
    console.error("addCommunityFood failed, queuing for retry:", e);
    toastError("Couldn't add to the shared database — we'll keep retrying in the background.");
    enqueueOp("addCommunityFoodRaw", [row]);
    return optimistic;
  }
}

export async function bumpCommunityFoodUseCount(rowId) {
  if (!rowId) return;
  try {
    const { data } = await supabase.from("community_foods").select("use_count").eq("id", rowId).maybeSingle();
    if (!data) return;
    await supabase.from("community_foods").update({ use_count: (data.use_count || 0) + 1 }).eq("id", rowId);
  } catch (e) {
    // Non-critical — just a popularity signal for sort order, never worth
    // retrying or surfacing an error to the user over.
    console.error("bumpCommunityFoodUseCount failed (non-critical):", e);
  }
}



function trainingSessionFromRow(row) {
  return { id: row.id, hostUserId: row.host_user_id, hostBlocks: row.host_blocks || [], status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
}
function trainingMemberFromRow(row) {
  return { id: row.id, sessionId: row.session_id, userId: row.user_id, overrides: row.overrides || {}, joinedAt: row.joined_at };
}

// Starts hosting — one open session per host at a time is the assumed
// usage (nothing stops a second one existing, but the UI only ever
// offers "Host a workout" from the no-active-session state, so this
// never needs to be defensive about it).
export async function createTrainingSession(hostUserId) {
  if (!hostUserId) return null;
  try {
    const { data, error } = await supabase.from("training_sessions").insert({ host_user_id: hostUserId, host_blocks: [], status: "active" }).select().single();
    if (error) throw error;
    return trainingSessionFromRow(data);
  } catch (e) {
    console.error("createTrainingSession failed:", e);
    toastError("Couldn't start a session — try again.");
    return null;
  }
}

// Pushes the host's current exercise queue to everyone synced. Called
// on every host-side blocks change (debounced by the caller), which is
// what makes following "automatic" rather than something a member has
// to manually pull — Realtime picks this row change up on every
// joined member's subscription. Not queued for offline retry: a host
// mid-workout with no connection has bigger problems than a missed
// broadcast, and retrying a STALE exercise queue after reconnecting
// would be actively wrong once they're several exercises further on.
export async function updateSessionHostBlocks(sessionId, blocks) {
  if (!sessionId) return;
  try {
    const { error } = await supabase.from("training_sessions").update({ host_blocks: blocks, updated_at: new Date().toISOString() }).eq("id", sessionId);
    if (error) throw error;
  } catch (e) {
    console.error("updateSessionHostBlocks failed:", e);
  }
}

export async function endTrainingSession(sessionId) {
  if (!sessionId) return;
  try {
    const { error } = await supabase.from("training_sessions").update({ status: "ended" }).eq("id", sessionId);
    if (error) throw error;
  } catch (e) {
    console.error("endTrainingSession failed:", e);
  }
}

// Sessions open to join right now — excludes the current user's own
// (can't join your own session; you're already hosting it) and
// anything already ended. Member count is fetched alongside so the
// join list can grey out anything already at the 4-total cap (host +
// 3) before someone taps in and gets rejected.
export async function listActiveTrainingSessions(excludeUserId) {
  try {
    const { data, error } = await supabase
      .from("training_sessions")
      .select("*, users:host_user_id(name), training_session_members(user_id)")
      .eq("status", "active")
      .neq("host_user_id", excludeUserId || "");
    if (error) throw error;
    return (data || []).map(row => ({
      ...trainingSessionFromRow(row),
      hostName: row.users?.name || "Someone",
      memberCount: (row.training_session_members || []).length,
    }));
  } catch (e) {
    console.error("listActiveTrainingSessions failed:", e);
    return [];
  }
}

export async function loadSessionMembers(sessionId) {
  if (!sessionId) return [];
  try {
    const { data, error } = await supabase
      .from("training_session_members")
      .select("*, users:user_id(name)")
      .eq("session_id", sessionId)
      .order("joined_at");
    if (error) throw error;
    return (data || []).map(row => ({ ...trainingMemberFromRow(row), name: row.users?.name || "Someone" }));
  } catch (e) {
    console.error("loadSessionMembers failed:", e);
    return [];
  }
}

// Caller is responsible for the 4-total cap check (read current
// members via loadSessionMembers first) — kept out of this function so
// the UI can show a clear "session's full" message before attempting
// the join, rather than this silently failing partway through.
export async function joinTrainingSession(sessionId, userId) {
  if (!sessionId || !userId) return null;
  try {
    const { data, error } = await supabase.from("training_session_members").insert({ session_id: sessionId, user_id: userId, overrides: {} }).select().single();
    if (error) throw error;
    return trainingMemberFromRow(data);
  } catch (e) {
    console.error("joinTrainingSession failed:", e);
    toastError("Couldn't join that session — try again.");
    return null;
  }
}

export async function leaveTrainingSession(sessionId, userId) {
  if (!sessionId || !userId) return;
  try {
    const { error } = await supabase.from("training_session_members").delete().eq("session_id", sessionId).eq("user_id", userId);
    if (error) throw error;
  } catch (e) {
    console.error("leaveTrainingSession failed:", e);
  }
}

// A member swapping ONE exercise slot away from the host's pick — the
// slot's index into host_blocks is the key, so it's a positional
// override ("exercise 3 of the 7"), not tied to the exercise NAME,
// which is what lets it survive the host later changing what's at
// OTHER indices without accidentally resyncing or double-desyncing
// this one.
export async function setMemberOverride(sessionId, userId, index, override) {
  if (!sessionId || !userId) return;
  try {
    // A client-side read-then-write here would race if two swaps
    // happen back to back (the second write's "read current overrides"
    // could read a stale snapshot from before the first write landed,
    // silently dropping it). The RPC does the jsonb merge/delete in one
    // atomic UPDATE on the DB side instead — no read step to race.
    const { error } = await supabase.rpc("set_training_member_override", {
      p_session_id: sessionId, p_user_id: userId, p_index: String(index), p_override: override,
    });
    if (error) throw error;
  } catch (e) {
    console.error("setMemberOverride failed:", e);
    toastError("Couldn't save that swap — try again.");
  }
}

// The host's "force sync" button — snaps every member fully back onto
// the host's list by wiping every member's overrides at once, rather
// than each member having to individually undo their own desyncs.
export async function forceResyncAllMembers(sessionId) {
  if (!sessionId) return;
  try {
    const { error } = await supabase.from("training_session_members").update({ overrides: {} }).eq("session_id", sessionId);
    if (error) throw error;
  } catch (e) {
    console.error("forceResyncAllMembers failed:", e);
    toastError("Couldn't resync everyone — try again.");
  }
}

export const offlineExecutors = {
  saveEntry: async (userId, date, entry) => {
    const { error } = await supabase.from("entries").upsert(entryToRow(userId, date, entry), { onConflict: "user_id,date" });
    if (error) throw error;
  },
  deleteEntry: async (userId, date) => {
    const { error } = await supabase.from("entries").delete().eq("user_id", userId).eq("date", date);
    if (error) throw error;
  },
  saveProfile: async (userId, profile) => {
    const { error } = await supabase.from("profiles").upsert(profileToRow(userId, profile), { onConflict: "user_id" });
    if (error) throw error;
  },
  renameUser: async (id, name) => {
    const { error } = await supabase.from("users").update({ name }).eq("id", id);
    if (error) throw error;
  },
  setUserAvatar: async (id, dataUrl) => {
    const { error } = await supabase.from("users").update({ avatar_data: dataUrl }).eq("id", id);
    if (error) throw error;
  },
  insertWorkoutSessionsRaw: async (rows) => {
    const { error } = await supabase.from("workout_sessions").insert(rows);
    if (error) throw error;
  },
  deleteWorkoutSession: async (userId, id) => {
    const { error } = await supabase.from("workout_sessions").delete().eq("user_id", userId).eq("id", id);
    if (error) throw error;
  },
  deleteWorkoutSessionsForDate: async (userId, date, splitId) => {
    const { error } = await supabase.from("workout_sessions").delete().eq("user_id", userId).eq("date", date).eq("split_id", splitId);
    if (error) throw error;
  },
  insertMaxAttemptRaw: async (row) => {
    const { error } = await supabase.from("max_attempts").insert(row);
    if (error) throw error;
  },
  deleteMaxAttempt: async (userId, id) => {
    const { error } = await supabase.from("max_attempts").delete().eq("user_id", userId).eq("id", id);
    if (error) throw error;
  },
  insertRehabLogRaw: async (row) => {
    const { error } = await supabase.from("rehab_logs").insert(row);
    if (error) throw error;
  },
  deleteRehabLog: async (userId, id) => {
    const { error } = await supabase.from("rehab_logs").delete().eq("user_id", userId).eq("id", id);
    if (error) throw error;
  },
  saveCustomDayPlanRaw: async (row) => {
    const { error } = await supabase.from("custom_day_plans").upsert(row, { onConflict: "user_id,date" });
    if (error) throw error;
  },
  saveCalorieOverrideRaw: async (row) => {
    const { error } = await supabase.from("calorie_overrides").upsert(row, { onConflict: "user_id,date" });
    if (error) throw error;
  },
  deleteCalorieOverride: async (userId, date) => {
    const { error } = await supabase.from("calorie_overrides").delete().eq("user_id", userId).eq("date", date);
    if (error) throw error;
  },
  deleteCustomDayPlan: async (userId, date) => {
    const { error } = await supabase.from("custom_day_plans").delete().eq("user_id", userId).eq("date", date);
    if (error) throw error;
  },
  markWorkoutAttendanceRaw: async (row) => {
    const { error } = await supabase.from("workout_attendance").upsert(row, { onConflict: "user_id,date" });
    if (error) throw error;
  },
  unmarkWorkoutAttendance: async (userId, date) => {
    const { error } = await supabase.from("workout_attendance").delete().eq("user_id", userId).eq("date", date);
    if (error) throw error;
  },
  saveCustomSplitTemplateRaw: async (row) => {
    const { error } = await supabase.from("custom_split_templates").insert(row);
    if (error) throw error;
  },
  deleteCustomSplitTemplate: async (userId, id) => {
    const { error } = await supabase.from("custom_split_templates").delete().eq("user_id", userId).eq("id", id);
    if (error) throw error;
  },
  setUserSplitId: async (userId, splitId) => {
    const { error } = await supabase.from("user_splits").upsert({ user_id: userId, split_id: splitId, split_started_on: todayStr() }, { onConflict: "user_id" });
    if (error) throw error;
  },
  setUserWeakPointGroups: async (userId, groups, splitId) => {
    const payload = { user_id: userId, weak_point_groups: groups };
    if (splitId) payload.split_id = splitId;
    const { error } = await supabase.from("user_splits").upsert(payload, { onConflict: "user_id" });
    if (error) throw error;
  },
  saveMealPresetRaw: async (row) => {
    const { error } = await supabase.from("meal_presets").upsert(row, { onConflict: "id" });
    if (error) throw error;
  },
  deleteMealPreset: async (userId, id) => {
    const { error } = await supabase.from("meal_presets").delete().eq("user_id", userId).eq("id", id);
    if (error) throw error;
  },
  addCommunityFoodRaw: async (row) => {
    const { error } = await supabase.from("community_foods").insert(row);
    if (error) throw error;
  },
  shareSplitTemplateRaw: async (row) => {
    const { error } = await supabase.from("split_shares").insert(row);
    if (error) throw error;
  },
  updateSplitShareStatus: async (shareId, status) => {
    const { error } = await supabase.from("split_shares").update({ status }).eq("id", shareId);
    if (error) throw error;
  },
};

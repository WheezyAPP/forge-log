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
  useAdaptiveBodyFat: false,
  showBodyFatPct: null,
  creatineAlreadySaturated: false,
  setCoverageTargets: null,
  // Opt-in: RPE/RIR-driven autoregulation layered on top of the
  // always-on percentage-based suggestion math. Off by default so
  // nobody's logging flow changes shape without them choosing it.
  dedicatedProgressiveOverload: false,
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
    useAdaptiveBodyFat: row.use_adaptive_body_fat ?? false,
    showBodyFatPct: row.show_body_fat_pct ?? null,
    creatineAlreadySaturated: row.creatine_already_saturated ?? false,
    setCoverageTargets: row.set_coverage_targets ?? null,
    dedicatedProgressiveOverload: row.dedicated_progressive_overload ?? false,
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
    use_adaptive_body_fat: profile.useAdaptiveBodyFat ?? false,
    show_body_fat_pct: profile.showBodyFatPct ?? null,
    creatine_already_saturated: profile.creatineAlreadySaturated ?? false,
    set_coverage_targets: profile.setCoverageTargets ?? null,
    dedicated_progressive_overload: profile.dedicatedProgressiveOverload ?? false,
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
};

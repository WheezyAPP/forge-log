// api/send-notifications.js — the notification scheduler. Meant to be
// hit on a timer (every 15-30 min) by an external scheduler, since
// Vercel's own Cron is capped at once/day on the Hobby plan — nowhere
// near what "every 2 hours" or "4am/10am" needs. This file doesn't care
// who calls it, only THAT the caller knows the shared secret below.
//
// Runs the water/weight/food rules for every subscribed device, using
// each person's own local time (captured at subscribe time) rather than
// a single server-wide clock — see zonedTimeToUtcMs / getLocalNow.
//
// Vercel auto-detects any file in /api as a serverless function; no
// extra config needed for that part.

import { createClient } from "@supabase/supabase-js";
import webpush from "web-push";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const NOTIFY_SECRET = process.env.NOTIFY_SECRET;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails("mailto:admin@forgelog.app", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// ---------- Timezone helpers ----------
// Standard vanilla-JS technique: naive UTC guess, see how Intl renders
// it in the target zone, measure the drift, correct once. Timezone
// offsets are piecewise-constant, so one correction pass is exact —
// verified directly against known offsets (America/New_York in both
// EDT and EST, America/Los_Angeles) before this went into the rule
// engine below.
function zonedTimeToUtcMs(dateStr, timeStr, timeZone) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const [h, m] = timeStr.split(":").map(Number);
  const naiveUtc = Date.UTC(y, mo - 1, d, h, m);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(naiveUtc)).map(p => [p.type, p.value]));
  const hour24 = parts.hour === "24" ? 0 : +parts.hour;
  const asUtcIfLocal = Date.UTC(+parts.year, +parts.month - 1, +parts.day, hour24, +parts.minute, +parts.second);
  return naiveUtc - (asUtcIfLocal - naiveUtc);
}

// "What's the date and time right now, from this person's chair" — the
// one thing every rule below actually needs to know first.
function getLocalNow(timeZone) {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(now).map(p => [p.type, p.value]));
  const hour24 = parts.hour === "24" ? 0 : +parts.hour;
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    hours: hour24,
    minutes: +parts.minute,
    nowMs: now.getTime(),
  };
}

// ---------- Food's "last logged" signal ----------
// Meal IDs are `${Date.now()}-${random}` (see addMeal in App.jsx) — that
// gives an exact per-meal timestamp without needing a schema change.
// Falls back to the row's updated_at for the "typed calories directly,
// skipped meal tracking" path, where there's no meal entry to read a
// timestamp from at all.
function getLastFoodLogMs(entry) {
  if (!entry) return null;
  const mealTimestamps = (entry.meals || [])
    .map(m => parseInt(String(m.id).split("-")[0], 10))
    .filter(t => !Number.isNaN(t));
  if (mealTimestamps.length) return Math.max(...mealTimestamps);
  if (entry.calories_consumed > 0) return new Date(entry.updated_at).getTime();
  return null;
}

function getLastWaterLogMs(entry, dateStr, timeZone) {
  const logs = entry?.water_logs || [];
  if (!logs.length) return null;
  const times = logs.filter(w => w.time).map(w => zonedTimeToUtcMs(dateStr, w.time, timeZone));
  return times.length ? Math.max(...times) : null;
}

// ---------- Sending ----------
async function sendToUser(supabase, subs, payload, category, userId, dateStr) {
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload)
      );
    } catch (e) {
      // 404/410 means the browser has permanently invalidated this
      // subscription (uninstalled, cleared data, revoked permission) —
      // clean it up so future runs stop wasting a call on it. Any other
      // error is logged but left alone; could be transient.
      if (e.statusCode === 404 || e.statusCode === 410) {
        await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
      } else {
        console.error(`push failed for ${sub.endpoint}:`, e.message);
      }
    }
  }
  await supabase.from("notification_log").upsert(
    { user_id: userId, category, date: dateStr, last_sent_at: new Date().toISOString() },
    { onConflict: "user_id,category,date" }
  );
}

export default async function handler(req, res) {
  const authHeader = req.headers.authorization;
  const querySecret = req.query?.secret;
  const authorized =
    (NOTIFY_SECRET && authHeader === `Bearer ${NOTIFY_SECRET}`) ||
    (NOTIFY_SECRET && querySecret === NOTIFY_SECRET);
  if (!authorized) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return res.status(500).json({ error: "VAPID keys not configured" });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const results = { checked: 0, sent: [] };

  const { data: subscriptions, error: subError } = await supabase.from("push_subscriptions").select("*");
  if (subError) return res.status(500).json({ error: subError.message });
  if (!subscriptions?.length) return res.status(200).json({ ...results, note: "no subscriptions" });

  const byUser = {};
  for (const sub of subscriptions) (byUser[sub.user_id] ||= []).push(sub);

  for (const [userId, subs] of Object.entries(byUser)) {
    results.checked++;
    const timeZone = subs[0].timezone || "UTC";
    const { dateStr, hours, minutes, nowMs } = getLocalNow(timeZone);
    const minutesSinceMidnight = hours * 60 + minutes;

    const [{ data: profile }, { data: entry }, { data: sentToday }] = await Promise.all([
      supabase.from("profiles").select("water_goal_oz").eq("user_id", userId).maybeSingle(),
      supabase.from("entries").select("*").eq("user_id", userId).eq("date", dateStr).maybeSingle(),
      supabase.from("notification_log").select("category, last_sent_at").eq("user_id", userId).eq("date", dateStr),
    ]);
    const sentMap = Object.fromEntries((sentToday || []).map(r => [r.category, new Date(r.last_sent_at).getTime()]));

    // ---- Weight: two one-shot checkpoints, 4am and 10am local time ----
    const weightLogged = entry?.weight != null;
    if (!weightLogged) {
      if (minutesSinceMidnight >= 4 * 60 && !sentMap.weight_4am) {
        await sendToUser(supabase, subs, {
          title: "Morning weigh-in",
          body: "First thing before you eat or drink anything — log today's weight.",
          url: "/?tab=weighin",
        }, "weight_4am", userId, dateStr);
        results.sent.push({ userId, category: "weight_4am" });
      } else if (minutesSinceMidnight >= 10 * 60 && !sentMap.weight_10am) {
        await sendToUser(supabase, subs, {
          title: "Still haven't logged your weight",
          body: "Quick one — log today's weight when you get a chance.",
          url: "/?tab=weighin",
        }, "weight_10am", userId, dateStr);
        results.sent.push({ userId, category: "weight_10am" });
      }
    }

    // ---- Water: repeating every 2h, 9am-10pm, stops once the goal's hit ----
    const waterGoalOz = profile?.water_goal_oz || 0;
    const waterTotalOz = (entry?.water_logs || []).reduce((s, w) => s + (parseFloat(w.amountOz) || 0), 0);
    const waterGoalMet = waterGoalOz > 0 && waterTotalOz >= waterGoalOz;
    if (!waterGoalMet && minutesSinceMidnight >= 9 * 60 && minutesSinceMidnight <= 22 * 60) {
      const windowStartMs = zonedTimeToUtcMs(dateStr, "09:00", timeZone);
      const lastLogMs = getLastWaterLogMs(entry, dateStr, timeZone) ?? windowStartMs;
      const lastSentMs = sentMap.water ?? 0;
      const referenceMs = Math.max(lastLogMs, lastSentMs);
      if (nowMs - referenceMs >= 2 * 60 * 60 * 1000) {
        await sendToUser(supabase, subs, {
          title: "Water check-in",
          body: waterTotalOz > 0 ? `${Math.round(waterTotalOz)} oz so far today — keep it going.` : "Nothing logged yet today — grab some water.",
          url: "/?tab=water",
        }, "water", userId, dateStr);
        results.sent.push({ userId, category: "water" });
      }
    }

    // ---- Food: repeating every 4h, 9am-9pm, stops at EITHER goal ----
    const calorieGoal = entry?.suggested_calories || 0;
    const caloriesConsumed = entry?.calories_consumed || 0;
    const calorieGoalMet = calorieGoal > 0 && caloriesConsumed >= calorieGoal;
    const { data: latestWeightRow } = await supabase
      .from("entries").select("weight").eq("user_id", userId).not("weight", "is", null)
      .order("date", { ascending: false }).limit(1).maybeSingle();
    // Mirrors computeStats' formula in App.jsx (proteinG = weightLbs * 1.0)
    // — deliberately not the full TDEE calculation, just this one trivial
    // line, to avoid a second, driftable copy of the real logic.
    const proteinGoal = (latestWeightRow?.weight || 0) * 1.0;
    const proteinConsumed = entry?.protein || 0;
    const proteinGoalMet = proteinGoal > 0 && proteinConsumed >= proteinGoal;
    if (!calorieGoalMet && !proteinGoalMet && minutesSinceMidnight >= 9 * 60 && minutesSinceMidnight <= 21 * 60) {
      const windowStartMs = zonedTimeToUtcMs(dateStr, "09:00", timeZone);
      const lastLogMs = getLastFoodLogMs(entry) ?? windowStartMs;
      const lastSentMs = sentMap.food ?? 0;
      const referenceMs = Math.max(lastLogMs, lastSentMs);
      if (nowMs - referenceMs >= 4 * 60 * 60 * 1000) {
        await sendToUser(supabase, subs, {
          title: "Food log check-in",
          body: caloriesConsumed > 0 ? "Been a few hours — anything since your last log?" : "Nothing logged yet today — worth a couple minutes.",
          url: "/?tab=food",
        }, "food", userId, dateStr);
        results.sent.push({ userId, category: "food" });
      }
    }
  }

  return res.status(200).json(results);
}

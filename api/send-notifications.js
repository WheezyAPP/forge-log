// api/send-notifications.js — the notification scheduler. Meant to be
// hit on a timer (every 15-30 min) by an external scheduler, since
// Vercel's own Cron is capped at once/day on the Hobby plan — nowhere
// near what a same-day 5-times-a-day schedule needs. This file doesn't
// care who calls it, only THAT the caller knows the shared secret below.
//
// Runs the water/weight/food rules for every subscribed device, using
// each person's own local time (captured at subscribe time) rather than
// a single server-wide clock — see getLocalNow. All three categories
// check in against the same shared timetable — see CHECK_TIMES below.
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

// ---------- Timezone helper ----------

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

// ---------- Shared check-in schedule ----------
// Replaces what used to be three separate systems — weight's one-shot
// 4am/10am checkpoints, water's rolling every-2h interval, food's
// rolling every-4h interval — with one shared timetable all three now
// check against: 7:30am, noon, 3pm, 6pm, 9pm local time.
const CHECK_TIMES = [
  { key: "0730", minutes: 7 * 60 + 30 },
  { key: "1200", minutes: 12 * 60 },
  { key: "1500", minutes: 15 * 60 },
  { key: "1800", minutes: 18 * 60 },
  { key: "2100", minutes: 21 * 60 },
];

// Which of the 5 slots "right now" belongs to — from that slot's own
// start up to the NEXT slot's start (or midnight, for the last slot of
// the day), null before 7:30am. Bounded per-slot windows, not a
// fallback chain, same philosophy the old weight checkpoints used: this
// picks the right slot for whatever time it actually is, independent of
// exactly when the external scheduler happens to poll, rather than
// risking a message landing late with a slot's stale copy attached.
function currentCheckSlot(minutesSinceMidnight) {
  for (let i = 0; i < CHECK_TIMES.length; i++) {
    const start = CHECK_TIMES[i].minutes;
    const end = i + 1 < CHECK_TIMES.length ? CHECK_TIMES[i + 1].minutes : 24 * 60;
    if (minutesSinceMidnight >= start && minutesSinceMidnight < end) return CHECK_TIMES[i].key;
  }
  return null;
}

// ---------- Sending ----------
async function sendToUser(supabase, subs, payload, category, userId, dateStr) {
  let anySucceeded = false;
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload)
      );
      anySucceeded = true;
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
  // Only mark today's category as "sent" if a push genuinely went
  // through to at least one device — previously this ran unconditionally,
  // so a transient failure (not a permanent 404/410) would still silence
  // that category for the rest of the day even though nobody was
  // actually notified. A day with zero working subscriptions correctly
  // gets no log entry, and the next scheduler run tries again.
  if (anySucceeded) {
    await supabase.from("notification_log").upsert(
      { user_id: userId, category, date: dateStr, last_sent_at: new Date().toISOString() },
      { onConflict: "user_id,category,date" }
    );
  }
  return anySucceeded;
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

  // Bypass mode — ?test=true sends a real notification to every
  // subscribed device immediately, skipping all the water/weight/food
  // rule checks entirely. Exists specifically for confirming the full
  // pipeline works (permission granted -> subscription saved -> this
  // endpoint -> push service -> service worker -> notification shown)
  // without needing to wait for a real trigger condition (goal not met,
  // enough time passed) to naturally line up.
  if (req.query?.test === "true") {
    for (const sub of subscriptions) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify({ title: "Test notification", body: "If you can see this, the whole pipeline works.", url: "/" })
        );
        results.sent.push({ userId: sub.user_id, category: "test" });
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) {
          await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
        }
        results.sent.push({ userId: sub.user_id, category: "test", error: e.message });
      }
    }
    return res.status(200).json({ ...results, mode: "test" });
  }

  const byUser = {};
  for (const sub of subscriptions) (byUser[sub.user_id] ||= []).push(sub);

  for (const [userId, subs] of Object.entries(byUser)) {
    results.checked++;
    const timeZone = subs[0].timezone || "UTC";
    const { dateStr, hours, minutes } = getLocalNow(timeZone);
    const minutesSinceMidnight = hours * 60 + minutes;

    const [{ data: profile }, { data: entry }, { data: sentToday }] = await Promise.all([
      supabase.from("profiles").select("water_goal_oz").eq("user_id", userId).maybeSingle(),
      supabase.from("entries").select("*").eq("user_id", userId).eq("date", dateStr).maybeSingle(),
      supabase.from("notification_log").select("category, last_sent_at").eq("user_id", userId).eq("date", dateStr),
    ]);
    const sentMap = Object.fromEntries((sentToday || []).map(r => [r.category, new Date(r.last_sent_at).getTime()]));
    const slot = currentCheckSlot(minutesSinceMidnight);

    if (slot) {
      // ---- Weight: was two one-shot messages at 4am/10am; now checks
      // in at every shared slot until logged, same "stop once done"
      // pattern water and food already used.
      const weightLogged = entry?.weight != null;
      if (!weightLogged && !sentMap[`weight_${slot}`]) {
        await sendToUser(supabase, subs, {
          title: "Weigh-in time",
          body: "Dude, log your weight.",
          url: "/?tab=weighin",
        }, `weight_${slot}`, userId, dateStr);
        results.sent.push({ userId, category: `weight_${slot}` });
      }

      // ---- Water: stops once the goal's hit. Gated on a goal actually
      // existing — someone who's never configured a water goal would
      // otherwise get nagged every slot forever with no way to ever
      // complete the day. No goal means nothing to measure progress
      // against, so no reminder at all, same as food/weight naturally
      // have nothing to check without their own reference points.
      const waterGoalOz = profile?.water_goal_oz || 0;
      const waterTotalOz = (entry?.water_logs || []).reduce((s, w) => s + (parseFloat(w.amountOz) || 0), 0);
      const waterGoalMet = waterTotalOz >= waterGoalOz;
      if (waterGoalOz > 0 && !waterGoalMet && !sentMap[`water_${slot}`]) {
        await sendToUser(supabase, subs, {
          title: "Water time",
          body: waterTotalOz > 0 ? `${Math.round(waterTotalOz)} oz down — keep sponging, dude.` : "Let's drink some water like a sponge, dude.",
          url: "/?tab=water",
        }, `water_${slot}`, userId, dateStr);
        results.sent.push({ userId, category: `water_${slot}` });
      }

      // ---- Food: stops at EITHER goal (calories or protein).
      const calorieGoal = entry?.suggested_calories || 0;
      const caloriesConsumed = entry?.calories_consumed || 0;
      const calorieGoalMet = calorieGoal > 0 && caloriesConsumed >= calorieGoal;
      // Only bother looking up the protein side if calories alone haven't
      // already settled it — previously this ran on every single check for
      // every user, including the common case where the calorie goal was
      // already hit and the block was about to be skipped anyway.
      let proteinGoalMet = false;
      if (!calorieGoalMet) {
        const { data: latestWeightRow } = await supabase
          .from("entries").select("weight").eq("user_id", userId).not("weight", "is", null)
          .order("date", { ascending: false }).limit(1).maybeSingle();
        // Mirrors computeStats' formula in App.jsx (proteinG = weightLbs * 1.0)
        // — deliberately not the full TDEE calculation, just this one trivial
        // line, to avoid a second, driftable copy of the real logic.
        const proteinGoal = (latestWeightRow?.weight || 0) * 1.0;
        const proteinConsumed = entry?.protein || 0;
        proteinGoalMet = proteinGoal > 0 && proteinConsumed >= proteinGoal;
      }
      if (!calorieGoalMet && !proteinGoalMet && !sentMap[`food_${slot}`]) {
        await sendToUser(supabase, subs, {
          title: "Food log check-in",
          body: caloriesConsumed > 0 ? "Been a few hours — anything since your last log?" : "Nothing logged yet today — worth a couple minutes.",
          url: "/?tab=food",
        }, `food_${slot}`, userId, dateStr);
        results.sent.push({ userId, category: `food_${slot}` });
      }
    }
  }

  return res.status(200).json(results);
}

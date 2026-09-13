// api/health-sync.js — receives a health-metrics sync from EITHER:
//   (a) a hand-built iOS Shortcuts automation (Find Health Samples ->
//       Get Contents of URL) sending one simple flat JSON object per
//       sync, e.g.:
//         { "date": "2026-09-11", "steps": 8500, "restingHeartRate": 58,
//           "sleepDurationMinutes": 412, "activeZoneMinutes": 34, "hrv": 45 }
//       This is the preferred, most reliable path — since the payload
//       is hand-built rather than coming from an undocumented
//       third-party app's format, there's no guessing involved: it
//       matches this endpoint exactly because whoever builds the
//       Shortcut types these exact field names into it.
//   (b) a Health Connect / HealthKit bridge app sending arrays of
//       individual timestamped records per data type (kept for
//       compatibility, in case that path gets revisited later):
//         { "steps": [{ "count": 1200, "startTime": "...", ... }], ... }
//
// Rather than Forge Log pulling live from the Google Health API
// itself: no Google Cloud project, no OAuth consent screen, no
// refresh-token handling on our end — just an endpoint that trusts
// whoever holds the per-user token in the URL, the same shared-secret
// style auth send-notifications.js already uses for its own caller.
//
// Vercel auto-detects any file in /api as a serverless function; no
// extra config needed for that part.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function dateKeyOf(isoString) {
  if (!isoString) return null;
  return isoString.slice(0, 10); // "2026-09-11T08:00:00Z" -> "2026-09-11"
}

// "What calendar date is it right now, from this person's chair."
//
// This used to be `new Date().toISOString().slice(0, 10)` — a UTC date.
// Vercel functions run in UTC, so for anyone behind UTC (all of the
// Americas) every sync after 8pm local was stamped with TOMORROW's
// date: 8 of the Shortcut's 48 daily slots, and specifically the ones
// carrying the day's final step count. Just after midnight the next
// sync would then upsert that same wrong key with a near-zero "steps
// today", silently wiping the evening. Net effect: every day's steps
// froze at their 7:30pm value.
//
// Same bug class already fixed twice on the client (see the
// computeAdaptiveTDEE and computeCreatineSaturation comments in
// App.jsx) — the fix there was to stop deriving dates from UTC, and
// it's the same fix here, just with the timezone coming from the
// database instead of the browser.
function localDateStrIn(timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date()).map(p => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// The device's IANA timezone, captured once at subscribe time — the
// same column api/send-notifications.js already reads to run each
// person's reminders on their own clock, reused here rather than
// introducing a second source of truth. Falls back to UTC only when
// there's genuinely nothing on file (someone who never enabled push
// notifications), which is no worse than the current behavior.
async function userTimeZone(supabase, userId) {
  try {
    const { data } = await supabase
      .from("push_subscriptions")
      .select("timezone")
      .eq("user_id", userId)
      .not("timezone", "is", null)
      .limit(1)
      .maybeSingle();
    return data?.timezone || "UTC";
  } catch {
    return "UTC";
  }
}

// Buckets an array of {..., time|startTime} records by calendar date,
// then reduces each bucket with the given strategy — "sum" (steps,
// sleep minutes) or "avg" (anything heart-rate-family, where a daily
// total would be meaningless).
function aggregateByDate(records, valueKey, timeKey, strategy) {
  const byDate = {};
  for (const r of records || []) {
    const t = r[timeKey] || r.time || r.startTime;
    const d = dateKeyOf(t);
    const v = parseFloat(r[valueKey]);
    if (!d || Number.isNaN(v)) continue;
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(v);
  }
  const out = {};
  for (const [d, values] of Object.entries(byDate)) {
    out[d] = strategy === "sum"
      ? values.reduce((a, b) => a + b, 0)
      : values.reduce((a, b) => a + b, 0) / values.length;
  }
  return out;
}

// Sleep records carry a start/end rather than a single value — minutes
// asleep per date is the duration between them, summed per date to
// handle multiple sessions/stages landing on the same night.
function aggregateSleepMinutes(records) {
  const byDate = {};
  for (const r of records || []) {
    const start = r.startTime, end = r.endTime;
    if (!start || !end) continue;
    const d = dateKeyOf(start);
    const mins = (new Date(end) - new Date(start)) / 60000;
    if (!d || Number.isNaN(mins) || mins <= 0) continue;
    byDate[d] = (byDate[d] || 0) + mins;
  }
  return byDate;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  const token = req.query?.token || req.body?.token;
  if (!token) {
    res.status(401).json({ error: "Missing token" });
    return;
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: tokenRow, error: tokenErr } = await supabase
    .from("health_sync_tokens")
    .select("user_id")
    .eq("token", token)
    .single();

  if (tokenErr || !tokenRow) {
    res.status(401).json({ error: "Invalid token" });
    return;
  }

  // If the sender didn't set Content-Type: application/json exactly
  // right (a real possibility from iOS Shortcuts' "Get Contents of
  // URL," which doesn't always mark it the way Vercel's automatic body
  // parser expects), req.body can arrive as a raw string instead of an
  // already-parsed object — parse it by hand rather than silently
  // treating every field as missing.
  let body = req.body || {};
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  console.log("health-sync received body:", JSON.stringify(body));

  // Normalize keys — a stray leading/trailing space on a field name
  // (a real, observed failure: Shortcuts' Key/Value body editor let a
  // trailing space slip into "restingHeartRate ") would otherwise
  // silently fail to match below, with no error at all — just a
  // dropped field.
  if (body && typeof body === "object") {
    const normalized = {};
    for (const [k, v] of Object.entries(body)) normalized[k.trim()] = v;
    body = normalized;
  }

  // Flat format (hand-built Shortcut): steps/restingHeartRate/etc as
  // simple fields — handled directly, no aggregation needed since it's
  // already one value per metric for that one day. "date" is optional:
  // if it's missing or didn't come through right (a real, observed
  // failure mode — the Shortcut's Formatted Date variable arriving as
  // an empty string), default to today's date server-side rather than
  // rejecting the whole sync over one fragile field. "Today" means the
  // sender's local today, not the server's — see localDateStrIn above
  // for why that distinction silently cost 4 hours of data a day.
  const isFlatFormat = ["steps", "restingHeartRate", "hrv", "activeZoneMinutes", "sleepDurationMinutes", "sleepScore"].some(k => body[k] != null);
  if (isFlatFormat) {
    const validDate = typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date.trim());
    const date = validDate
      ? body.date.trim()
      : localDateStrIn(await userTimeZone(supabase, tokenRow.user_id));
    const row = { user_id: tokenRow.user_id, date, synced_at: new Date().toISOString() };
    const fieldMap = {
      steps: "steps",
      restingHeartRate: "resting_heart_rate",
      hrv: "hrv",
      activeZoneMinutes: "active_zone_minutes",
      sleepDurationMinutes: "sleep_duration_minutes",
      sleepScore: "sleep_score",
    };
    for (const [inKey, col] of Object.entries(fieldMap)) {
      if (body[inKey] != null && !Number.isNaN(parseFloat(body[inKey]))) row[col] = parseFloat(body[inKey]);
    }
    const { error: upsertErr } = await supabase.from("health_metrics").upsert(row, { onConflict: "user_id,date" });
    if (upsertErr) {
      console.error("health-sync upsert (flat) failed:", upsertErr);
      res.status(500).json({ error: "Failed to save" });
      return;
    }
    res.status(200).json({ ok: true, date });
    return;
  }

  // Otherwise, fall through to the array-based bridge-app format.
  const stepsPerDate = aggregateByDate(body.steps, "count", "startTime", "sum");
  const restingHrPerDate = aggregateByDate(body.resting_heart_rate, "bpm", "time", "avg");
  const hrvPerDate = aggregateByDate(body.heart_rate_variability, "value", "time", "avg");
  const sleepMinutesPerDate = aggregateSleepMinutes(body.sleep);
  // Active Zone Minutes has no direct Health Connect/HealthKit
  // equivalent — approximated from exercise session durations if the
  // bridge app forwards them, otherwise just absent for that date.
  const activeMinutesPerDate = aggregateSleepMinutes(body.exercise);

  const allDates = new Set([
    ...Object.keys(stepsPerDate), ...Object.keys(restingHrPerDate),
    ...Object.keys(hrvPerDate), ...Object.keys(sleepMinutesPerDate),
    ...Object.keys(activeMinutesPerDate),
  ]);

  if (!allDates.size) {
    res.status(200).json({ ok: true, note: "No recognized data in payload" });
    return;
  }

  const rows = [...allDates].map(date => {
    const row = { user_id: tokenRow.user_id, date, synced_at: new Date().toISOString() };
    if (stepsPerDate[date] != null) row.steps = Math.round(stepsPerDate[date]);
    if (restingHrPerDate[date] != null) row.resting_heart_rate = Math.round(restingHrPerDate[date]);
    if (hrvPerDate[date] != null) row.hrv = Math.round(hrvPerDate[date]);
    if (sleepMinutesPerDate[date] != null) row.sleep_duration_minutes = Math.round(sleepMinutesPerDate[date]);
    if (activeMinutesPerDate[date] != null) row.active_zone_minutes = Math.round(activeMinutesPerDate[date]);
    return row;
  });

  const { error: upsertErr } = await supabase
    .from("health_metrics")
    .upsert(rows, { onConflict: "user_id,date" });

  if (upsertErr) {
    console.error("health-sync upsert failed:", upsertErr);
    res.status(500).json({ error: "Failed to save" });
    return;
  }

  res.status(200).json({ ok: true, datesUpdated: [...allDates] });
}


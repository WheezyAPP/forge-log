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

  // Flat format (hand-built Shortcut): has a top-level "date" string
  // and simple numeric fields — handled directly, no aggregation
  // needed since it's already one value per metric for that one day.
  if (typeof body.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.date.trim())) {
    body.date = body.date.trim();
    const row = { user_id: tokenRow.user_id, date: body.date, synced_at: new Date().toISOString() };
    const fieldMap = {
      steps: "steps",
      restingHeartRate: "resting_heart_rate",
      hrv: "hrv",
      activeZoneMinutes: "active_zone_minutes",
      sleepDurationMinutes: "sleep_duration_minutes",
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
    res.status(200).json({ ok: true, date: body.date });
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


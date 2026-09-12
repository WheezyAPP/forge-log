// api/health-sync.js — receives a health-metrics sync from a Health
// Connect / HealthKit bridge app (Health Webhook / HC Webhook, or
// anything sending a similar shape), rather than Forge Log pulling
// live from the Google Health API itself. That means no Google Cloud
// project, no OAuth consent screen, no refresh-token handling on our
// end — just an endpoint that trusts whoever holds the per-user token
// in the URL, the same shared-secret style auth send-notifications.js
// already uses for its own caller.
//
// Vercel auto-detects any file in /api as a serverless function; no
// extra config needed for that part.
//
// ACTUAL payload shape these bridge apps send (confirmed against the
// underlying Health Connect/HealthKit record conventions, NOT the
// flat single-value-per-day shape an earlier version of this file
// assumed): one JSON object per sync, arrays of individual timestamped
// records per data type, only the enabled types present at all:
//   {
//     "timestamp": "2026-09-11T08:00:00Z",
//     "steps": [ { "count": 1200, "startTime": "...", "endTime": "..." }, ... ],
//     "sleep": [ { "startTime": "...", "endTime": "...", "stage": "..." }, ... ],
//     "heart_rate": [ { "bpm": 72, "time": "..." }, ... ],
//     "resting_heart_rate": [ { "bpm": 58, "time": "..." }, ... ],
//     "heart_rate_variability": [ { "value": 45, "time": "..." }, ... ]
//   }
// Each array is aggregated down into ONE daily row per calendar date
// touched by that sync (a 48h lookback window can span two dates) —
// steps summed, sleep durations summed, heart-rate-family metrics
// averaged. No "sleep score" field: that's Fitbit's own proprietary
// number and doesn't exist in the underlying record types these apps
// read from, so it's never populated via this path.
//
// This is a best-informed reconstruction of the real format, not
// something tested against an actual device — the FIRST real sync is
// still worth checking against what actually lands in health_metrics,
// in case field names differ slightly from what's assumed here.

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

  const body = req.body || {};

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


// api/google-health-webhook.js — receives BOTH of Google's endpoint
// verification test requests (sent automatically the moment someone
// tries to register this URL as a subscriber) AND real data-change
// notifications afterward, once the subscriber is active.
//
// Auth model (confirmed against Google's current REST docs — NOT the
// ECDSA-signature scheme mentioned in some older reference pages,
// which appears to be a different/legacy mechanism): the subscriber
// registration includes a `secret` we chose ourselves (an
// Authorization header value, e.g. "Bearer <random-string>"). Google
// echoes that exact value back in the Authorization header on every
// request it sends here — verification tests AND real notifications
// alike — so checking it matches GOOGLE_HEALTH_WEBHOOK_SECRET is the
// entire auth check.
//
// Verification handshake Google runs BEFORE a subscriber can be
// created (see docs on projects.subscribers.create): two test POSTs,
// both must be handled correctly or subscriber creation fails outright:
//   1. WITH the correct Authorization header, body {"type":"verification"}
//      -> must respond 201 Created
//   2. WITHOUT any Authorization header
//      -> must respond 401 or 403
// Both cases fall out naturally from the same auth check below: valid
// secret + verification body -> 201; missing/wrong secret -> 401.
//
// Real notifications (per Google's own guide, e.g. the Workouts
// walkthrough): contain at minimum a healthUserId and the affected
// data type + time interval — NOT the actual data itself. This handler
// still needs to fetch the real values via the REST API using that
// person's stored token. Field names for the notification body itself
// (beyond healthUserId) are not fully confirmed against real traffic
// yet — the raw body is logged on every real notification specifically
// so the first live delivery can be inspected and this adjusted if
// needed, same as the bridge-app payload situation earlier today.

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const WEBHOOK_SECRET = process.env.GOOGLE_HEALTH_WEBHOOK_SECRET; // e.g. "Bearer <random-string>" — full Authorization header value, chosen by us at subscriber-creation time
const CLIENT_ID = process.env.GOOGLE_HEALTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_HEALTH_CLIENT_SECRET;

async function refreshAccessToken(refreshToken) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || "Token refresh failed");
  return data; // { access_token, expires_in, ... }
}

function dateKeyOf(isoString) {
  return isoString ? isoString.slice(0, 10) : null;
}

// Best-informed mapping from a Google Health data type name to how we
// pull a daily number out of its dataPoints response — NOT verified
// against real traffic yet. If the first live notification's logged
// data looks different from what this expects, this is the function
// to adjust.
async function fetchAndStoreDataType(supabase, accessToken, healthUserId, forgeLogUserId, dataType, startTime, endTime) {
  const url = `https://health.googleapis.com/v4/users/${healthUserId}/dataTypes/${dataType}/dataPoints?startTime=${encodeURIComponent(startTime)}&endTime=${encodeURIComponent(endTime)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (!res.ok) {
    console.error(`google-health-webhook: dataPoints fetch failed for ${dataType}:`, data);
    return;
  }

  const points = data.dataPoints || data.dataPoint || [];
  const byDate = {};
  for (const p of points) {
    const t = p.startTime || p.time;
    const d = dateKeyOf(t);
    if (!d) continue;
    let value = null;
    if (dataType === "steps") value = p.stepsCount ?? p.count ?? p.steps;
    else if (dataType === "dailyRestingHeartRate") value = p.bpm ?? p.value;
    else if (dataType === "dailyHeartRateVariability") value = p.rmssdMillis ?? p.value;
    else if (dataType === "activeZoneMinutes") value = p.minutes ?? p.value;
    else if (dataType === "sleep") {
      const start = p.startTime, end = p.endTime;
      if (start && end) value = (new Date(end) - new Date(start)) / 60000;
    }
    if (value == null || Number.isNaN(parseFloat(value))) continue;
    if (!byDate[d]) byDate[d] = [];
    byDate[d].push(parseFloat(value));
  }

  const col = {
    steps: "steps",
    dailyRestingHeartRate: "resting_heart_rate",
    dailyHeartRateVariability: "hrv",
    activeZoneMinutes: "active_zone_minutes",
    sleep: "sleep_duration_minutes",
  }[dataType];
  if (!col) return;

  const rows = Object.entries(byDate).map(([date, values]) => {
    const agg = dataType === "steps" || dataType === "activeZoneMinutes" || dataType === "sleep"
      ? values.reduce((a, b) => a + b, 0)
      : values.reduce((a, b) => a + b, 0) / values.length;
    return { user_id: forgeLogUserId, date, [col]: Math.round(agg), synced_at: new Date().toISOString() };
  });
  if (!rows.length) return;

  const { error } = await supabase.from("health_metrics").upsert(rows, { onConflict: "user_id,date" });
  if (error) console.error("google-health-webhook: health_metrics upsert failed:", error);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).end();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== WEBHOOK_SECRET) {
    // Covers verification test #2 (no/wrong auth -> 401) AND rejects
    // any real request that doesn't carry our exact secret.
    res.status(401).end();
    return;
  }

  const body = req.body || {};

  // Verification test #1 — correct auth, {"type":"verification"} body.
  if (body.type === "verification") {
    res.status(201).end();
    return;
  }

  // Real notification. Logged in full since the exact field names
  // beyond healthUserId aren't confirmed against live traffic yet.
  console.log("google-health-webhook: notification received:", JSON.stringify(body));

  const healthUserId = body.healthUserId || body.userId;
  if (!healthUserId) {
    res.status(200).end(); // acknowledge anyway — Google retries on non-2xx, and a malformed body isn't worth a retry storm
    return;
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: conn, error: connErr } = await supabase
    .from("google_health_connections")
    .select("*")
    .eq("health_user_id", healthUserId)
    .single();

  if (connErr || !conn) {
    console.error("google-health-webhook: no connection found for healthUserId", healthUserId);
    res.status(200).end();
    return;
  }

  // Refresh the access token if it's expired or close to it — a
  // notification is a rare, valuable event; not worth failing over an
  // access token that's a few minutes stale.
  let accessToken = conn.access_token;
  const expiresAt = conn.access_token_expires_at ? new Date(conn.access_token_expires_at).getTime() : 0;
  if (!accessToken || Date.now() > expiresAt - 60000) {
    try {
      const refreshed = await refreshAccessToken(conn.refresh_token);
      accessToken = refreshed.access_token;
      await supabase.from("google_health_connections").update({
        access_token: accessToken,
        access_token_expires_at: new Date(Date.now() + (refreshed.expires_in || 3599) * 1000).toISOString(),
      }).eq("user_id", conn.user_id);
    } catch (e) {
      console.error("google-health-webhook: token refresh failed:", e);
      res.status(200).end();
      return;
    }
  }

  const dataType = body.dataType || body.type;
  const startTime = body.interval?.startTime || body.startTime;
  const endTime = body.interval?.endTime || body.endTime || new Date().toISOString();

  if (dataType && startTime) {
    try {
      await fetchAndStoreDataType(supabase, accessToken, healthUserId, conn.user_id, dataType, startTime, endTime);
    } catch (e) {
      console.error("google-health-webhook: fetch/store failed:", e);
    }
  }

  res.status(200).end();
}

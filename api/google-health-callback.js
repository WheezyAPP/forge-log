// api/google-health-callback.js — Step 2 of the OAuth flow: Google
// redirects here after the person grants (or denies) consent, with a
// `code` (or an `error`) and the `state` value we set in
// google-health-auth.js (the Forge Log userId).
//
// This exchanges the code for tokens, then immediately calls
// GET /v4/users/me/identity to learn the person's healthUserId — the
// identifier every future webhook notification will carry, and the
// only way to know which Forge Log profile a given notification is
// actually about, since one subscriber (registered once, project-wide)
// serves every connected person.

import { createClient } from "@supabase/supabase-js";

const CLIENT_ID = process.env.GOOGLE_HEALTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_HEALTH_CLIENT_SECRET;
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  const { code, state: userId, error } = req.query || {};

  if (error) {
    res.status(400).send(`Google Health connection was not completed: ${error}`);
    return;
  }
  if (!code || !userId) {
    res.status(400).send("Missing code or state — start again from Settings.");
    return;
  }

  const redirectUri = `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}/api/google-health-callback`;

  // Exchange the one-time auth code for an access + refresh token pair.
  let tokens;
  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.access_token) {
      throw new Error(tokens.error_description || tokens.error || "Token exchange failed");
    }
  } catch (e) {
    console.error("google-health-callback token exchange failed:", e);
    res.status(500).send("Couldn't complete the connection — try again from Settings.");
    return;
  }

  // access_type=offline should always return a refresh_token on the
  // FIRST consent — but not on a re-consent that reuses an existing
  // grant unless prompt=consent forced a fresh one (which
  // google-health-auth.js always sets, specifically to guarantee this).
  if (!tokens.refresh_token) {
    console.error("google-health-callback: no refresh_token in response", tokens);
    res.status(500).send("Google didn't return a long-term token — try disconnecting this app from your Google Account's third-party access page, then reconnect.");
    return;
  }

  // Learn the healthUserId this access token belongs to.
  let healthUserId;
  try {
    const identityRes = await fetch("https://health.googleapis.com/v4/users/me/identity", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const identity = await identityRes.json();
    if (!identityRes.ok || !identity.healthUserId) {
      throw new Error(identity.error?.message || "No healthUserId in response");
    }
    healthUserId = identity.healthUserId;
  } catch (e) {
    console.error("google-health-callback identity lookup failed:", e);
    res.status(500).send("Connected, but couldn't confirm your Google Health identity — try again from Settings.");
    return;
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const expiresAt = new Date(Date.now() + (tokens.expires_in || 3599) * 1000).toISOString();

  const { error: upsertErr } = await supabase.from("google_health_connections").upsert({
    user_id: userId,
    health_user_id: healthUserId,
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    access_token_expires_at: expiresAt,
  }, { onConflict: "user_id" });

  if (upsertErr) {
    console.error("google-health-callback save failed:", upsertErr);
    res.status(500).send("Connected to Google, but couldn't save it on our end — try again.");
    return;
  }

  // Simple confirmation page rather than a JSON blob — this is a
  // browser redirect landing, a real person sees this, not code.
  res.setHeader("Content-Type", "text/html");
  res.status(200).send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:60px 20px;background:#1C1E26;color:#F3F5F9;">
      <h2>Google Health connected ✓</h2>
      <p>You can close this tab and go back to Forge Log.</p>
    </body></html>
  `);
}

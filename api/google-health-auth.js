// api/google-health-auth.js — Step 1 of the OAuth flow: redirects the
// person to Google's consent screen. GET /api/google-health-auth?userId=<forge log user id>
//
// state carries the Forge Log userId through the OAuth round-trip so
// the callback (google-health-callback.js) knows which profile to
// attach the resulting tokens to — Google's OAuth flow itself has no
// concept of "which Forge Log user," so this is the only way that
// context survives the redirect to Google and back.

const CLIENT_ID = process.env.GOOGLE_HEALTH_CLIENT_ID;

const SCOPES = [
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
  "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
  "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
  "https://www.googleapis.com/auth/googlehealth.profile.readonly",
].join(" ");

export default async function handler(req, res) {
  const userId = req.query?.userId;
  if (!userId) {
    res.status(400).json({ error: "userId query param is required" });
    return;
  }

  const redirectUri = `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}/api/google-health-callback`;

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline", // required to get a refresh_token back, not just a short-lived access token
    scope: SCOPES,
    state: userId,
    prompt: "consent", // forces the consent screen every time, so a returning user can grant a token again if theirs expired (Testing-mode tokens expire after 7 days)
  });

  res.redirect(302, `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
}

// api/register-google-health-subscriber.js — ONE-TIME setup action,
// not something end users ever touch. Registers Forge Log's webhook
// endpoint with Google so it actually starts receiving notifications —
// without this, google-health-webhook.js never gets called by anyone,
// no matter how many people connect their account.
//
// Requires a Google OAuth access token with the `cloud-platform` scope
// AND project-admin IAM rights (confirmed against Google's own REST
// reference — this is a project-management action, not a per-user
// health-data read, so it can't use the token from anyone's personal
// "Connect Google Health" flow, which only has the 4 narrow health
// scopes). Get one via Google's OAuth 2.0 Playground
// (https://developers.google.com/oauthplayground):
//   1. Gear icon (top right) -> check "Use your own OAuth credentials"
//      -> paste in GOOGLE_HEALTH_CLIENT_ID and GOOGLE_HEALTH_CLIENT_SECRET
//   2. In the scope list on the left, manually enter:
//      https://www.googleapis.com/auth/cloud-platform
//   3. Click "Authorize APIs", sign in with the SAME Google account
//      that owns the Cloud project (nifty-inn-508401-h8)
//   4. Click "Exchange authorization code for tokens"
//   5. Copy the resulting Access token
//
// Then call THIS endpoint once:
//   POST /api/register-google-health-subscriber?token=<access token from above>
//
// Safe to call more than once if something needs adjusting — Google
// rejects a duplicate subscriberId rather than creating a second one,
// and the error message says exactly that if it happens.

const PROJECT_ID = "nifty-inn-508401-h8";
const SUBSCRIBER_ID = "forge-log-main";
const WEBHOOK_SECRET = process.env.GOOGLE_HEALTH_WEBHOOK_SECRET;

const DATA_TYPES = [
  "steps",
  "sleep",
  "dailyRestingHeartRate",
  "dailyHeartRateVariability",
  "activeZoneMinutes",
];

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  const adminToken = req.query?.token;
  if (!adminToken) {
    res.status(400).json({ error: "Missing ?token= — see the comment at the top of this file for how to get one from OAuth Playground." });
    return;
  }

  const endpointUri = `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}/api/google-health-webhook`;

  const body = {
    endpointUri,
    endpointAuthorization: { secret: WEBHOOK_SECRET },
    subscriberConfigs: DATA_TYPES.map(dataType => ({
      dataType,
      subscriptionCreatePolicy: "AUTOMATIC",
    })),
  };

  try {
    const googleRes = await fetch(
      `https://health.googleapis.com/v4/projects/${PROJECT_ID}/subscribers?subscriberId=${SUBSCRIBER_ID}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }
    );
    const result = await googleRes.json();
    res.status(googleRes.status).json(result);
  } catch (e) {
    console.error("register-google-health-subscriber failed:", e);
    res.status(500).json({ error: String(e) });
  }
}

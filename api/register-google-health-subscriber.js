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
//      that owns the Cloud project
//   4. Click "Exchange authorization code for tokens"
//
// Then in Step 3, set the URI to this endpoint and hit Send — NO need
// to paste the token into the URL: OAuth Playground already attaches
// the Step-2 access token as an `Authorization: Bearer` header to
// every request automatically, and that's what this reads.
//
// Safe to call more than once if something needs adjusting — Google
// rejects a duplicate subscriberId rather than creating a second one,
// and the error message says exactly that if it happens.

const PROJECT_ID = "august-button-508403-a7";
const SUBSCRIBER_ID = "forge-log-main";
const WEBHOOK_SECRET = process.env.GOOGLE_HEALTH_WEBHOOK_SECRET;

const DATA_TYPES = [
  "steps",
  "sleep",
  "daily-resting-heart-rate",
  "daily-heart-rate-variability",
  "active-zone-minutes",
];

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }

  // Reads from the Authorization header — OAuth Playground already
  // attaches this automatically to every request it sends ("The OAuth
  // access token in Step 2 will be added to the Authorization header
  // of the request"), so nothing needs to be manually pasted into the
  // URL at all. Also sidesteps a real, easy-to-hit failure mode: a
  // long access token pasted into a query string can pick up subtle
  // corruption from URL encoding/decoding along the way, which
  // presents as exactly the kind of confusing "invalid credential"
  // error seen while debugging this.
  const authHeader = req.headers.authorization || "";
  const adminToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : (req.query?.token || null);
  if (!adminToken) {
    res.status(400).json({ error: "Missing Authorization: Bearer <token> header (or a ?token= fallback)." });
    return;
  }

  const endpointUri = `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}/api/google-health-webhook`;

  const body = {
    endpointUri,
    endpointAuthorization: { secret: WEBHOOK_SECRET },
    subscriberConfigs: [
      { dataTypes: DATA_TYPES, subscriptionCreatePolicy: "AUTOMATIC" },
    ],
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

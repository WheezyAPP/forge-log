# Push notifications — deployment setup

This covers the manual steps needed to turn on push notifications after
pulling this update. Everything in the codebase is done; these are the
account-side steps I can't do from my end (no access to your live
Vercel/Supabase accounts).

## 1. Environment variables

### Client-side (safe to expose — goes in Vercel's regular env vars, same place as your Supabase URL/anon key)

```
VITE_VAPID_PUBLIC_KEY=BGlRtIiEV9FDUITnVWL6dJkGkkZuF3nH81ZIVuFW5qRgHSn-Dqkfim1EPzOHSfhkYCAxuCI9wHZrqJxMDw_hYnk
```

### Server-side only (these power `api/send-notifications.js` — never prefix these with `VITE_`, or they'd get bundled into the client and exposed)

```
VAPID_PUBLIC_KEY=BGlRtIiEV9FDUITnVWL6dJkGkkZuF3nH81ZIVuFW5qRgHSn-Dqkfim1EPzOHSfhkYCAxuCI9wHZrqJxMDw_hYnk
VAPID_PRIVATE_KEY=Hch1jEqsaRVzgfycVIcFF2Mib1o9Bd-AV3B6ugmJDFQ
SUPABASE_SERVICE_ROLE_KEY=<get this from Supabase — see step 2>
NOTIFY_SECRET=<make up any long random string — see step 3>
```

Both VAPID values are a real, verified keypair (generated and cryptographically round-trip tested — signed with the private half, verified against the public half). You don't need to regenerate them, just paste these in as-is. The public key is genuinely safe to expose; the private key must stay server-only.

Set all of these in **Vercel → your project → Settings → Environment Variables**. After adding them, trigger a redeploy (env var changes don't apply retroactively to an already-built deployment).

## 2. Get your Supabase service role key

The notification scheduler needs to read every user's data (water/food/weight logs) and write to `notification_log` — that needs the *service role* key, not the anon key the rest of the app uses, since it bypasses row-level restrictions the way a trusted backend job should.

**Supabase dashboard → your project → Settings → API → Project API keys → `service_role` (the "secret" one, not "anon public").** Copy it into `SUPABASE_SERVICE_ROLE_KEY` above.

Treat this key like a password — it has full access to every table. It only ever needs to exist as a Vercel server-side env var, never in the client code, never committed anywhere.

## 3. Set a NOTIFY_SECRET

This is just a shared password between you and whatever calls `/api/send-notifications` — it stops a stranger from finding the URL and spamming your users (or running up your Supabase/push usage). Make up any long random string — a password generator's output works fine. Put the same value in the `NOTIFY_SECRET` env var and in the scheduler URL in step 4.

## 4. Set up something to actually call the endpoint on a schedule

**Don't use Vercel's built-in Cron for this** — confirmed it's capped at once-per-day on the Hobby (free) plan, with imprecise timing (fires sometime within the scheduled hour, not at a specific minute). None of the rules here (every 2 hours, specific 4am/10am checkpoints, every 4 hours) work with that.

The good news: the restriction is only on Vercel's *own* scheduler UI. `/api/send-notifications` is a completely normal HTTP endpoint — anything that can send a GET request on a timer can trigger it, Vercel plan doesn't matter.

**Recommended: [cron-job.org](https://cron-job.org)** — free, no card required, supports every-15-minutes schedules.

1. Create a free account.
2. Add a new cron job:
   - **URL:** `https://your-app.vercel.app/api/send-notifications?secret=YOUR_NOTIFY_SECRET`
   - **Schedule:** every 15 or 30 minutes
3. Save it.

That's the whole setup — no code on their end, just a URL to hit.

## 5. Testing it manually

You can trigger a check anytime by visiting (or curling) that same URL yourself:

```
https://your-app.vercel.app/api/send-notifications?secret=YOUR_NOTIFY_SECRET
```

It returns a small JSON summary — how many subscribed users it checked and which categories fired for each, e.g.:

```json
{ "checked": 2, "sent": [{ "userId": "...", "category": "water" }] }
```

If nothing fires, that's expected unless one of you is actually due for a reminder right now (goal not hit yet, enough time passed, etc.) — the rules are deliberately conservative about when they trigger.

## 6. Turning notifications on as a user

Once the above is deployed: open Forge Log → **Settings → Notifications** → toggle it on. The browser will ask for permission — accepting subscribes that specific device (phone and desktop count separately, each shows up as its own row in `push_subscriptions`). Not supported in every browser environment (works in Chrome/Edge everywhere, and Safari on iOS 16.4+ but only after adding the app to your home screen first) — the toggle explains this and disables itself where it won't work.

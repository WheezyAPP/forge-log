# Forge Log

A personal macro / calorie / workout tracker for you and a few friends. No
passwords — pick your name once, your device remembers you.

## 1. Set up Supabase (free tier)

1. Go to https://supabase.com → New project. Pick any name/region, set a DB
   password (you won't need it day-to-day — the app uses the API, not direct
   Postgres access).
2. Once the project is ready, open **SQL Editor → New query**, paste in the
   entire contents of `supabase_schema.sql` from this repo, and click **Run**.
   That single file creates every table the app uses — you do **not** need
   any of the `supabase_migration_v*.sql` files on a fresh install. (Those
   only exist for upgrading databases created on older versions — see
   [Upgrading](#upgrading-an-existing-database).)
3. Go to **Project Settings → API**. You'll need two values from this page:
   - **Project URL** (e.g. `https://abcdefgh.supabase.co`)
   - **anon public** key (a long JWT-looking string)
4. Optional: in the SQL editor, add your friends as users right away so the
   user-select screen isn't empty on first load:
   ```sql
   insert into users (name) values ('Alex'), ('Sam'), ('Jordan');
   ```
   (You can also just add users from the app itself — the user-select screen
   has an "Add a new user" box.)

## 2. Get a USDA FoodData Central API key (free, ~30 seconds)

The Food Log's **food search and barcode scanner** are powered by USDA
FoodData Central (~600k branded + generic foods with real nutrition-label
data). Without this key, search and scanning return no results — everything
else in the app still works.

Get a free key at https://fdc.nal.usda.gov/api-guide.html — you'll paste it
into `.env` locally (next step) and into Vercel when you deploy (step 5).

## 3. Run it locally

```bash
npm install
cp .env.example .env
# edit .env and fill in all three values:
#   VITE_SUPABASE_URL        → your Project URL (step 1)
#   VITE_SUPABASE_ANON_KEY   → your anon public key (step 1)
#   VITE_USDA_API_KEY        → your USDA key (step 2)
npm run dev
```

Open the printed localhost URL. You should see the user-select screen.

## 4. Push to GitHub

```bash
git init
git add .
git commit -m "Forge Log"
```
Create a new repo on GitHub (https://github.com/new), then:
```bash
git remote add origin https://github.com/YOUR-USERNAME/forge-log.git
git branch -M main
git push -u origin main
```

## 5. Deploy on Vercel (free tier)

1. Go to https://vercel.com → sign in with GitHub → **Add New… → Project**.
2. Import the `forge-log` repo you just pushed. Vercel auto-detects Vite —
   leave the build settings as default (`npm run build`, output `dist`).
3. Before deploying, expand **Environment Variables** and add all three:
   - `VITE_SUPABASE_URL` → your Project URL
   - `VITE_SUPABASE_ANON_KEY` → your anon public key
   - `VITE_USDA_API_KEY` → your USDA FoodData Central key
4. Click **Deploy**. After it finishes you'll get a URL like
   `forge-log-yourname.vercel.app` — that's the link to share with friends.
5. From now on, every `git push` to `main` auto-deploys a new version.

## 6. Add to iPhone home screen (PWA)

On your iPhone, open the Vercel URL in **Safari** (not Chrome — Add to Home
Screen for PWAs only works fully in Safari on iOS). Tap the **Share** icon →
**Add to Home Screen**. It'll launch full-screen like a native app and works
fine over cell data since it's just a normal website hitting Supabase's API.

## Features

- **Dashboard / Log Entry / Trends / Settings** — weight, calories, macros,
  and creatine, with TDEE / body-fat estimates, a goal weight, and mini-cut
  tracking.
- **Daily Food Log** — search the USDA database or **scan a barcode** to add
  foods, or enter meals manually. Save your regulars as one-tap **meal
  presets** ("Protein shake", "Usual breakfast"). Edit or delete anything,
  see a running daily total, and apply it to the day's Calories/Protein
  fields with one click.
- **Overload Log** — a progressive-overload workout tracker: log exercises
  with sets/reps/weight per date, organized by muscle group, with per-
  exercise history.
- **Daily Lifting Schedule** — pick a training split (including a
  PPL + Weak Point option where you choose which muscle groups your bonus
  day targets) and see what today's session is.
- **Weigh-In tab** — multiple weigh-ins per day, kept separate from the
  daily entry weight.
- **Measurements tab** — optional shoulders/arms/waist/legs tracking per
  date, with a measuring-technique hint under each field. Past entries can
  be edited or deleted from the history list.
- **Multi-user, no passwords** — pick a name on first open; it's remembered
  in `localStorage` on that device. Rename any time, and set a small profile
  photo (stored inline in the database — no Storage bucket needed).
- **Live save feedback** — a Saving.../Saved indicator on the Log Entry tab
  confirms writes as they happen, and a toast notification surfaces if a
  save genuinely fails (as opposed to just being queued for offline retry).
- **Offline reliability** — the app shell is precached by a service worker,
  so it loads with zero signal. Entries logged offline save locally, queue
  quietly, and sync automatically when you're back online; a small banner
  shows when you're offline or mid-sync, and a toast confirms once
  everything's synced back up.

## Upgrading an existing database

Fresh installs never need these — `supabase_schema.sql` already includes
everything. If your database was created on an older version, run **only the
migrations newer than what you've already applied**, in order. All of them
are idempotent (safe to re-run).

| Migration | Adds |
|---|---|
| `v2` | `meals`, `measurements` columns on `entries` (Food Log, Measurements) |
| `v3` | `workout_sessions` table (Overload Log) |
| `v4` | `user_splits` table (Daily Lifting Schedule) |
| `v5` | `weigh_ins` column on `entries` (Weigh-In tab) |
| `v6` | `weak_point_groups` on `user_splits` (PPL + Weak Point picks) |
| `v7` | `avatar_data` on `users` (profile photos) |
| `v8` | `goal_weight_lbs`, `mini_cut_started_on` on `profiles` |
| `v9` | `meal_presets` table (one-tap meal combos) |
| `v10` | UPDATE policy on `users` — **run this even if you're otherwise up to date**; without it, renaming users and saving avatars can be silently blocked by Row Level Security |
| `v11` | Drops the `NOT NULL` constraint on `user_splits.split_id` — **run this too**; without it, picking Weak Point Day muscle groups before (or without) a split otherwise on file causes every sync retry to fail forever with a "null value in column split_id" error |
| `v12` | Adds `goal_started_on` to `profiles` — a start date for regular lose/gain goals, same idea as `mini_cut_started_on` but generalized to every goal type |
| `v13` | Adds `adaptive_tdee` and `adaptive_tdee_set_on` to `profiles` — supports the data-driven maintenance-calorie estimate on the Trends tab |
| `v14` | Adds `community_foods` — a shared, cross-user food database anyone can contribute to from the Food Log, separate from personal meal presets |
| `v15` | Adds `split_id` to `workout_sessions` — fixes old sessions from a previous split being mislabeled as belonging to the currently selected split's schedule days |
| `v16` | Adds `split_started_on` to `user_splits` — fixes the attendance grade being unfairly harsh for weeks after switching splits, by clipping its 28-day window to start when the current split was actually locked in |
| `v17` | Adds `use_adaptive_body_fat` to `profiles` — an explicit opt-in for the formula + U.S. Navy circumference blend, same pattern as `adaptive_tdee` |
| `v18` | Adds `water_logs` to `entries` and `water_goal_oz` to `profiles` — water logging, same pattern as weigh-ins |
| `v19` | Adds `show_body_fat_pct` to `profiles` — a show/hide preference for body fat %, defaulting to hidden for female profiles and shown for male, since this can be sensitive information |
| `v20` | Adds `creatine_already_saturated` to `profiles` — lets someone already taking creatine consistently before joining mark themselves as already at steady-state |
| `v21` | Enables Supabase Realtime on `workout_sessions` — powers live cross-device sync in Partner Training mode |
| `v22` | Adds `sleep_hours` and `sleep_quality` to `entries` — sleep tracking |
| `v23` | Adds `set_coverage_targets` to `profiles` — customizable per-muscle weekly set targets (2 priority muscles at 20/wk, rest pickable 10–14) |

Housekeeping note: the legacy `workouts` column on `entries` (from the old
in-app training tab) is unused. It's harmless, or drop it with
`alter table entries drop column if exists workouts;`

## Notes on the multi-user model

- There's no password/auth. The user-select screen lists everyone in the
  `users` table; picking one stores that `user_id` in `localStorage` on your
  device. The "Switch user" link in the header clears it.
- This is intentionally open — anyone with the link can read or write any
  user's data. Fine for a small group of friends, not suitable if you ever
  need real privacy between users.
- Row Level Security is enabled on the tables but with permissive policies
  (see `supabase_schema.sql`), since the anon key needs full read/write
  access without a login step.

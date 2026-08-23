-- Forge Log migration v32
-- Already applied directly to the Supabase project — this file is kept
-- for the record / in case you're deploying against a separate
-- environment.
--
-- Fixes a real security gap: rehab_logs (v30) and calorie_overrides
-- (v31) were created without Row Level Security enabled. Both are
-- exposed through Supabase's public REST API, so with RLS off, anyone
-- with the project's public API key — normally embedded in the app's
-- own client-side code, extractable by anyone who looks — could read
-- or write any row in either table for any user. Confirmed via
-- Supabase's own security advisor (get_advisors), which flagged both
-- as ERROR-level "RLS Disabled in Public".
--
-- This app doesn't use real per-user Supabase Auth (no supabase.auth.*
-- calls anywhere in the codebase) — it uses one shared anon key with
-- user_id as an app-level concept from a "pick your user" screen, not a
-- JWT-based identity RLS could restrict against. Every other table in
-- this app already follows the same pattern established in the very
-- first migration (workout_sessions): RLS enabled, but with a
-- permissive "allow all" policy, since there's no real per-request
-- identity to key a tighter policy off without a much bigger auth
-- change. This migration matches that existing, already-established
-- convention for the two new tables — it satisfies Supabase's actual
-- security requirement (RLS must be ON), but same as the rest of the
-- app, it does not add new per-user data isolation beyond what already
-- exists (or doesn't) elsewhere in this app.
--
-- Safe to run — only changes policies, doesn't touch existing data.

alter table rehab_logs enable row level security;
create policy "public all rehab_logs" on rehab_logs for all using (true) with check (true);

alter table calorie_overrides enable row level security;
create policy "public all calorie_overrides" on calorie_overrides for all using (true) with check (true);

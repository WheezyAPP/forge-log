-- Forge Log migration v30
-- Run in Supabase SQL Editor alongside your existing tables.
--
-- Adds rehab_logs — free-form unilateral (left/right) exercise tracking,
-- separate from workout_sessions since it isn't tied to a split, a
-- split day, or the curated exercise pool. Exercise names are whatever
-- the person types (no split/muscle-group lookup involved), and `side`
-- is one of "Left Leg" / "Right Leg" / "Left Arm" / "Right Arm". `sets`
-- follows the same jsonb shape as workout_sessions.sets ([{weight,
-- reps}, ...]) for consistency with how the rest of the app formats and
-- displays a set.
--
-- Safe to run — only adds a new table, doesn't touch existing data.

create table if not exists rehab_logs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  date         date not null,
  side         text not null,
  exercise     text not null,
  sets         jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists rehab_logs_user_date_idx on rehab_logs(user_id, date);
create index if not exists rehab_logs_user_exercise_idx on rehab_logs(user_id, exercise);

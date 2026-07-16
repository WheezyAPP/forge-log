-- Run this in Supabase SQL Editor if your database already existed before
-- the Overload Log update (i.e. you've already run supabase_schema.sql and/or
-- supabase_migration_v2.sql before). This adds the new workout_sessions
-- table used by the separate progressive-overload tracker. Safe to run even
-- if it already exists.
--
-- Note: the old `workouts` column on `entries` (used by the previous
-- in-calorie-app training tab) is no longer read or written by the app.
-- It's harmless to leave in place, or you can drop it if you want a clean
-- table:
--   alter table entries drop column if exists workouts;

create table if not exists workout_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  date date not null,
  exercise text not null,
  muscle_group text not null,
  sets jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists workout_sessions_user_date_idx on workout_sessions (user_id, date);
create index if not exists workout_sessions_user_exercise_idx on workout_sessions (user_id, exercise);

alter table workout_sessions enable row level security;

drop policy if exists "public all workout_sessions" on workout_sessions;
create policy "public all workout_sessions" on workout_sessions for all using (true) with check (true);

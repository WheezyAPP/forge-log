-- Forge Log migration v25
-- Run in Supabase SQL Editor alongside your existing tables.
--
-- Adds max_attempts — dedicated tracking for Big 3 max attempts (barbell
-- squat, bench press, deadlift), separate from workout_sessions since a
-- max attempt is a single pass/fail lift, not a set of reps. The current
-- max for a lift is derived (highest weight among pass=true rows), not
-- stored redundantly.
--
-- Safe to run — only adds a new table, doesn't touch existing data.

create table if not exists max_attempts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  exercise     text not null,
  weight       numeric not null,
  date         date not null,
  pass         boolean not null,
  created_at   timestamptz not null default now()
);

create index if not exists max_attempts_user_id_idx on max_attempts(user_id);

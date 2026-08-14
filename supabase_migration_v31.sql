-- Forge Log migration v31
-- Run in Supabase SQL Editor alongside your existing tables.
--
-- Adds calorie_overrides — a per-date custom calorie goal that overrides
-- the normal formula-derived "Suggested calories" for that specific day.
-- One row per (user_id, date). Not yet exposed as its own Settings
-- toggle/editor UI — for now it's populated directly (e.g. via the
-- Supabase SQL editor or by Claude), with a proper in-app editor to
-- follow later. When no override exists for a date, everything falls
-- back to the existing profile-formula behavior exactly as before —
-- this is purely additive.
--
-- Safe to run — only adds a new table, doesn't touch existing data.

create table if not exists calorie_overrides (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  date         date not null,
  calories     numeric not null,
  created_at   timestamptz not null default now(),
  unique (user_id, date)
);

create index if not exists calorie_overrides_user_date_idx on calorie_overrides(user_id, date);

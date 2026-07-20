-- Forge Log migration v27
-- Run in Supabase SQL Editor alongside your existing tables.
--
-- Adds custom_day_plans — a one-time forward plan for specific calendar
-- dates, letting a user pre-build exactly what a day's workout should be
-- (day label, rest or not, and a specific exercise list) ahead of
-- walking into the gym. This OVERRIDES whatever the assigned split's
-- repeating pattern would normally show for that date, but only for the
-- dates actually planned — it's a temporary, date-specific override, not
-- a replacement split. One row per user per date (the unique constraint
-- makes re-planning a date a clean upsert, not a duplicate row).
--
-- Safe to run — only adds a new table, doesn't touch existing data.

create table if not exists custom_day_plans (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  date         date not null,
  day_type     text not null,
  is_rest      boolean not null default false,
  exercises    jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  unique (user_id, date)
);

create index if not exists custom_day_plans_user_id_idx on custom_day_plans(user_id);

-- Forge Log migration v28
-- Run in Supabase SQL Editor alongside your existing tables.
--
-- Adds custom_split_templates — a named, reusable version of a custom
-- day plan (see custom_day_plans, migration v27). Where custom_day_plans
-- is tied to specific calendar dates and gets consumed as those dates
-- pass, a template stores the same shape (7 day-slots, each with a day
-- name, rest flag, and exercise list) keyed by RELATIVE day position
-- (Day 1..7) instead of a real date — so it can be applied to any future
-- week without rebuilding it from scratch. Applying a template just
-- creates fresh custom_day_plans rows for whichever real dates it's
-- applied to; the template itself is untouched by that.
--
-- Safe to run — only adds a new table, doesn't touch existing data.

create table if not exists custom_split_templates (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  name         text not null,
  days         jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists custom_split_templates_user_id_idx on custom_split_templates(user_id);

-- Forge Log migration v18
-- Run in Supabase SQL Editor alongside your existing tables.
--
-- Adds water logging:
--   - entries.water_logs: per-day timestamped log entries, same jsonb
--     array pattern as weigh_ins (multiple entries per day, each with an
--     id/time/amount).
--   - profiles.water_goal_oz: a standing daily goal, same idea as
--     goal_weight_lbs. Nullable — the UI suggests a starting point
--     (roughly half your bodyweight in ounces, the most common baseline
--     formula) but doesn't force one until you've actually set it.
--
-- Safe to run — only adds columns, doesn't touch existing data.

alter table entries
  add column if not exists water_logs jsonb not null default '[]'::jsonb;

alter table profiles
  add column if not exists water_goal_oz numeric;

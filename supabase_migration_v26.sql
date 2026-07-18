-- Forge Log migration v26
-- Run in Supabase SQL Editor alongside your existing tables.
--
-- Adds max_day_goals to profiles — per-lift goal weight for an upcoming
-- max attempt on the Big 3 (squat/bench/deadlift), used to generate a
-- warm-up pyramid plan. Shape: { "squat": 335, "bench": 245, "deadlift": null }
-- Null/absent = no goal set for that lift.
--
-- Safe to run — only adds a column, doesn't touch existing data.

alter table profiles
  add column if not exists max_day_goals jsonb;

-- Forge Log migration v16
-- Run in Supabase SQL Editor alongside your existing tables.
--
-- Adds split_started_on to user_splits — records when the currently
-- selected split was actually locked in. Fixes a real follow-on issue
-- from v15's split_id fix: the attendance grade compares a flat trailing
-- 28-day window against whichever split is currently selected, so
-- switching splits made the grade unfairly harsh for weeks afterward —
-- it expected ~20 workout days under the new split when only 1-2 had
-- actually happened yet. Now the grading window clips to whichever is
-- later: 28 days ago, or the date you locked in the current split.
--
-- Safe to run — only adds a column, doesn't touch existing data.

alter table user_splits
  add column if not exists split_started_on date;

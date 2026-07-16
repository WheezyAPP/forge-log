-- Forge Log migration v17
-- Run in Supabase SQL Editor alongside your existing tables.
--
-- Adds use_adaptive_body_fat to profiles — an explicit opt-in for the
-- formula + U.S. Navy circumference blend, same pattern as adaptive_tdee.
-- Off by default: the blend is computed and shown for comparison in
-- Settings, but doesn't affect the Dashboard's body fat % until you
-- choose to turn it on.
--
-- Safe to run — only adds a column, doesn't touch existing data.

alter table profiles
  add column if not exists use_adaptive_body_fat boolean not null default false;

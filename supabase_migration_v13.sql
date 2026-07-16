-- Forge Log migration v13
-- Run in Supabase SQL Editor alongside your existing tables.
--
-- Adds adaptive_tdee and adaptive_tdee_set_on to profiles — supports the
-- data-driven maintenance-calorie estimate (energy-balance method: actual
-- weight change vs. actual calories logged over a window) that can
-- override the Mifflin-St Jeor formula estimate once you've got enough
-- logged history for it to be more accurate than a generic formula.
--
-- Safe to run — only adds columns, doesn't touch existing data.

alter table profiles
  add column if not exists adaptive_tdee numeric,
  add column if not exists adaptive_tdee_set_on date;

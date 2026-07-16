-- Forge Log migration v23
-- Run in Supabase SQL Editor alongside your existing tables.
--
-- Adds set_coverage_targets to profiles — per-muscle-group weekly set
-- targets for the Set Coverage tab. Shape:
--   { "priority": ["Chest", "Lats"], "targets": { "Biceps": 12, ... } }
-- Priority groups (max 2) aim for 20 sets/week; every other group gets
-- a user-chosen target between 10-14. Null = defaults (no priorities,
-- 10 for everything).
--
-- Safe to run — only adds a column, doesn't touch existing data.

alter table profiles
  add column if not exists set_coverage_targets jsonb;
